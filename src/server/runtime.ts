import { AuthHandler } from '../core/auth/auth-handler.js'
import { RequestHandler, type RequestTiming } from '../core/request/request-handler.js'
import { AccountCache } from '../infrastructure/database/account-cache.js'
import { AccountRepository } from '../infrastructure/database/account-repository.js'
import type { HistoryOptions } from '../infrastructure/transformers/history-builder.js'
import { AccountManager } from '../plugin/accounts.js'
import type { KiroConfig } from '../plugin/config/index.js'
import { loadConfig } from '../plugin/config/index.js'
import * as logger from '../plugin/logger.js'
import type { ConversationRequest } from '../plugin/session-map.js'
import { resolveConversationId } from '../plugin/session-map.js'
import type { StreamEvent } from '../plugin/streaming/index.js'
import { transformSdkStreamEvents } from '../plugin/streaming/index.js'
import type { SdkPreparedRequest } from '../plugin/types.js'
import type { WebSearchResult } from '../plugin/web-search.js'
import { kiroWebSearch } from '../plugin/web-search.js'
import { HeadlessAuthenticator } from './headless-auth.js'
import { applyThinking, resolveModelId } from './model-alias.js'
import { normalizeServerToolHistory, planServerTools, runServerToolLoop } from './server-tools.js'

/**
 * Shared Kiro runtime for the standalone proxy.
 *
 * Owns the account pool, auth/token refresh, and the request queue — the same
 * objects the OpenCode plugin builds, minus OpenCode's client. Both HTTP
 * surfaces (`/v1/chat/completions` and `/v1/messages`) go through this, so one
 * account rotation policy and one rate-limit queue cover every client.
 */
export class KiroRuntime {
  private constructor(
    readonly config: KiroConfig,
    readonly auth: HeadlessAuthenticator,
    private readonly requestHandler: RequestHandler,
    private readonly accountManager: AccountManager
  ) {}

  static async create(directory: string = process.cwd()): Promise<KiroRuntime> {
    const config = loadConfig(directory)

    const { syncFromKiroCli } = await import('../plugin/sync/kiro-cli.js')
    const { syncFromKiroIde } = await import('../plugin/sync/kiro-ide.js')
    await syncFromKiroCli()
    await syncFromKiroIde()

    const cache = new AccountCache(60000)
    const repository = new AccountRepository(cache)

    const accountManager = await AccountManager.loadFromDisk(config.account_selection_strategy)
    const authHandler = new AuthHandler(config, repository)
    authHandler.setAccountManager(accountManager)

    // No TUI here, so toasts go to the log file. Passing a no-op would discard
    // rate-limit and re-auth notices that operators need.
    await authHandler.initialize((message, variant) => logger.log(`[${variant}] ${message}`))

    const headlessAuth = new HeadlessAuthenticator(config, repository, accountManager)

    // Re-auth runs through the device-code flow rather than OpenCode's OAuth
    // plumbing, so an expired pool recovers without a restart. See headless-auth.ts.
    const requestHandler = new RequestHandler(
      accountManager,
      config,
      repository,
      headlessAuth.asReauthClient()
    )

    return new KiroRuntime(config, headlessAuth, requestHandler, accountManager)
  }

  accountCount(): number {
    return this.accountManager.getAccountCount()
  }

  /** True when the active account is Pro, which gates Kiro's web search. */
  hasProAccount(): boolean {
    return !!this.accountManager.getAccounts().find((a) => a.profileArn)
  }

  /**
   * Run Kiro's server-side web search.
   *
   * Exposed so the Anthropic surface can execute the `web_search` server tool
   * itself (see server-tools.ts). The OpenCode plugin calls kiroWebSearch
   * directly through its own tool registration; this is the proxy's entry point.
   */
  webSearch(query: string): Promise<WebSearchResult[]> {
    return kiroWebSearch(this.accountManager, query)
  }

  /** Whether web search can actually run: enabled in config and a Pro account. */
  private webSearchAvailable(): boolean {
    return this.config.web_search_enabled && this.hasProAccount()
  }

  /**
   * Send one request upstream and return the normalized Anthropic-shaped event
   * stream, which each route re-encodes for its own wire format.
   */
  async stream(request: ProxyRequest): Promise<{
    events: AsyncGenerator<StreamEvent>
    prep: SdkPreparedRequest
    model: string
  }> {
    const resolved = resolveModelId(request.model, request.defaultModel)
    const model = applyThinking(resolved.id, resolved.thinking || request.thinking)

    if (resolved.fallback) {
      logger.log('Proxy model fallback', { requested: request.model, resolved: model })
    }

    const conversationId = resolveConversationId(request.conversation)

    // Anthropic surface only. The OpenAI surface has no server-tool concept, so
    // its bodies pass through untouched.
    let body = request.body
    let searchToolName: string | null = null
    let maxUses = 0
    if (request.serverTools) {
      body = normalizeServerToolHistory(body)
      const plan = planServerTools(body, this.webSearchAvailable())
      body = plan.body
      searchToolName = plan.searchToolName
      maxUses = plan.maxUses
    }

    // Kept identical to RequestHandler.handleKiroRequest (the OpenCode plugin
    // path) so both surfaces shape history the same way. See HistoryOptions.
    const historyOptions: HistoryOptions = {
      historyImageMessages: this.config.history_image_messages,
      preserveLoopText: true,
      documents: true
    }

    const run = async (
      requestBody: any
    ): Promise<{ events: AsyncGenerator<StreamEvent>; prep: SdkPreparedRequest }> => {
      const { sdkResponse, sdkPrep, timing } = await this.requestHandler.execute(
        requestBody,
        model,
        conversationId,
        (message, variant) => logger.log(`[${variant}] ${message}`),
        historyOptions
      )
      return {
        events: withTimingLog(
          transformSdkStreamEvents(
            sdkResponse,
            model,
            sdkPrep.conversationId,
            sdkPrep.toolNameMap,
            { streamToolInput: true }
          ),
          model,
          timing
        ),
        prep: sdkPrep
      }
    }

    // The first call happens here either way, because the caller needs `prep`
    // synchronously and a generator body would not run until first consumed.
    const first = await run(body)

    if (!searchToolName) {
      return { events: first.events, prep: first.prep, model }
    }

    return {
      events: runServerToolLoop({
        first: first.events,
        execute: async (nextBody) => (await run(nextBody)).events,
        body,
        searchToolName,
        maxUses,
        search: (query) => this.webSearch(query)
      }),
      prep: first.prep,
      model
    }
  }
}

/**
 * Log one line per upstream call with where its time went.
 *
 * Speed work so far was done by reading code, not measuring. This splits a turn
 * into queue wait, time until Kiro's response started (account pick, token
 * refresh, retries, TTFB), time to the first content event, and total stream
 * time, so the next optimisation can target whichever one actually dominates.
 * Passes events through untouched; `finally` runs on normal end, error, and on
 * `return()` from a client disconnect.
 */
export async function* withTimingLog(
  events: AsyncGenerator<StreamEvent>,
  model: string,
  timing: RequestTiming
): AsyncGenerator<StreamEvent> {
  const start = Date.now()
  let firstContentMs: number | null = null
  let credits: number | null = null
  // Stays 'aborted' when the consumer stops early (client disconnect → return()),
  // since neither the loop's end nor the catch runs in that case.
  let outcome = 'aborted'
  try {
    for await (const event of events) {
      if (firstContentMs === null && event.type === 'content_block_delta') {
        firstContentMs = Date.now() - start
      }
      if (event.type === 'message_delta' && event.metering) credits = event.metering.credits
      yield event
    }
    outcome = 'complete'
  } catch (e) {
    outcome = 'error'
    throw e
  } finally {
    logger.log('Proxy timing', {
      model,
      queueMs: timing.queueMs,
      responseStartMs: timing.responseStartMs,
      firstContentMs,
      streamMs: Date.now() - start,
      credits: credits === null ? null : Number(credits.toFixed(4)),
      outcome
    })
  }
}

export interface ProxyRequest {
  /** Body in the shape buildCodeWhispererRequest understands (messages/tools/system). */
  body: any
  model: string | undefined
  defaultModel: string
  /** Identity inputs used to reuse one Kiro conversationId across a chat's turns. */
  conversation: ConversationRequest
  /** Client explicitly asked for extended thinking. */
  thinking: boolean
  /**
   * Handle Anthropic server-side tools (web_search) for this request.
   *
   * Only the `/v1/messages` surface sets this. The OpenAI surface has no
   * server-tool concept, so its bodies must not be rewritten.
   */
  serverTools?: boolean
}

/**
 * Build the conversation-identity inputs for a request.
 *
 * Explicit session headers are used when present, but namespaced first: Claude
 * Code sends the *parent* session id on subagent requests, so keying on it alone
 * would merge a subagent's turns into the main conversation and corrupt both.
 * `x-claude-code-agent-id` is only present on subagent calls, which makes it the
 * right namespace.
 *
 * Without a header (Hermes sends none) identity comes from prefix-chain matching
 * over the message list — see resolveConversationId.
 */
export function deriveConversationRequest(
  headers: Record<string, string | string[] | undefined>,
  body: any,
  surface: string
): ConversationRequest {
  const header = (name: string): string | undefined => {
    const value = headers[name]
    return Array.isArray(value) ? value[0] : value
  }

  const sessionId =
    header('x-claude-code-session-id') ||
    header('x-opencode-session-id') ||
    header('x-session-id') ||
    header('x-litellm-session-id')

  const agentId = header('x-claude-code-agent-id')
  const requestClass = header('x-claude-code-request-class')

  // Compaction and auxiliary calls are one-shot summarization requests over a
  // conversation's history. Letting them join that conversation would append a
  // summarization turn to it, which then replays as real history.
  const isSideChannel = requestClass === 'compaction' || requestClass === 'auxiliary'

  const scopeParts = [surface]
  if (agentId) scopeParts.push(`agent:${agentId}`)
  if (isSideChannel) scopeParts.push(`class:${requestClass}`)

  return {
    explicitKey: isSideChannel ? undefined : sessionId,
    messages: body?.messages,
    scope: scopeParts.join('|')
  }
}
