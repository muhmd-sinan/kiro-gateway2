import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { extractRegionFromArn, normalizeRegion } from '../../constants.js'
import { createDeterministicAccountId } from '../accounts.js'
import * as logger from '../logger.js'
import { kiroDb } from '../storage/sqlite.js'
import { makePlaceholderEmail } from './kiro-cli-parser.js'

function cacheDir(): string {
  return join(homedir(), '.aws', 'sso', 'cache')
}

function readProfileArn(): string | undefined {
  const candidates = [
    join(
      process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'),
      'Kiro',
      'User',
      'globalStorage',
      'kiro.kiroagent',
      'profile.json'
    )
  ]
  for (const p of candidates) {
    try {
      if (!existsSync(p)) continue
      const j = JSON.parse(readFileSync(p, 'utf8'))
      if (typeof j.arn === 'string' && j.arn) return j.arn
    } catch {
      // skip
    }
  }
}

export async function syncFromKiroIde(): Promise<void> {
  const tokenPath = join(cacheDir(), 'kiro-auth-token.json')
  if (!existsSync(tokenPath)) return
  try {
    const token = JSON.parse(readFileSync(tokenPath, 'utf8'))
    const refreshToken = token.refreshToken || token.refresh_token
    if (!refreshToken) return

    let clientId = token.clientId || token.client_id
    let clientSecret = token.clientSecret || token.client_secret
    if ((!clientId || !clientSecret) && token.clientIdHash) {
      const credPath = join(cacheDir(), `${token.clientIdHash}.json`)
      if (existsSync(credPath)) {
        const c = JSON.parse(readFileSync(credPath, 'utf8'))
        clientId = c.clientId || c.client_id
        clientSecret = c.clientSecret || c.client_secret
      }
    }
    if (!clientId || !clientSecret) return

    const profileArn = token.profileArn || token.profile_arn || readProfileArn()
    const oidcRegion = normalizeRegion(token.region)
    const serviceRegion = extractRegionFromArn(profileArn) || oidcRegion
    const email = makePlaceholderEmail('idc', serviceRegion, clientId, profileArn)
    const id = createDeterministicAccountId(email, 'idc', clientId, profileArn)
    const expiresAt = token.expiresAt ? new Date(token.expiresAt).getTime() : Date.now() + 3_600_000

    await kiroDb.upsertAccount({
      id,
      email,
      authMethod: 'idc',
      region: serviceRegion,
      oidcRegion,
      clientId,
      clientSecret,
      profileArn,
      refreshToken,
      accessToken: token.accessToken || token.access_token || '',
      expiresAt,
      rateLimitResetTime: 0,
      isHealthy: true,
      failCount: 0,
      lastSync: Date.now()
    })
  } catch (e) {
    logger.warn('Kiro IDE sync failed', e)
  }
}

export function writeToKiroIde(acc: {
  accessToken: string
  refreshToken: string
  expiresAt: number
}): void {
  const tokenPath = join(cacheDir(), 'kiro-auth-token.json')
  if (!existsSync(tokenPath)) return
  try {
    const token = JSON.parse(readFileSync(tokenPath, 'utf8'))
    token.accessToken = acc.accessToken
    token.refreshToken = acc.refreshToken
    token.expiresAt = new Date(acc.expiresAt).toISOString()
    writeFileSync(tokenPath, JSON.stringify(token, null, 2))
  } catch (e) {
    logger.warn('IDE write-back failed', e)
  }
}
