import { Buffer } from 'node:buffer'
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const binaryToBase64Replacer = (_key: string, value: unknown): unknown => {
  if (value instanceof Uint8Array) return Buffer.from(value).toString('base64')
  return value
}

const getLogDir = () => {
  const platform = process.platform
  const base =
    platform === 'win32'
      ? join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'opencode')
      : join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'opencode')
  return join(base, 'kiro-logs')
}

/**
 * Log directory, created once.
 *
 * Every log call used to re-run mkdirSync, which is a syscall per line for a
 * directory that exists after the first one.
 */
let logDir: string | null = null
function ensureLogDir(): string {
  if (logDir === null) {
    logDir = getLogDir()
    mkdirSync(logDir, { recursive: true })
  }
  return logDir
}

/**
 * Pending lines, flushed together on a timer.
 *
 * appendFileSync blocks the event loop for the length of a disk write, and the
 * request path logs several times per request (fetch hook, model fallback,
 * per-variant toasts, account and token notices). Under concurrency those writes
 * interleave with streaming, so each one stalls token delivery to the client.
 *
 * Batching keeps the ordering and the cost, but moves it off the request path and
 * pays it once per interval instead of once per line. Logs are diagnostics, so a
 * line lost to a hard crash is an acceptable trade; the exit hooks cover every
 * ordinary shutdown.
 */
const pending: string[] = []
let flushTimer: NodeJS.Timeout | undefined
const FLUSH_INTERVAL_MS = 250
/** Bound on memory if something logs in a tight loop between flushes. */
const MAX_PENDING = 1000

function flush(): void {
  if (pending.length === 0) return
  const content = pending.join('')
  pending.length = 0
  try {
    appendFileSync(join(ensureLogDir(), 'plugin.log'), content)
  } catch (e) {}
}

function scheduleFlush(): void {
  if (flushTimer) return
  flushTimer = setTimeout(() => {
    flushTimer = undefined
    flush()
  }, FLUSH_INTERVAL_MS)
  // Must not keep a short-lived process (e.g. `kiro-proxy login`) alive.
  flushTimer.unref?.()
}

if (typeof process !== 'undefined' && typeof process.once === 'function') {
  const onExit = () => {
    if (flushTimer) clearTimeout(flushTimer)
    flushTimer = undefined
    flush()
  }
  process.once('exit', onExit)
  process.once('beforeExit', onExit)
}

const writeToFile = (level: string, message: string, ...args: unknown[]) => {
  try {
    const timestamp = new Date().toISOString()
    const content = `[${timestamp}] ${level}: ${message} ${args
      .map((a) => {
        if (a instanceof Error) {
          return `${a.name}: ${a.message}${a.stack ? `\n${a.stack}` : ''}`
        }
        if (typeof a === 'object') {
          try {
            return JSON.stringify(a)
          } catch {
            return '[Unserializable object]'
          }
        }
        return String(a)
      })
      .join(' ')}\n`

    pending.push(content)
    // Errors are rare and are the lines most worth having on disk if the process
    // dies right after, so they are not deferred.
    if (level === 'ERROR' || pending.length >= MAX_PENDING) flush()
    else scheduleFlush()
  } catch (e) {}
}

const writeApiLog = (
  type: 'request' | 'response',
  data: any,
  timestamp: string,
  isError = false
) => {
  try {
    const dir = ensureLogDir()
    const prefix = isError ? 'error_' : ''
    const filename = `${prefix}${timestamp}_${type}.json`
    const path = join(dir, filename)
    const content = JSON.stringify(data, binaryToBase64Replacer, 2)
    writeFileSync(path, content)
  } catch (e) {}
}

export function log(message: string, ...args: unknown[]): void {
  writeToFile('INFO', message, ...args)
}

export function error(message: string, ...args: unknown[]): void {
  writeToFile('ERROR', message, ...args)
}

export function warn(message: string, ...args: unknown[]): void {
  writeToFile('WARN', message, ...args)
}

export function debug(message: string, ...args: unknown[]): void {
  if (process.env.DEBUG) {
    writeToFile('DEBUG', message, ...args)
  }
}

export function logApiRequest(data: any, timestamp: string): void {
  writeApiLog('request', data, timestamp)
}

export function logApiResponse(data: any, timestamp: string): void {
  writeApiLog('response', data, timestamp)
}

export function logApiError(requestData: any, responseData: any, timestamp: string): void {
  writeApiLog('request', requestData, timestamp, true)
  writeApiLog('response', responseData, timestamp, true)
  const errorType = responseData.status ? `HTTP ${responseData.status}` : 'Network Error'
  const email = requestData.email || 'unknown'
  error(`${errorType} on ${email} - See error_${timestamp}_request.json`)
}

export function getTimestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-')
}
