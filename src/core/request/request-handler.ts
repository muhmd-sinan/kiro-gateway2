import { GenerateAssistantResponseCommand } from '@aws/codewhisperer-streaming-client'
import type { AccountRepository } from '../../infrastructure/database/account-repository'
import type { HistoryOptions } from '../../infrastructure/transformers/history-builder'
import type { AccountManager } from '../../plugin/accounts'
import type { KiroConfig } from '../../plugin/config'
import { isPermanentError } from '../../plugin/health'
import * as logger from '../../plugin/logger'
import { transformToSdkRequest } from '../../plugin/request'
import { createSdkClient } from '../../plugin/sdk-client'
import { conversationIdFor, readSessionHeader } from '../../plugin/session-map'
import { syncFromKiroCli } from '../../plugin/sync/kiro-cli'
import type { KiroAuthDetails, ManagedAccount, SdkPreparedRequest } from '../../plugin/types'
import { AccountSelector } from '../account/account-selector'
import { UsageTracker } from '../account/usage-tracker'
import { TokenRefresher } from '../auth/token-refresher'
import { ErrorHandler } from './error-handler'
import { ResponseHandler } from './response-handler'
import { RetryStrategy } from './retry-strategy'

type ToastFunction = (message: string, variant: 'info' | 'warning' | 'success' | 'error') => void

/** Where the time before the first byte went, for the proxy's timing log. */
export interface RequestTiming {
  /** Waiting for a concurrency slot. */
  queueMs: number
  /** Slot acquired → Kiro's response started (account pick, refresh, retries, TTFB). */
  responseStartMs: number
}

const KIRO_API_PATTERN = /^(https?:\/\/)?q\.[a-z0-9-]+\.amazonaws\.com/
const REAUTH_FAILURE_COOLDOWN_MS = 60000

/**
 * Upstream failure that already has a meaningful HTTP status.
 *
 * Carries the status and an optional machine code so each wire format can build
 * its own error envelope (OpenAI `error.code` vs Anthropic `error.type`) without
 * string-matching on the message.
 */
export class KiroRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string
  ) {
    super(message)
    this.name = 'KiroRequestError'
  }
}

export class RequestHandler {
  private accountSelector: AccountSelector
  private tokenRefresher: TokenRefresher
  private errorHandler: ErrorHandler
  private responseHandler: ResponseHandler
  private usageTracker: UsageTracker
  private retryStrategy: RetryStrategy
  private reauthInFlight: Promise<boolean> | null = null
  private lastFailedReauthAt = 0
  // Shared across every RequestHandler in the process, so the OpenCode plugin and
  // the proxy cannot each open their own allowance against the same account.
  private static inFlight = 0
  private static waiters: Array<() => void> = []

  constructor(
    private accountManager: AccountManager,
    private config: KiroConfig,
    private repository: AccountRepository,
    private client?: any
  ) {
    this.accountSelector = new AccountSelector(accountManager, config, syncFromKiroCli, repository)
    this.tokenRefresher = new TokenRefresher(config, accountManager, syncFromKiroCli, repository)
    this.errorHandler = new ErrorHandler(config, accountManager, repository)
    this.responseHandler = new ResponseHandler()
    this.usageTracker = new UsageTracker(config, accountManager, repository)
    this.retryStrategy = new RetryStrategy(config)
  }

  async handle(input: any, init: any, showToast: ToastFunction): Promise<Response> {
    const url = typeof input === 'string' ? input : input.url
    logger.log('fetch hook', url)

    if (!KIRO_API_PATTERN.test(url)) {
      return fetch(input, init)
    }

    return this.enqueueKiroRequest(() => this.handleKiroRequest(url, init, showToast))
  }

  /**
   * Run a Kiro request under a process-wide concurrency limit.
   *
   * This used to be a strict mutex: every request awaited the previous one, so
   * Claude Code's background calls (session titles, classifiers) and its parallel
   * subagents each paid the full time-to-first-token of whatever happened to be
   * ahead of them. On a reasoning model that is seconds of dead wait per call for
   * work that had no reason to be ordered.
   *
   * The limit still exists because unbounded concurrency was the main source of
   * 429 storms, but at `max_concurrent_requests` instead of 1. Waiters are woken
   * in arrival order, and the slot is released in `finally` so a thrown request
   * cannot strand it.
   */
  private async enqueueKiroRequest<T>(run: () => Promise<T>): Promise<T> {
    const limit = this.config.max_concurrent_requests ?? 4

    if (RequestHandler.inFlight >= limit) {
      await new Promise<void>((resolve) => RequestHandler.waiters.push(resolve))
    }
    RequestHandler.inFlight++

    try {
      return await run()
    } finally {
      RequestHandler.inFlight--
      RequestHandler.waiters.shift()?.()
    }
  }

  private async handleKiroRequest(
    url: string,
    init: any,
    showToast: ToastFunction
  ): Promise<Response> {
    const body = init?.body ? JSON.parse(init.body) : {}
    const model = this.extractModel(url) || body.model || 'claude-sonnet-4-5'

    let result: { sdkResponse: any; sdkPrep: SdkPreparedRequest }
    try {
      result = await this.executeWithRetry(
        body,
        model,
        conversationIdFor(readSessionHeader(init)),
        showToast
      )
    } catch (e) {
      // OpenCode's fetch hook expects a Response, so recoverable upstream errors
      // are rendered into an OpenAI error body rather than thrown. Anything
      // without a status still propagates as a thrown error.
      if (e instanceof KiroRequestError && e.code) {
        return new Response(
          JSON.stringify({
            error: { message: e.message, type: 'invalid_request_error', code: e.code }
          }),
          { status: e.status, headers: { 'Content-Type': 'application/json' } }
        )
      }
      throw e
    }

    return await this.responseHandler.handleSdkSuccess(
      result.sdkResponse,
      model,
      result.sdkPrep.conversationId,
      result.sdkPrep.streaming,
      result.sdkPrep.toolNameMap
    )
  }

  /**
   * Run one Kiro request through account selection, token refresh, and the full
   * retry ladder, returning the raw SDK response.
   *
   * Callers own response encoding. The OpenCode plugin re-encodes as OpenAI
   * chunks via ResponseHandler; the standalone proxy server picks OpenAI or
   * Anthropic per client. Keeping the encoding out of here is what lets one
   * account pool and one retry policy serve every wire format.
   *
   * Bounded by the shared concurrency limit (see enqueueKiroRequest). Note the
   * slot is held only until Kiro's response *starts*: the caller consumes the
   * stream afterwards, outside the limit. So `max_concurrent_requests` caps how
   * many requests are being opened at once — which is what drives 429s — not how
   * many streams are open.
   */
  async execute(
    body: any,
    model: string,
    conversationId: string,
    showToast: ToastFunction,
    historyOptions?: HistoryOptions
  ): Promise<{ sdkResponse: any; sdkPrep: SdkPreparedRequest; timing: RequestTiming }> {
    const queuedAt = Date.now()
    let startedAt = queuedAt
    const result = await this.enqueueKiroRequest(() => {
      startedAt = Date.now()
      return this.executeWithRetry(body, model, conversationId, showToast, historyOptions)
    })
    return {
      ...result,
      timing: { queueMs: startedAt - queuedAt, responseStartMs: Date.now() - startedAt }
    }
  }

  private async executeWithRetry(
    body: any,
    model: string,
    conversationId: string,
    showToast: ToastFunction,
    historyOptions?: HistoryOptions
  ): Promise<{ sdkResponse: any; sdkPrep: SdkPreparedRequest }> {
    const think =
      model.endsWith('-thinking') ||
      !!body?.providerOptions?.thinkingConfig ||
      !!body?.thinkingConfig ||
      // Anthropic Messages API shape, as sent by Claude Code.
      body?.thinking?.type === 'enabled' ||
      body?.thinking?.type === 'adaptive'
    const budget =
      body?.providerOptions?.thinkingConfig?.thinkingBudget ||
      body?.thinkingConfig?.thinkingBudget ||
      body?.thinkingConfig?.budget_tokens ||
      body?.thinking?.budget_tokens ||
      20000

    let retry = 0
    let bearerRetried = false
    let consecutiveNullAccounts = 0
    const retryContext = this.retryStrategy.createContext()

    while (true) {
      const check = this.retryStrategy.shouldContinue(retryContext)
      if (!check.canContinue) {
        throw new Error(check.error)
      }

      if (this.allAccountsPermanentlyUnhealthy()) {
        const reauthed = await this.triggerReauth(showToast)
        if (!reauthed) {
          throw new Error('All accounts are permanently unhealthy. Please re-authenticate.')
        }
        continue
      }

      let acc = await this.accountSelector.selectHealthyAccount(showToast).catch(async (e) => {
        if (e instanceof Error && e.message.includes('reauth required')) {
          const reauthed = await this.triggerReauth(showToast)
          if (!reauthed)
            throw new Error('All accounts are unhealthy or rate-limited. Please re-authenticate.')
          return null
        }
        throw e
      })
      if (!acc) {
        consecutiveNullAccounts++
        if (consecutiveNullAccounts >= 3) {
          throw new Error('No healthy Kiro account. Sign in to Kiro IDE or run kiro-cli login.')
        }
        const backoffDelay = Math.min(1000 * Math.pow(2, consecutiveNullAccounts - 1), 10000)
        await this.sleep(backoffDelay)
        continue
      }

      consecutiveNullAccounts = 0
      const auth = this.accountManager.toAuthDetails(acc)

      const tokenResult = await this.tokenRefresher.refreshIfNeeded(acc, auth, showToast)
      if (tokenResult.shouldContinue) {
        acc = tokenResult.account
        await this.sleep(500)
        continue
      }

      const sdkPrep = this.prepareSdkRequest(
        body,
        model,
        auth,
        think,
        budget,
        showToast,
        conversationId,
        historyOptions
      )

      const apiTimestamp = this.config.enable_log_api_request ? logger.getTimestamp() : null
      if (apiTimestamp) {
        this.logSdkRequest(sdkPrep, acc, apiTimestamp)
      }
      try {
        const client = createSdkClient(auth, sdkPrep.region, sdkPrep.reasoningFields)
        const command = new GenerateAssistantResponseCommand({
          conversationState: sdkPrep.conversationState as any,
          profileArn: sdkPrep.profileArn
        })

        const sdkResponse = await client.send(command)

        if (apiTimestamp) {
          this.logSdkResponse(sdkPrep, apiTimestamp)
        }

        this.handleSuccessfulRequest(acc)
        this.usageTracker.syncUsage(acc, auth)

        return { sdkResponse, sdkPrep }
      } catch (e: any) {
        const httpStatus = e?.$metadata?.httpStatusCode

        if (httpStatus && apiTimestamp) {
          this.logSdkError(sdkPrep, e, acc, apiTimestamp)
        }

        if (httpStatus === 403 && !bearerRetried) {
          const msg = e?.message || ''
          if (
            msg.includes('bearer token included in the request is invalid') ||
            msg.includes('The bearer token included in the request is invalid')
          ) {
            bearerRetried = true
            logger.warn('403 bearer invalid on first attempt, forcing token refresh and retrying')
            await this.tokenRefresher.forceRefresh(acc, this.accountManager.toAuthDetails(acc))
            continue
          }
        }

        if (httpStatus) {
          const mockResponse = new Response(
            JSON.stringify({ message: e.message, __type: e.name }),
            {
              status: httpStatus,
              statusText: e.name || 'Error',
              headers: { 'Content-Type': 'application/json' }
            }
          )

          const errorResult = await this.errorHandler.handle(
            e,
            mockResponse,
            acc,
            { retry, bearerRetried },
            showToast
          )

          if (errorResult.shouldRetry) {
            if (errorResult.newContext) {
              retry = errorResult.newContext.retry
              bearerRetried = errorResult.newContext.bearerRetried ?? bearerRetried
            }
            if (errorResult.forceRefresh) {
              await this.tokenRefresher.forceRefresh(acc, this.accountManager.toAuthDetails(acc))
            }
            if (errorResult.switchAccount) {
              continue
            }
            continue
          }

          const errMsg = e?.message || `Kiro Error: ${httpStatus}`
          if (/input is too long/i.test(errMsg)) {
            // Surfaced as a typed error so each wire format can render it in its
            // own error envelope. The message wording matters: Claude Code keys
            // its auto-compaction on recognizing a context-overflow error.
            throw new KiroRequestError(
              'input is too long for requested model',
              400,
              'context_length_exceeded'
            )
          }
          throw new KiroRequestError(`Kiro Error: ${httpStatus}`, httpStatus)
        }

        const networkResult = await this.errorHandler.handleNetworkError(e, { retry }, showToast)

        if (networkResult.shouldRetry) {
          if (networkResult.newContext) {
            retry = networkResult.newContext.retry
          }
          continue
        }

        throw e
      }
    }
  }

  private extractModel(url: string): string | null {
    return url.match(/models\/([^/:]+)/)?.[1] || null
  }

  private prepareSdkRequest(
    body: any,
    model: string,
    auth: KiroAuthDetails,
    think: boolean,
    budget: number,
    showToast?: (message: string, variant: 'info' | 'warning' | 'success' | 'error') => void,
    conversationId?: string,
    historyOptions?: HistoryOptions
  ): SdkPreparedRequest {
    return transformToSdkRequest(
      body,
      model,
      auth,
      think,
      budget,
      showToast,
      {
        effort: this.config.effort,
        autoEffortMapping: this.config.auto_effort_mapping
      },
      conversationId,
      historyOptions
    )
  }

  private handleSuccessfulRequest(acc: ManagedAccount): void {
    if (acc.failCount && acc.failCount > 0) {
      if (!isPermanentError(acc.unhealthyReason)) {
        acc.failCount = 0
        acc.isHealthy = true
        delete acc.unhealthyReason
        delete acc.recoveryTime
        this.repository.save(acc).catch(() => {})
      }
    }
  }

  private logSdkRequest(prep: SdkPreparedRequest, acc: ManagedAccount, timestamp: string): void {
    // Mirrors what the sdk-client middleware injects, so logs reflect the wire body.
    const additionalModelRequestFields = prep.reasoningFields

    logger.logApiRequest(
      {
        url: `https://q.${prep.region}.amazonaws.com/generateAssistantResponse`,
        method: 'POST',
        headers: { 'x-amzn-kiro-agent-mode': 'vibe' },
        body: {
          conversationState: {
            chatTriggerType: prep.conversationState.chatTriggerType,
            conversationId: prep.conversationState.conversationId,
            historyLength: (prep.conversationState as any).history?.length || 0,
            currentMessage: prep.conversationState.currentMessage
          },
          profileArn: prep.profileArn,
          ...(additionalModelRequestFields ? { additionalModelRequestFields } : {})
        },
        conversationId: prep.conversationId,
        model: prep.effectiveModel,
        email: acc.email
      },
      timestamp
    )
  }

  private logSdkResponse(prep: SdkPreparedRequest, timestamp: string): void {
    logger.logApiResponse(
      {
        status: 200,
        statusText: 'OK',
        headers: {},
        conversationId: prep.conversationId,
        model: prep.effectiveModel
      },
      timestamp
    )
  }

  private logSdkError(
    prep: SdkPreparedRequest,
    error: any,
    acc: ManagedAccount,
    apiTimestamp: string
  ): void {
    const status = error?.$metadata?.httpStatusCode || 0
    const rData = {
      status,
      statusText: error?.name || 'Error',
      headers: {},
      error: `Kiro Error: ${status} - ${error?.message || 'Unknown'}`,
      conversationId: prep.conversationId,
      model: prep.effectiveModel
    }
    if (!this.config.enable_log_api_request) {
      logger.logApiError(
        {
          url: `https://q.${prep.region}.amazonaws.com/generateAssistantResponse`,
          method: 'POST',
          headers: {},
          body: null,
          conversationId: prep.conversationId,
          model: prep.effectiveModel,
          email: acc.email
        },
        rData,
        logger.getTimestamp()
      )
    } else {
      logger.logApiResponse(rData, apiTimestamp)
    }
  }

  private async triggerReauth(showToast: ToastFunction): Promise<boolean> {
    if (!this.client) return false

    const cooldownRemaining = REAUTH_FAILURE_COOLDOWN_MS - (Date.now() - this.lastFailedReauthAt)
    if (cooldownRemaining > 0) {
      showToast(
        'Recent re-authentication failed. Please complete authentication manually.',
        'error'
      )
      return false
    }

    if (this.reauthInFlight) {
      return this.reauthInFlight
    }

    this.reauthInFlight = this.performReauth(showToast)
    const success = await this.reauthInFlight.finally(() => {
      this.reauthInFlight = null
    })
    if (!success) this.lastFailedReauthAt = Date.now()
    return success
  }

  private async performReauth(showToast: ToastFunction): Promise<boolean> {
    try {
      showToast('Session expired. Re-authenticating...', 'warning')
      await this.client.provider.oauth.authorize({
        path: { id: 'kiro' },
        body: { method: 0 }
      })

      await this.client.provider.oauth.callback({
        path: { id: 'kiro' },
        body: { method: 0 }
      })

      this.repository.invalidateCache()
      const accounts = await this.repository.findAll()
      for (const acc of accounts) {
        this.accountManager.addAccount(acc)
      }

      if (!this.hasUsableAccount(accounts)) {
        logger.warn('Re-auth completed but no usable Kiro account was found')
        showToast('Re-authentication completed but no usable Kiro account was found.', 'error')
        return false
      }

      showToast('Re-authentication successful.', 'success')
      return true
    } catch (e) {
      logger.error('Re-auth failed', e instanceof Error ? e : new Error(String(e)))
      return false
    }
  }

  private hasUsableAccount(accounts: ManagedAccount[]): boolean {
    const now = Date.now()
    return accounts.some(
      (acc) => acc.isHealthy && acc.expiresAt > now && !isPermanentError(acc.unhealthyReason)
    )
  }

  private allAccountsPermanentlyUnhealthy(): boolean {
    const accounts = this.accountManager.getAccounts()
    if (accounts.length === 0) {
      return false
    }
    return accounts.every((acc) => !acc.isHealthy && isPermanentError(acc.unhealthyReason))
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }
}
