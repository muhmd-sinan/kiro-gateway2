import { describe, expect, test } from 'bun:test'
import {
  findClientCredsRecursive,
  getCliDbPath,
  makePlaceholderEmail,
  normalizeExpiresAt,
  safeJsonParse
} from '../plugin/sync/kiro-cli-parser.js'

// ── getCliDbPath ──────────────────────────────────────────────────────────────

describe('getCliDbPath', () => {
  test('respects KIROCLI_DB_PATH override', () => {
    process.env.KIROCLI_DB_PATH = '/custom/path.db'
    expect(getCliDbPath()).toBe('/custom/path.db')
    delete process.env.KIROCLI_DB_PATH
  })

  test('returns a string path without override', () => {
    delete process.env.KIROCLI_DB_PATH
    const path = getCliDbPath()
    expect(typeof path).toBe('string')
    expect(path.length).toBeGreaterThan(0)
  })
})

// ── safeJsonParse ─────────────────────────────────────────────────────────────

describe('safeJsonParse', () => {
  test('parses valid JSON string', () => {
    expect(safeJsonParse('{"key":"value"}')).toEqual({ key: 'value' })
  })

  test('returns null for invalid JSON', () => {
    expect(safeJsonParse('not json')).toBeNull()
    expect(safeJsonParse('{')).toBeNull()
  })

  test('returns null for non-string input', () => {
    expect(safeJsonParse(42)).toBeNull()
    expect(safeJsonParse(null)).toBeNull()
    expect(safeJsonParse(undefined)).toBeNull()
    expect(safeJsonParse({})).toBeNull()
  })
})

// ── normalizeExpiresAt ────────────────────────────────────────────────────────

describe('normalizeExpiresAt', () => {
  test('ms timestamp stays as-is', () => {
    const ms = 1700000000000
    expect(normalizeExpiresAt(ms)).toBe(ms)
  })

  test('seconds timestamp is converted to ms', () => {
    const sec = 1700000000 // < 10_000_000_000
    expect(normalizeExpiresAt(sec)).toBe(sec * 1000)
  })

  test('ISO date string is converted to ms', () => {
    const iso = '2024-01-01T00:00:00.000Z'
    const expected = new Date(iso).getTime()
    expect(normalizeExpiresAt(iso)).toBe(expected)
  })

  test('numeric string is converted', () => {
    expect(normalizeExpiresAt('1700000000')).toBe(1700000000 * 1000)
  })

  test('returns 0 for invalid input', () => {
    expect(normalizeExpiresAt(null)).toBe(0)
    expect(normalizeExpiresAt('')).toBe(0)
    expect(normalizeExpiresAt('not-a-date')).toBe(0)
  })
})

// ── findClientCredsRecursive ──────────────────────────────────────────────────

describe('findClientCredsRecursive', () => {
  test('finds flat clientId/clientSecret', () => {
    const result = findClientCredsRecursive({ client_id: 'cid', client_secret: 'csec' })
    expect(result).toEqual({ clientId: 'cid', clientSecret: 'csec' })
  })

  test('finds camelCase variant', () => {
    const result = findClientCredsRecursive({ clientId: 'cid', clientSecret: 'csec' })
    expect(result).toEqual({ clientId: 'cid', clientSecret: 'csec' })
  })

  test('finds nested credentials', () => {
    const result = findClientCredsRecursive({
      nested: { deeper: { client_id: 'n-id', client_secret: 'n-sec' } }
    })
    expect(result).toEqual({ clientId: 'n-id', clientSecret: 'n-sec' })
  })

  test('finds credentials inside array', () => {
    const result = findClientCredsRecursive([
      { unrelated: true },
      { client_id: 'arr-id', client_secret: 'arr-sec' }
    ])
    expect(result).toEqual({ clientId: 'arr-id', clientSecret: 'arr-sec' })
  })

  test('returns empty object when not found', () => {
    expect(findClientCredsRecursive({})).toEqual({})
    expect(findClientCredsRecursive(null)).toEqual({})
    expect(findClientCredsRecursive('string')).toEqual({})
  })
})

// ── makePlaceholderEmail ──────────────────────────────────────────────────────

describe('makePlaceholderEmail', () => {
  test('returns a valid placeholder email', () => {
    const email = makePlaceholderEmail('idc', 'eu-central-1', 'cid', 'arn')
    expect(email).toMatch(/^idc-placeholder\+[a-f0-9]+@awsapps\.local$/)
  })

  test('same inputs produce same email (deterministic)', () => {
    const a = makePlaceholderEmail('idc', 'us-east-1', 'c1', 'arn1')
    const b = makePlaceholderEmail('idc', 'us-east-1', 'c1', 'arn1')
    expect(a).toBe(b)
  })

  test('different inputs produce different emails', () => {
    const a = makePlaceholderEmail('idc', 'us-east-1', 'c1', 'arn1')
    const b = makePlaceholderEmail('idc', 'eu-central-1', 'c1', 'arn1')
    expect(a).not.toBe(b)
  })
})
