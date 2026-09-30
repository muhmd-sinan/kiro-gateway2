import { GenerateAssistantResponseCommand } from '@aws/codewhisperer-streaming-client'
import { describe, expect, test } from 'bun:test'
import { buildReasoningFields } from '../plugin/effort'
import { clearSdkClientCache, createSdkClient } from '../plugin/sdk-client'
import type { KiroAuthDetails } from '../plugin/types'

function auth(): KiroAuthDetails {
  return {
    refresh: 'refresh-token',
    access: 'access-token',
    expires: Date.now() + 3600000,
    authMethod: 'idc',
    region: 'us-east-1',
    email: 'user@example.com'
  }
}

async function captureRequest(client: ReturnType<typeof createSdkClient>) {
  let capturedRequest: any

  client.middlewareStack.add(
    () => async (args: any) => {
      capturedRequest = args.request
      throw new Error('captured-request')
    },
    { step: 'finalizeRequest', name: 'captureRequest', priority: 'high' }
  )

  const command = new GenerateAssistantResponseCommand({
    conversationState: {
      chatTriggerType: 'MANUAL',
      conversationId: 'test-conversation',
      currentMessage: {
        userInputMessage: {
          content: 'hello',
          modelId: 'claude-opus-5',
          origin: 'AI_EDITOR'
        }
      }
    }
  })

  await client.send(command).catch((error) => {
    if (error.message !== 'captured-request') throw error
  })

  const bodyText =
    typeof capturedRequest.body === 'string'
      ? capturedRequest.body
      : Buffer.from(capturedRequest.body).toString('utf8')

  return {
    body: JSON.parse(bodyText),
    request: { headers: capturedRequest.headers, bodyText }
  }
}

describe('SDK client', () => {
  test('uses Kiro CLI-style standard SDK retries for throttling', async () => {
    clearSdkClientCache()

    const client = createSdkClient(auth(), 'us-east-1')

    expect(await client.config.maxAttempts()).toBe(3)
    const retryMode = client.config.retryMode
    expect(typeof retryMode === 'function' ? await retryMode() : retryMode).toBe('standard')

    clearSdkClientCache()
  })

  test('injects reasoning fields before content-length is computed', async () => {
    // The field is spliced into the serialized body, so it has to land before
    // content-length is set or the request is rejected as malformed.
    clearSdkClientCache()

    const client = createSdkClient(auth(), 'us-east-1', {
      output_config: { effort: 'max' },
      thinking: { type: 'adaptive' }
    })
    const { body, request } = await captureRequest(client)

    expect(body.additionalModelRequestFields).toEqual({
      output_config: { effort: 'max' },
      thinking: { type: 'adaptive' }
    })
    expect(Number(request.headers['content-length'])).toBe(Buffer.byteLength(request.bodyText))

    clearSdkClientCache()
  })

  test('omits additionalModelRequestFields entirely when there are none', async () => {
    // Kiro rejects the key outright on models that take no reasoning fields, so
    // an empty object is not a safe substitute for omission.
    clearSdkClientCache()

    const client = createSdkClient(auth(), 'us-east-1')
    const { body } = await captureRequest(client)

    expect(body.additionalModelRequestFields).toBeUndefined()

    clearSdkClientCache()
  })

  test('sends the GPT reasoning.effort path verbatim', async () => {
    clearSdkClientCache()

    const client = createSdkClient(auth(), 'us-east-1', { reasoning: { effort: 'high' } })
    const { body } = await captureRequest(client)

    expect(body.additionalModelRequestFields).toEqual({ reasoning: { effort: 'high' } })

    clearSdkClientCache()
  })

  test('sends the thinking-disabled toggle verbatim', async () => {
    clearSdkClientCache()

    const client = createSdkClient(auth(), 'us-east-1', { thinking: { type: 'disabled' } })
    const { body } = await captureRequest(client)

    expect(body.additionalModelRequestFields).toEqual({ thinking: { type: 'disabled' } })

    clearSdkClientCache()
  })

  test('does not reuse a cached client across different reasoning payloads', () => {
    // Middleware is bound at construction, so a shared client would send the
    // wrong effort level.
    clearSdkClientCache()

    const max = createSdkClient(auth(), 'us-east-1', { output_config: { effort: 'max' } })
    const xhigh = createSdkClient(auth(), 'us-east-1', { output_config: { effort: 'xhigh' } })
    const maxAgain = createSdkClient(auth(), 'us-east-1', { output_config: { effort: 'max' } })

    expect(xhigh).not.toBe(max)
    expect(maxAgain).toBe(max)

    clearSdkClientCache()
  })

  test('treats reasoning payloads as equal regardless of key order', () => {
    clearSdkClientCache()

    const a = createSdkClient(auth(), 'us-east-1', {
      output_config: { effort: 'high' },
      thinking: { type: 'adaptive' }
    })
    const b = createSdkClient(auth(), 'us-east-1', {
      thinking: { type: 'adaptive' },
      output_config: { effort: 'high' }
    })

    expect(b).toBe(a)

    clearSdkClientCache()
  })

  test('end-to-end: buildReasoningFields output reaches the wire body', async () => {
    // Guards the seam between capability resolution and serialization, which is
    // where a wrong effort path would surface as a 400 at runtime.
    clearSdkClientCache()

    const fields = buildReasoningFields('claude-opus-5', true, 'xhigh')
    const client = createSdkClient(auth(), 'us-east-1', fields)
    const { body } = await captureRequest(client)

    expect(body.additionalModelRequestFields.output_config.effort).toBe('xhigh')

    clearSdkClientCache()
  })
})
