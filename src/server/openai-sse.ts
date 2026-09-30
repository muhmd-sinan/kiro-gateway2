import type { StreamEvent } from '../plugin/streaming/index.js'
import { convertToOpenAI } from '../plugin/streaming/openai-converter.js'

/**
 * OpenAI chat-completions SSE serializer for the proxy.
 *
 * Wraps the shared `convertToOpenAI` mapper and adds the two things a real HTTP
 * surface needs that the in-process OpenCode path does not:
 *
 * 1. `stream_options.include_usage` semantics. Hermes sets this on every
 *    streaming request and expects usage on a *final chunk with empty choices*,
 *    treating its presence as proof the provider finished cleanly. The shared
 *    mapper attaches usage to the same chunk as `finish_reason`, so usage is
 *    split back out here.
 * 2. The terminating `data: [DONE]` sentinel.
 */

export interface OpenAIStreamOptions {
  /** Emit a trailing usage-only chunk (stream_options.include_usage). */
  includeUsage: boolean
}

interface UsagePayload {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
}

export function createOpenAISerializer(
  id: string,
  model: string,
  options: OpenAIStreamOptions
): {
  serialize: (event: StreamEvent) => string[]
  finish: () => string[]
} {
  let pendingUsage: UsagePayload | null = null

  const frame = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`

  return {
    serialize(event: StreamEvent): string[] {
      const chunk = convertToOpenAI(event, id, model)
      if (chunk === null) return []

      // convertToOpenAI puts usage on the finish_reason chunk. Hermes looks for
      // it on a choiceless chunk, so hold it back and emit it separately.
      if (chunk.usage) {
        pendingUsage = chunk.usage
        delete chunk.usage
      }

      return [frame(chunk)]
    },

    finish(): string[] {
      const frames: string[] = []
      if (options.includeUsage) {
        frames.push(
          frame({
            id,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [],
            usage: pendingUsage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
          })
        )
      }
      frames.push('data: [DONE]\n\n')
      return frames
    }
  }
}

/**
 * Accumulate the event stream into a single non-streaming chat completion.
 *
 * Reachable when a client sends `stream: false` — Hermes exposes
 * `model.streaming: false` as the documented escape hatch for servers whose
 * streaming tool-call path misbehaves, so this needs to produce identical
 * content to the streamed path.
 */
export async function collectOpenAICompletion(
  events: AsyncIterable<StreamEvent>,
  id: string,
  model: string
): Promise<Record<string, unknown>> {
  let content = ''
  let reasoning = ''
  const toolCalls: Array<{ id: string; name: string; args: string }> = []
  const toolIndex = new Map<number, number>()
  let finishReason = 'stop'
  let usage: UsagePayload = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }

  for await (const event of events) {
    if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
      toolIndex.set(event.index as number, toolCalls.length)
      toolCalls.push({ id: event.content_block.id, name: event.content_block.name, args: '' })
    } else if (event.type === 'content_block_delta') {
      const delta = event.delta ?? {}
      if (delta.type === 'text_delta') content += delta.text || ''
      else if (delta.type === 'thinking_delta') reasoning += delta.thinking || ''
      else if (delta.type === 'input_json_delta') {
        const slot = toolIndex.get(event.index as number)
        if (slot !== undefined) toolCalls[slot]!.args += delta.partial_json || ''
      }
    } else if (event.type === 'message_delta') {
      finishReason = event.delta?.stop_reason === 'tool_use' ? 'tool_calls' : 'stop'
      const input = event.usage?.input_tokens || 0
      const output = event.usage?.output_tokens || 0
      usage = { prompt_tokens: input, completion_tokens: output, total_tokens: input + output }
    }
  }

  const message: Record<string, unknown> = { role: 'assistant', content }
  if (reasoning) message.reasoning_content = reasoning
  if (toolCalls.length > 0) {
    message.tool_calls = toolCalls.map((tc) => ({
      id: tc.id,
      type: 'function',
      function: { name: tc.name, arguments: tc.args || '{}' }
    }))
  }

  return {
    id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: finishReason }],
    usage
  }
}
