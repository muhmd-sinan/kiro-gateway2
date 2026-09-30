import { CodeWhispererStreamingClient } from '@aws/codewhisperer-streaming-client'
import { KIRO_CONSTANTS } from '../constants.js'
import type { KiroAuthDetails } from './types'

/**
 * Cache key includes the reasoning payload: middleware is bound at client
 * creation time, so two requests with different reasoning fields cannot share a
 * client.
 */
interface ClientCacheEntry {
  client: CodeWhispererStreamingClient
  token: string
  reasoningKey: string
}

const clientCache = new Map<string, ClientCacheEntry>()
const KIRO_CLI_MAX_ATTEMPTS = 3

export function createSdkClient(
  auth: KiroAuthDetails,
  region: string,
  reasoningFields?: Record<string, unknown>
): CodeWhispererStreamingClient {
  // Stable regardless of key order, so equivalent payloads reuse one client.
  const reasoningKey = reasoningFields ? JSON.stringify(sortKeys(reasoningFields)) : 'none'
  const cacheKey = `${region}:${auth.email || 'default'}:${reasoningKey}`
  const cached = clientCache.get(cacheKey)

  if (cached && cached.token === auth.access && cached.reasoningKey === reasoningKey) {
    return cached.client
  }

  const token = auth.access
  const client = new CodeWhispererStreamingClient({
    region,
    endpoint: `https://q.${region}.amazonaws.com`,
    token: () => Promise.resolve({ token }),
    maxAttempts: KIRO_CLI_MAX_ATTEMPTS,
    retryMode: 'standard',
    customUserAgent: [[KIRO_CONSTANTS.USER_AGENT]]
  })

  // Add Kiro-specific headers
  client.middlewareStack.add(
    (next: any) => async (args: any) => {
      args.request.headers['x-amzn-kiro-agent-mode'] = 'vibe'
      return next(args)
    },
    { step: 'build', name: 'addKiroHeaders' }
  )

  // Inject reasoning controls (effort level, thinking toggle).
  //
  // The AWS SDK's generated serializer drops fields absent from its model, so
  // additionalModelRequestFields has to be spliced into the serialized body
  // rather than passed as command input. Kiro validates the payload against a
  // per-model schema and returns 400 on a mismatch, so the shape is built by
  // buildReasoningFields rather than assembled here.
  if (reasoningFields) {
    client.middlewareStack.add(
      (next: any) => async (args: any) => {
        if (args.request?.body) {
          try {
            const body = JSON.parse(args.request.body)
            body.additionalModelRequestFields = reasoningFields
            args.request.body = JSON.stringify(body)
          } catch {
            // Never fail a request over the reasoning hint; a malformed body
            // here would be a bug elsewhere, and the request still works
            // without the field.
          }
        }
        return next(args)
      },
      { step: 'build', name: 'addReasoningConfig', priority: 'high' }
    )
  }

  clientCache.set(cacheKey, { client, token, reasoningKey })
  return client
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((k) => [k, sortKeys((value as Record<string, unknown>)[k])])
    )
  }
  return value
}

export function clearSdkClientCache(): void {
  for (const entry of clientCache.values()) {
    entry.client.destroy()
  }
  clientCache.clear()
}
