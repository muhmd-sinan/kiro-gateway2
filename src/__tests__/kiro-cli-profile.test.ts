import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let dir: string
let dbPath: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kiro-profile-test-'))
  dbPath = join(dir, 'data.sqlite3')
})

/**
 * Remove the fixture directory, tolerating a briefly-held file handle.
 *
 * libsql releases the database file a short time *after* close() returns, so on
 * Windows an immediate rm fails with EBUSY (measured at ~200ms). rmSync's own
 * maxRetries option is not honoured here, so the wait is explicit. Production
 * code is unaffected: it never deletes the Kiro CLI database.
 */
async function removeFixtureDir(path: string): Promise<void> {
  for (let attempt = 0; attempt < 25; attempt++) {
    try {
      rmSync(path, { recursive: true, force: true })
      return
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (code !== 'EBUSY' && code !== 'EPERM' && code !== 'ENOTEMPTY') throw e
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
  // Leaving a temp directory behind is preferable to failing the suite over it.
}

afterEach(async () => {
  await removeFixtureDir(dir)
})

describe('readActiveProfileArnFromKiroCli', () => {
  test('returns undefined when DB file does not exist', async () => {
    process.env.KIROCLI_DB_PATH = join(dir, 'nonexistent.sqlite3')
    const { readActiveProfileArnFromKiroCli } = await import('../plugin/sync/kiro-cli-profile.js')
    expect(readActiveProfileArnFromKiroCli()).toBeUndefined()
    delete process.env.KIROCLI_DB_PATH
  })

  test('returns profileArn from state table', async () => {
    process.env.KIROCLI_DB_PATH = dbPath
    const db = new Database(dbPath)
    db.run('CREATE TABLE state (key TEXT PRIMARY KEY, value TEXT)')
    db.run('INSERT INTO state (key, value) VALUES (?, ?)', [
      'api.codewhisperer.profile',
      JSON.stringify({ arn: 'arn:aws:codewhisperer:eu-central-1:123:profile/ABC' })
    ])
    db.close()

    const { readActiveProfileArnFromKiroCli } = await import('../plugin/sync/kiro-cli-profile.js')
    const result = readActiveProfileArnFromKiroCli()
    expect(result).toBe('arn:aws:codewhisperer:eu-central-1:123:profile/ABC')
    delete process.env.KIROCLI_DB_PATH
  })

  test('returns undefined when row is missing', async () => {
    process.env.KIROCLI_DB_PATH = dbPath
    const db = new Database(dbPath)
    db.run('CREATE TABLE state (key TEXT PRIMARY KEY, value TEXT)')
    db.close()

    const { readActiveProfileArnFromKiroCli } = await import('../plugin/sync/kiro-cli-profile.js')
    expect(readActiveProfileArnFromKiroCli()).toBeUndefined()
    delete process.env.KIROCLI_DB_PATH
  })

  test('returns undefined when JSON has no arn field', async () => {
    process.env.KIROCLI_DB_PATH = dbPath
    const db = new Database(dbPath)
    db.run('CREATE TABLE state (key TEXT PRIMARY KEY, value TEXT)')
    db.run('INSERT INTO state (key, value) VALUES (?, ?)', [
      'api.codewhisperer.profile',
      JSON.stringify({ other: 'field' })
    ])
    db.close()

    const { readActiveProfileArnFromKiroCli } = await import('../plugin/sync/kiro-cli-profile.js')
    expect(readActiveProfileArnFromKiroCli()).toBeUndefined()
    delete process.env.KIROCLI_DB_PATH
  })
})
