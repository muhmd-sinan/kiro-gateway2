import type { AccountRepository } from '../../infrastructure/database/account-repository'
import { accessTokenExpired } from '../../kiro/auth'
import type { AccountManager } from '../../plugin/accounts'
import { KiroTokenRefreshError } from '../../plugin/errors'
import * as logger from '../../plugin/logger'
import { refreshAccessToken } from '../../plugin/token'
import type { KiroAuthDetails, ManagedAccount } from '../../plugin/types'

type ToastFunction = (message: string, variant: 'info' | 'warning' | 'success' | 'error') => void

interface TokenRefresherConfig {
  token_expiry_buffer_ms: number
  auto_sync_kiro_cli: boolean
  account_selection_strategy: 'sticky' | 'round-robin' | 'lowest-usage'
}

type RefreshResult = { account: ManagedAccount; shouldContinue: boolean }

/**
 * In-flight refreshes, keyed per account.
 *
 * Up to max_concurrent_requests callers can find the same expired token at
 * once, and each used to call refreshAccessToken itself. IDC and social logins
 * rotate the refresh token, so every call after the first presented a token the
 * first had already spent, got invalid_grant, and handleRefreshError marked the
 * just-refreshed account unhealthy. Concurrent callers now share one refresh.
 * Static because the plugin and proxy can each construct a TokenRefresher over
 * the same accounts.
 */
const inFlight = new Map<string, Promise<unknown>>()

function singleFlight<T>(key: string, run: () => Promise<T>): Promise<T> {
  const pending = inFlight.get(key)
  if (pending) return pending as Promise<T>
  const promise = run().finally(() => inFlight.delete(key))
  inFlight.set(key, promise)
  return promise
}

export class TokenRefresher {
  constructor(
    private config: TokenRefresherConfig,
    private accountManager: AccountManager,
    private syncFromKiroCli: () => Promise<void>,
    private repository: AccountRepository
  ) {}

  async refreshIfNeeded(
    account: ManagedAccount,
    auth: KiroAuthDetails,
    showToast: ToastFunction
  ): Promise<RefreshResult> {
    if (!accessTokenExpired(auth, this.config.token_expiry_buffer_ms)) {
      return { account, shouldContinue: false }
    }
    return singleFlight(`refresh:${account.id}`, () => this.refresh(account, auth, showToast))
  }

  private async refresh(
    account: ManagedAccount,
    auth: KiroAuthDetails,
    showToast: ToastFunction
  ): Promise<RefreshResult> {
    let newAuth: KiroAuthDetails
    try {
      newAuth = await refreshAccessToken(auth)
    } catch (e: any) {
      return await this.handleRefreshError(e, account, showToast)
    }

    // updateFromAuth also writes the token back to kiro-cli (fire-and-forget).
    // This used to write it a second time, awaited, on the request path: a
    // synchronous libsql write that can wait out kiro-cli's lock and stall every
    // open stream meanwhile.
    this.accountManager.updateFromAuth(account, newAuth)

    // The new token is in memory and valid from here on. A failed save is a
    // storage problem, not a refresh failure: routing it to handleRefreshError
    // re-synced and could mark this healthy account unhealthy.
    try {
      // Only the updated account, so the whole AccountCache isn't invalidated.
      await this.repository.save(account)
      const { writeToKiroIde } = await import('../../plugin/sync/kiro-ide.js')
      writeToKiroIde(account)
    } catch (e) {
      logger.warn('Token refreshed but persisting it failed', {
        email: account.email,
        message: e instanceof Error ? e.message : String(e)
      })
    }
    return { account, shouldContinue: false }
  }

  forceRefresh(account: ManagedAccount, auth: KiroAuthDetails): Promise<void> {
    // Several requests can 403 on the same stale bearer at once; same rotation
    // hazard as refreshIfNeeded.
    return singleFlight(`force:${account.id}`, () => this.doForceRefresh(account, auth))
  }

  private async doForceRefresh(account: ManagedAccount, auth: KiroAuthDetails): Promise<void> {
    if (this.config.auto_sync_kiro_cli) {
      await this.syncFromKiroCli()
    }

    this.repository.invalidateCache()
    const accounts = await this.repository.findAll()
    const synced = accounts.find((a: ManagedAccount) => a.id === account.id)

    if (synced && synced.accessToken !== account.accessToken) {
      this.accountManager.updateFromAuth(account, this.accountManager.toAuthDetails(synced))
      await this.repository.batchSave(this.accountManager.getAccounts())
      logger.debug('Force refresh: recovered newer token from CLI sync')
      return
    }

    try {
      const newAuth = await refreshAccessToken(auth)
      this.accountManager.updateFromAuth(account, newAuth)
      await this.repository.batchSave(this.accountManager.getAccounts())
      logger.debug('Force refresh: token refreshed via OIDC')
    } catch (e: any) {
      logger.warn('Force refresh failed, will retry with current token', {
        message: e instanceof Error ? e.message : String(e)
      })
    }
  }

  private async handleRefreshError(
    error: any,
    account: ManagedAccount,
    showToast: ToastFunction
  ): Promise<{ account: ManagedAccount; shouldContinue: boolean }> {
    logger.error('Token refresh failed', {
      email: account.email,
      code: error instanceof KiroTokenRefreshError ? error.code : undefined,
      message: error instanceof Error ? error.message : String(error)
    })
    if (this.config.auto_sync_kiro_cli) {
      await this.syncFromKiroCli()
    }

    this.repository.invalidateCache()
    const accounts = await this.repository.findAll()
    const stillAcc = accounts.find((a: ManagedAccount) => a.id === account.id)

    if (
      stillAcc &&
      !accessTokenExpired(
        this.accountManager.toAuthDetails(stillAcc),
        this.config.token_expiry_buffer_ms
      )
    ) {
      showToast('Credentials recovered from Kiro CLI sync.', 'info')
      return { account: stillAcc, shouldContinue: true }
    }

    if (
      error instanceof KiroTokenRefreshError &&
      (error.code === 'ExpiredTokenException' ||
        error.code === 'InvalidTokenException' ||
        error.code === 'ExpiredClientException' ||
        error.code === 'HTTP_401' ||
        error.code === 'HTTP_403' ||
        error.message.includes('Invalid refresh token provided') ||
        error.message.includes('Invalid grant provided') ||
        error.message.includes('Client is expired'))
    ) {
      this.accountManager.markUnhealthy(account, error.code || error.message)
      await this.repository.batchSave(this.accountManager.getAccounts())
      return { account, shouldContinue: true }
    }

    logger.error('Token refresh unrecoverable', {
      email: account.email,
      code: error instanceof KiroTokenRefreshError ? error.code : undefined,
      message: error instanceof Error ? error.message : String(error)
    })
    throw error
  }
}
