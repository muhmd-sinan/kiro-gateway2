import { afterAll, describe, expect, mock, test } from 'bun:test'
import * as authModule from '../kiro/auth.js'
import * as loggerModule from '../plugin/logger.js'
import * as ideModule from '../plugin/sync/kiro-ide.js'
import * as tokenModule from '../plugin/token.js'
import type { KiroAuthDetails } from '../plugin/types.js'

// Copied before mocking: mock.module updates these namespaces in place.
const realAuth = { ...authModule }
const realLogger = { ...loggerModule }
const realIde = { ...ideModule }
const realToken = { ...tokenModule }

let refreshImpl: (auth: KiroAuthDetails) => Promise<KiroAuthDetails> = realToken.refreshAccessToken

mock.module('../kiro/auth.js', () => ({
  ...realAuth,
  // The real rule, restated: other suites mock this module with
  // `accessTokenExpired: () => false`, and module mocks are process-wide.
  accessTokenExpired: (auth: KiroAuthDetails, bufferMs = 120000) =>
    !auth.access || !auth.expires || Date.now() >= auth.expires - bufferMs
}))
mock.module('../plugin/token.js', () => ({
  ...realToken,
  refreshAccessToken: (auth: KiroAuthDetails) => refreshImpl(auth)
}))
// A test must never write the real Kiro IDE token file or plugin.log.
mock.module('../plugin/sync/kiro-ide.js', () => ({ ...realIde, writeToKiroIde: () => {} }))
mock.module('../plugin/logger.js', () => ({ ...realLogger, warn: () => {}, error: () => {} }))

const { TokenRefresher } = await import('../core/auth/token-refresher.js')

afterAll(() => {
  refreshImpl = realToken.refreshAccessToken
})

const fresh = () => ({ access: 'new', expires: Date.now() + 3_600_000 }) as KiroAuthDetails

function setup(save: () => Promise<void> = async () => {}) {
  const calls = { unhealthy: 0 }
  const accountManager: any = {
    updateFromAuth: (acc: any, auth: KiroAuthDetails) => {
      acc.accessToken = auth.access
      acc.expiresAt = auth.expires
    },
    markUnhealthy: () => {
      calls.unhealthy++
    },
    getAccounts: () => [],
    toAuthDetails: (acc: any) => ({ access: acc.accessToken, expires: acc.expiresAt })
  }
  const repository: any = {
    save,
    batchSave: async () => {},
    invalidateCache: () => {},
    findAll: async () => []
  }
  const refresher = new TokenRefresher(
    { token_expiry_buffer_ms: 0, auto_sync_kiro_cli: false, account_selection_strategy: 'sticky' },
    accountManager,
    async () => {},
    repository
  )
  const account: any = { id: 'a1', accessToken: 'old', expiresAt: Date.now() - 1000 }
  const auth = { access: 'old', expires: account.expiresAt } as KiroAuthDetails
  return { refresher, calls, account, auth }
}

describe('TokenRefresher', () => {
  test('concurrent callers on one expired token share a single refresh', async () => {
    // Refresh tokens rotate: a second refresh would present a spent token, get
    // invalid_grant, and mark the account unhealthy.
    let refreshes = 0
    let release!: () => void
    refreshImpl = async () => {
      refreshes++
      await new Promise<void>((r) => (release = r))
      return fresh()
    }
    const { refresher, account, auth } = setup()
    const first = refresher.refreshIfNeeded(account, auth, () => {})
    const second = refresher.refreshIfNeeded(account, auth, () => {})
    release()
    const results = await Promise.all([first, second])

    expect(refreshes).toBe(1)
    expect(results.map((r) => r.shouldContinue)).toEqual([false, false])
    expect(account.accessToken).toBe('new')
  })

  test('refreshes again once the earlier refresh has settled', async () => {
    let refreshes = 0
    refreshImpl = async () => {
      refreshes++
      return fresh()
    }
    const { refresher, account, auth } = setup()
    await refresher.refreshIfNeeded(account, auth, () => {})
    await refresher.refreshIfNeeded(account, auth, () => {})
    expect(refreshes).toBe(2)
  })

  test('a failed save after a good refresh is not treated as a failed refresh', async () => {
    refreshImpl = async () => fresh()
    const { refresher, calls, account, auth } = setup(async () => {
      throw new Error('database is locked')
    })
    const result = await refresher.refreshIfNeeded(account, auth, () => {})
    expect(result.shouldContinue).toBe(false)
    expect(account.accessToken).toBe('new')
    expect(calls.unhealthy).toBe(0)
  })

  test('concurrent forced refreshes share a single refresh', async () => {
    let refreshes = 0
    refreshImpl = async () => {
      refreshes++
      return fresh()
    }
    const { refresher, account, auth } = setup()
    await Promise.all([
      refresher.forceRefresh(account, auth),
      refresher.forceRefresh(account, auth)
    ])
    expect(refreshes).toBe(1)
  })
})
