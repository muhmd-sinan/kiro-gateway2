import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/**
 * Standalone proxy server settings.
 *
 * Deliberately separate from KiroConfig (kiro.json), which configures Kiro
 * account behaviour. These are transport concerns: where to listen and who is
 * allowed to connect.
 */
export interface ServerConfig {
  host: string
  port: number
  /** Bearer token clients must present. Empty string disables the check. */
  token: string
  /** Default model when a client sends one we can't resolve. */
  defaultModel: string
  /** Seconds of stream silence before emitting a keep-alive. */
  keepAliveSeconds: number
}

export const DEFAULT_PORT = 19899
const TOKEN_FILE = 'kiro-proxy-token'

function configDir(): string {
  if (process.platform === 'win32') {
    return join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'opencode')
  }
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'opencode')
}

export function tokenPath(): string {
  return join(configDir(), TOKEN_FILE)
}

/**
 * Read the persisted bearer token, generating one on first run.
 *
 * Generating rather than defaulting to "no auth" keeps the server safe if it is
 * ever bound off loopback, and persisting it means client configs stay valid
 * across restarts. File mode is tightened on POSIX; on Windows the
 * user-profile ACL already restricts it.
 */
export function loadOrCreateToken(): string {
  const path = tokenPath()
  try {
    if (existsSync(path)) {
      const existing = readFileSync(path, 'utf8').trim()
      if (existing) return existing
    }
  } catch {
    // fall through and regenerate
  }

  const token = `kiro-${randomBytes(24).toString('hex')}`
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `${token}\n`, 'utf8')
    if (process.platform !== 'win32') chmodSync(path, 0o600)
  } catch {
    // An unwritable config dir shouldn't stop the server; the token just won't
    // survive a restart, and the caller prints it either way.
  }
  return token
}

function parseIntEnv(value: string | undefined, fallback: number): number {
  if (!value) return fallback
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

export function loadServerConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  const env = process.env
  const authDisabled = env.KIRO_PROXY_NO_AUTH === '1' || env.KIRO_PROXY_NO_AUTH === 'true'

  return {
    host: overrides.host ?? env.KIRO_PROXY_HOST ?? '127.0.0.1',
    port: overrides.port ?? parseIntEnv(env.KIRO_PROXY_PORT, DEFAULT_PORT),
    token: overrides.token ?? (authDisabled ? '' : env.KIRO_PROXY_TOKEN || loadOrCreateToken()),
    defaultModel: overrides.defaultModel ?? env.KIRO_PROXY_DEFAULT_MODEL ?? 'claude-sonnet-4-6',
    keepAliveSeconds:
      overrides.keepAliveSeconds ?? parseIntEnv(env.KIRO_PROXY_KEEPALIVE_SECONDS, 15)
  }
}

/** True when the server is reachable from outside the machine. */
export function isPubliclyBound(host: string): boolean {
  return host !== '127.0.0.1' && host !== 'localhost' && host !== '::1'
}
