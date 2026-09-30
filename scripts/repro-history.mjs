import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'

const TOKEN_PATH = join(homedir(), '.aws', 'sso', 'cache', 'kiro-auth-token.json')
const PROFILE_ARN = 'arn:aws:codewhisperer:us-east-1:082688269627:profile/RNECRRMWYA7R'
const token = JSON.parse(readFileSync(TOKEN_PATH, 'utf8'))
const creds = JSON.parse(readFileSync(join(homedir(), '.aws', 'sso', 'cache', `${token.clientIdHash}.json`), 'utf8'))
const { refreshAccessToken } = await import(pathToFileURL(join(import.meta.dirname, '../dist/plugin/token.js')).href)
const { createSdkClient } = await import(pathToFileURL(join(import.meta.dirname, '../dist/plugin/sdk-client.js')).href)
const { GenerateAssistantResponseCommand } = await import('@aws/codewhisperer-streaming-client')
const { encodeRefreshToken } = await import(pathToFileURL(join(import.meta.dirname, '../dist/kiro/auth.js')).href)

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
const client = createSdkClient(fresh, 'us-east-1')
try {
  const out = await client.send(
    new GenerateAssistantResponseCommand({
      conversationState: {
        chatTriggerType: 'MANUAL',
        conversationId: randomUUID(),
        history: [
          {
            userInputMessage: {
              content: 'You are a title generator.',
              modelId: 'claude-opus-5',
              origin: 'AI_EDITOR'
            }
          },
          { assistantResponseMessage: { content: '[system: conversation continues]' } }
        ],
        currentMessage: {
          userInputMessage: {
            content: 'Generate a title for this conversation:\n\nhi',
            modelId: 'claude-opus-5',
            origin: 'AI_EDITOR'
          }
        }
      },
      profileArn: PROFILE_ARN
    })
  )
  let reply = ''
  for await (const ev of out.generateAssistantResponseResponse) {
    const t = ev.assistantResponseEvent?.content || ev.content || ''
    if (t) reply += t
  }
  console.log('OK', reply.slice(0, 80))
} catch (e) {
  console.log('FAIL', e.name, e.message)
}
