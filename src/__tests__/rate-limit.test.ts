import { describe, expect, test } from 'bun:test'
import { AccountSelector } from '../core/account/account-selector.js'
import { UsageTracker } from '../core/account/usage-tracker.js'
import { retryAfterMs } from '../core/request/error-handler.js'
import { KiroRateLimitError } from '../plugin/errors.js'

describe('retryAfterMs', () => {
  test('reads seconds and HTTP dates', () => {
    expect(retryAfterMs('5')).toBe(5000)
    const inTwoMinutes = new Date(Date.now() + 120_000).toUTCString()
    expect(retryAfterMs(inTwoMinutes)).toBeGreaterThan(110_000)
  })

  test('falls back to a short default instead of a full minute', () => {
    expect(retryAfterMs(null)).toBe(10_000)
    expect(retryAfterMs('soon')).toBe(10_000)
  })

  test('never retries immediately', () => {
    expect(retryAfterMs('0')).toBe(1000)
  })
})

describe('AccountSelector with every account rate-limited', () => {
  function selector(wait: number) {
    const accountManager: any = {
      getAccountCount: () => 1,
      getCurrentOrNext: () => null,
      getMinWaitTime: () => wait,
      shouldShowToast: () => false
    }
    return new AccountSelector(
      accountManager,
      { auto_sync_kiro_cli: false, account_selection_strategy: 'sticky' },
      async () => {},
      {} as any
    )
  }

  test('a long wait is reported as a rate limit, not a reauth', async () => {
    const err = await selector(120_000)
      .selectHealthyAccount(() => {})
      .catch((e) => e)
    expect(err).toBeInstanceOf(KiroRateLimitError)
    expect(err.message).not.toContain('reauth required')
    expect(err.retryAfter).toBe(120_000)
  })

  test('unhealthy accounts with nothing to wait for still ask for reauth', async () => {
    const err = await selector(0)
      .selectHealthyAccount(() => {})
      .catch((e) => e)
    expect(err.message).toContain('reauth required')
  })
})

describe('UsageTracker failure classification', () => {
  function tracker(message: string) {
    const marked: string[] = []
    const accountManager: any = {
      markUnhealthy: (_acc: unknown, reason: string) => marked.push(reason)
    }
    const repository: any = { save: async () => {} }
    const t: any = new UsageTracker(
      { usage_tracking_enabled: true, usage_sync_max_retries: 0 },
      accountManager,
      repository
    )
    t.syncNow = async () => {
      throw new Error(message)
    }
    return { t, marked }
  }

  test('a validation error mentioning "invalid" does not mark the account', async () => {
    const { t, marked } = tracker('Status: 400 (ValidationException): field is invalid')
    await expect(t.syncWithRetry({ id: 'a' }, {}, 0)).rejects.toThrow()
    expect(marked).toHaveLength(0)
  })

  test('an auth failure still does', async () => {
    const { t, marked } = tracker('Status: 403 (AccessDeniedException): denied')
    await expect(t.syncWithRetry({ id: 'a' }, {}, 0)).rejects.toThrow()
    expect(marked).toHaveLength(1)
  })
})
