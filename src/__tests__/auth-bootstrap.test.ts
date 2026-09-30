import { afterEach, describe, expect, test } from 'bun:test'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bootstrapAuthIfNeeded } from '../plugin/auth-bootstrap.js'

const IS_WINDOWS = process.platform === 'win32'

const originalEnv = {
  HOME: process.env.HOME,
  XDG_DATA_HOME: process.env.XDG_DATA_HOME,
  LOCALAPPDATA: process.env.LOCALAPPDATA,
  KIROCLI_DB_PATH: process.env.KIROCLI_DB_PATH
}

afterEach(() => {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

/**
 * Point auth.json resolution at a throwaway directory.
 *
 * getOpenCodeAuthPath() reads LOCALAPPDATA on Windows and XDG_DATA_HOME
 * elsewhere, so the fixture has to redirect whichever one the current platform
 * actually consults — setting only the POSIX vars left the code writing to the
 * developer's real auth.json and the assertions inspecting an untouched fixture.
 */
function setupBootstrapFixture() {
  const home = mkdtempSync(join(tmpdir(), 'kiro-auth-bootstrap-'))
  const dataRoot = join(home, IS_WINDOWS ? 'AppData/Local' : '.local/share')

  process.env.HOME = home
  if (IS_WINDOWS) process.env.LOCALAPPDATA = dataRoot
  else process.env.XDG_DATA_HOME = dataRoot

  const cliDbPath = join(home, 'kiro-cli.sqlite3')
  writeFileSync(cliDbPath, '')
  process.env.KIROCLI_DB_PATH = cliDbPath

  const authDir = join(dataRoot, 'opencode')
  const authPath = join(authDir, 'auth.json')
  mkdirSync(authDir, { recursive: true })

  return { home, authPath }
}

describe('bootstrapAuthIfNeeded', () => {
  test('does not rewrite malformed auth.json', () => {
    const { home, authPath } = setupBootstrapFixture()
    writeFileSync(authPath, '{"github":')

    bootstrapAuthIfNeeded('kiro')

    expect(readFileSync(authPath, 'utf-8')).toBe('{"github":')
    rmSync(home, { recursive: true, force: true })
  })

  test('adds placeholder while preserving existing auth providers', () => {
    const { home, authPath } = setupBootstrapFixture()
    writeFileSync(authPath, JSON.stringify({ github: { type: 'api', key: 'existing' } }, null, 2))

    bootstrapAuthIfNeeded('kiro')

    const written = JSON.parse(readFileSync(authPath, 'utf-8'))
    expect(written.github).toEqual({ type: 'api', key: 'existing' })
    // The placeholder only has to make OpenCode call the auth loader; the loader
    // then syncs real credentials. Asserting the entry's exact shape would couple
    // this test to that unrelated detail, so only the contract is checked.
    expect(written.kiro).toBeDefined()
    expect(written.kiro.type).toBe('oauth')
    rmSync(home, { recursive: true, force: true })
  })

  test('does not overwrite an existing provider entry', () => {
    const { home, authPath } = setupBootstrapFixture()
    const existing = { kiro: { type: 'oauth', access: 'real-token', refresh: 'r', expires: 1 } }
    writeFileSync(authPath, JSON.stringify(existing, null, 2))

    bootstrapAuthIfNeeded('kiro')

    expect(JSON.parse(readFileSync(authPath, 'utf-8'))).toEqual(existing)
    rmSync(home, { recursive: true, force: true })
  })

  test.skipIf(IS_WINDOWS)('preserves restrictive auth.json permissions when rewriting', () => {
    // Windows ignores POSIX mode bits: chmod(0o600) reports back as 0o666, so
    // there is no restrictive mode to preserve and nothing meaningful to assert.
    // The behaviour under test is real on POSIX, where auth.json holds tokens.
    const { home, authPath } = setupBootstrapFixture()
    writeFileSync(authPath, JSON.stringify({ github: { type: 'api', key: 'existing' } }, null, 2))
    chmodSync(authPath, 0o600)

    bootstrapAuthIfNeeded('kiro')

    expect(statSync(authPath).mode & 0o777).toBe(0o600)
    rmSync(home, { recursive: true, force: true })
  })

  test('writes the placeholder without widening permissions on a new file', () => {
    // Runs everywhere: on POSIX it asserts the 0o600 default, on Windows it at
    // least proves the write path completes and produces valid JSON.
    const { home, authPath } = setupBootstrapFixture()

    bootstrapAuthIfNeeded('kiro')

    expect(JSON.parse(readFileSync(authPath, 'utf-8')).kiro).toBeDefined()
    if (!IS_WINDOWS) {
      expect(statSync(authPath).mode & 0o077).toBe(0)
    }
    rmSync(home, { recursive: true, force: true })
  })
})
