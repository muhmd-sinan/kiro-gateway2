import { extractRegionFromArn, normalizeRegion } from '../constants.js'
import type { AccountRepository } from '../infrastructure/database/account-repository.js'
import { authorizeKiroIDC, pollKiroIDCToken } from '../kiro/oauth-idc.js'
import type { AccountManager } from '../plugin/accounts.js'
import { createDeterministicAccountId } from '../plugin/accounts.js'
import type { KiroConfig } from '../plugin/config/index.js'
import * as logger from '../plugin/logger.js'
import { makePlaceholderEmail } from '../plugin/sync/kiro-cli-parser.js'
import { readActiveProfileArnFromKiroCli } from '../plugin/sync/kiro-cli-profile.js'
import type { KiroRegion, ManagedAccount } from '../plugin/types.js'
import { fetchUsageLimits } from '../plugin/usage.js'

/**
 * Device-code re-authentication for the headless proxy.
 *
 * The OpenCode plugin delegates re-auth to OpenCode's OAuth plumbing
 * (`client.provider.oauth.authorize`), which doesn't exist in a standalone
 * server. Without a substitute, an expired account pool means the proxy returns
 * "please re-authenticate" until someone restarts it after signing in elsewhere.
 *
 * The AWS OIDC device-code flow needs no callback server and no interactive TTY:
 * it returns a URL plus a short code, and the server polls until the user
 * approves in a browser. That works over SSH, in a container, and from the
 * agent CLIs themselves.
 *
 * Two entry points:
 *
 * - `begin()` / `status()` back the `/auth/*` HTTP endpoints, so a user can
 *   re-authenticate without touching the terminal running the server.
 * - `asReauthClient()` adapts this to the shape RequestHandler expects, so an
 *   all-accounts-expired request triggers a flow automatically rather than
 *   failing outright.
 *
 * Deliberately *not* automatic-and-silent: approving a device code requires a
 * human in a browser. A request that trips re-auth fails with the URL and code
 * in the error message, and the pending flow stays open so the next request
 * succeeds once approved.
 */

export type AuthState = 'idle' | 'pending' | 'success' | 'failed'

export interface AuthFlowStatus {
  state: AuthState
  /** Verification URL to open. */
  url?: string
  /** Code to enter at that URL. */
  userCode?: string
  /** When the device code stops being valid. */
  expiresAt?: number
  /** Populated on success. */
  email?: string
  /** Populated on failure. */
  error?: string
  accounts: number
}

interface PendingFlow {
  url: string
  userCode: string
  expiresAt: number
  /** Resolves when polling finishes; rejects on failure. */
  completion: Promise<ManagedAccount>
}

const FAILURE_COOLDOWN_MS = 60_000

export class HeadlessAuthenticator {
  private pending: PendingFlow | null = null
  private last: { state: AuthState; email?: string; error?: string } = { state: 'idle' }
  private lastFailureAt = 0

  constructor(
    private readonly config: KiroConfig,
    private readonly repository: AccountRepository,
    private readonly accountManager: AccountManager
  ) {}

  status(): AuthFlowStatus {
    const accounts = this.accountManager.getAccountCount()

    if (this.pending && Date.now() < this.pending.expiresAt) {
      return {
        state: 'pending',
        url: this.pending.url,
        userCode: this.pending.userCode,
        expiresAt: this.pending.expiresAt,
        accounts
      }
    }

    return { state: this.last.state, email: this.last.email, error: this.last.error, accounts }
  }

  /**
   * Start a device-code flow, or return the in-flight one.
   *
   * Idempotent while a flow is live so concurrent requests (several agents
   * hitting an expired pool at once) share a single code rather than each
   * spawning one and invalidating the others.
   */
  async begin(): Promise<AuthFlowStatus> {
    if (this.pending && Date.now() < this.pending.expiresAt) {
      return this.status()
    }

    const startUrl = this.config.idc_start_url
    const profileArn = this.config.idc_profile_arn || readActiveProfileArnFromKiroCli()
    const oidcRegion: KiroRegion = normalizeRegion(
      this.config.idc_region || extractRegionFromArn(profileArn) || this.config.default_region
    )

    const authorization = await authorizeKiroIDC(oidcRegion, startUrl)

    // Prefer the org's Identity Center device page when a start URL is set; the
    // Builder ID page asks for an email the user may not expect.
    const url = startUrl
      ? buildDeviceUrl(startUrl, authorization.userCode)
      : authorization.verificationUriComplete || authorization.verificationUrl

    const expiresAt = Date.now() + authorization.expiresIn * 1000

    logger.log('Headless auth: device flow started', {
      url,
      userCode: authorization.userCode,
      oidcRegion
    })

    const completion = this.pollAndStore(authorization, oidcRegion, profileArn, startUrl)
    // Rejection is surfaced via status()/await; an unhandled rejection here would
    // crash the process.
    completion.catch(() => {})

    this.pending = { url, userCode: authorization.userCode, expiresAt, completion }
    this.last = { state: 'pending' }

    return this.status()
  }

  /** Block until the in-flight flow resolves. Used by the CLI login command. */
  async waitForCompletion(): Promise<AuthFlowStatus> {
    if (!this.pending) return this.status()
    try {
      await this.pending.completion
    } catch {
      // status() carries the error.
    }
    return this.status()
  }

  private async pollAndStore(
    authorization: Awaited<ReturnType<typeof authorizeKiroIDC>>,
    oidcRegion: KiroRegion,
    profileArn: string | undefined,
    startUrl: string | undefined
  ): Promise<ManagedAccount> {
    try {
      const token = await pollKiroIDCToken(
        authorization.clientId,
        authorization.clientSecret,
        authorization.deviceCode,
        authorization.interval,
        authorization.expiresIn,
        oidcRegion
      )

      const serviceRegion = extractRegionFromArn(profileArn) || this.config.default_region
      const account = await this.buildAccount(
        token,
        serviceRegion,
        oidcRegion,
        profileArn,
        startUrl
      )

      await this.repository.save(account)
      this.repository.invalidateCache()
      this.accountManager.addAccount(account)

      this.last = { state: 'success', email: account.email }
      this.pending = null
      logger.log('Headless auth: account stored', { email: account.email })
      return account
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      this.last = { state: 'failed', error: message }
      this.pending = null
      this.lastFailureAt = Date.now()
      logger.error('Headless auth failed', e instanceof Error ? e : new Error(message))
      throw e
    }
  }

  private async buildAccount(
    token: Awaited<ReturnType<typeof pollKiroIDCToken>>,
    serviceRegion: KiroRegion,
    oidcRegion: KiroRegion,
    profileArn: string | undefined,
    startUrl: string | undefined
  ): Promise<ManagedAccount> {
    let usage: { usedCount: number; limitCount: number; email?: string } = {
      usedCount: 0,
      limitCount: 0
    }

    try {
      usage = await fetchUsageLimits({
        refresh: '',
        access: token.accessToken,
        expires: token.expiresAt,
        authMethod: 'idc',
        region: serviceRegion,
        clientId: token.clientId,
        clientSecret: token.clientSecret,
        profileArn
      })
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      // A missing profile ARN on an Identity Center account is the one failure
      // worth aborting for: every later request would 403.
      if (startUrl && !profileArn) {
        throw new Error(
          `Missing profile ARN for IAM Identity Center. Set "idc_profile_arn" in kiro.json, or run "kiro-cli profile" once so it can be auto-detected. Original error: ${message}`
        )
      }
      // Free Builder ID accounts don't expose usage limits; that's not fatal.
      if (!message.includes('FEATURE_NOT_SUPPORTED') && !message.includes('REQUEST_BODY_INVALID')) {
        throw e
      }
      logger.warn('Headless auth: usage lookup unsupported, continuing', { serviceRegion })
    }

    const email =
      usage.email ||
      decodeEmailFromAccessToken(token.accessToken) ||
      makePlaceholderEmail('idc', serviceRegion, token.clientId, profileArn)

    return {
      id: createDeterministicAccountId(email, 'idc', token.clientId, profileArn),
      email,
      authMethod: 'idc',
      region: serviceRegion,
      oidcRegion,
      clientId: token.clientId,
      clientSecret: token.clientSecret,
      profileArn,
      startUrl: startUrl || undefined,
      refreshToken: token.refreshToken,
      accessToken: token.accessToken,
      expiresAt: token.expiresAt,
      rateLimitResetTime: 0,
      isHealthy: true,
      failCount: 0,
      usedCount: usage.usedCount,
      limitCount: usage.limitCount
    }
  }

  /**
   * Adapter matching the `client` shape RequestHandler.performReauth calls.
   *
   * RequestHandler invokes `provider.oauth.authorize` then `.callback`. Mapping
   * those onto begin()/wait lets the existing retry ladder drive re-auth without
   * knowing whether it's running under OpenCode or standalone.
   *
   * `authorize` throws with the URL and code rather than blocking for up to ten
   * minutes holding the request queue. The flow stays pending, so once the user
   * approves, the next request proceeds.
   */
  asReauthClient(): {
    provider: { oauth: { authorize: () => Promise<void>; callback: () => Promise<void> } }
  } {
    return {
      provider: {
        oauth: {
          authorize: async () => {
            if (Date.now() - this.lastFailureAt < FAILURE_COOLDOWN_MS) {
              throw new Error(
                `Kiro re-authentication failed recently. Retry in ${Math.ceil(
                  (FAILURE_COOLDOWN_MS - (Date.now() - this.lastFailureAt)) / 1000
                )}s, or run: kiro-proxy login`
              )
            }

            const status = await this.begin()
            throw new Error(
              `Kiro authentication required. Open ${status.url} and enter code ${status.userCode}, then retry. ` +
                `Status: GET /auth/status`
            )
          },
          callback: async () => {
            // Unreachable: authorize() always throws. Present so the adapter
            // satisfies the interface.
          }
        }
      }
    }
  }
}

/** Build the Identity Center portal device page for a user code. */
function buildDeviceUrl(startUrl: string, userCode: string): string {
  const url = new URL(startUrl)
  url.search = ''
  if (url.pathname.endsWith('/start')) url.pathname = `${url.pathname}/`
  url.pathname = url.pathname.replace(/\/start\/?$/, '/start/')
  url.hash = `#/device?user_code=${encodeURIComponent(userCode)}`
  return url.toString()
}

/** Best-effort email from the access token's JWT payload. */
function decodeEmailFromAccessToken(accessToken: string): string | undefined {
  try {
    const parts = accessToken.split('.')
    if (parts.length !== 3 || !parts[1]) return undefined
    const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString())
    return payload.email || payload.sub || undefined
  } catch {
    return undefined
  }
}
