import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const TOKEN_PATH = join(homedir(), '.aws', 'sso', 'cache', 'kiro-auth-token.json')
const PROFILE_ARN = 'arn:aws:codewhisperer:us-east-1:082688269627:profile/RNECRRMWYA7R'
const MODEL = process.argv[2] || 'qwen3-coder-next'

function loadToken() {
  const token = JSON.parse(readFileSync(TOKEN_PATH, 'utf8'))
  const credPath = join(homedir(), '.aws', 'sso', 'cache', `${token.clientIdHash}.json`)
  const creds = existsSync(credPath) ? JSON.parse(readFileSync(credPath, 'utf8')) : {}
  return { token, creds }
}

const { refreshAccessToken } = await import(pathToFileURL(join(import.meta.dirname, '../dist/plugin/token.js')).href)
const { createSdkClient } = await import(pathToFileURL(join(import.meta.dirname, '../dist/plugin/sdk-client.js')).href)
const { GenerateAssistantResponseCommand } = await import('@aws/codewhisperer-streaming-client')
const { encodeRefreshToken } = await import(pathToFileURL(join(import.meta.dirname, '../dist/kiro/auth.js')).href)
const { randomUUID } = await import('node:crypto')

const { token, creds } = loadToken()
if (!creds.clientId) throw new Error('missing IDE client registration')

const auth = {
  refresh: encodeRefreshToken({
    refreshToken: token.refreshToken,
    clientId: creds.clientId,
    clientSecret: creds.clientSecret,
    authMethod: 'idc'
  }),
  access: token.accessToken,
  expires: Date.parse(token.expiresAt) || 0,
  authMethod: 'idc',
  region: 'us-east-1',
  oidcRegion: 'us-east-1',
  profileArn: PROFILE_ARN,
  clientId: creds.clientId,
  clientSecret: creds.clientSecret
}

const fresh = await refreshAccessToken(auth)
token.accessToken = fresh.access
token.refreshToken = fresh.refresh.split('|')[0]
token.expiresAt = new Date(fresh.expires).toISOString()
writeFileSync(TOKEN_PATH, JSON.stringify(token, null, 2))
console.log('auth ok', { expiresAt: token.expiresAt, store: 'ide' })

const client = createSdkClient(fresh, 'us-east-1')
const out = await client.send(
  new GenerateAssistantResponseCommand({
    conversationState: {
      chatTriggerType: 'MANUAL',
      conversationId: randomUUID(),
      currentMessage: {
        userInputMessage: {
          content: 'Reply with exactly: pong',
          modelId: MODEL,
          origin: 'AI_EDITOR'
        }
      }
    },
    profileArn: PROFILE_ARN
  })
)

let reply = ''
if (out.generateAssistantResponseResponse) {
  for await (const ev of out.generateAssistantResponseResponse) {
    const t = ev.assistantResponseEvent?.content || ev.content || ''
    if (t) reply += t
  }
}
console.log('model', MODEL)
console.log('reply', reply || JSON.stringify(out, null, 2).slice(0, 500))
