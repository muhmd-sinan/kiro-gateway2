import { randomBytes } from 'node:crypto'
import type { StreamEvent } from './types.js'

/**
 * Anthropic Messages API SSE serializer.
 *
 * Claude Code only speaks the Anthropic wire protocol, so this renders the
 * normalized `StreamEvent` stream (see sdk-stream-transformer.ts) as the
 * documented event sequence:
 *
 *   message_start
 *     → content_block_start / content_block_delta* / content_block_stop  (per block)
 *     → message_delta (stop_reason + cumulative usage)
 *     → message_stop
 *
 * Two details the raw events don't carry are filled in here:
 *
 * 1. Thinking blocks must emit exactly one `signature_delta` immediately before
 *    `content_block_stop`. Upstream Kiro gives us no signature, so a synthetic
 *    one is generated. That is safe because this proxy is the only consumer of
 *    replayed thinking blocks and never validates the signature — the history
 *    builder flattens them to `<thinking>` text.
 * 2. `ping` events, emitted by the caller during long silences. Claude Code
 *    aborts a stream that produces no bytes for 300s, and Kiro can pause that
 *    long while reasoning.
 */

const SSE_RETRY_PING = 'event: ping\ndata: {"type":"ping"}\n\n'

export function anthropicPing(): string {
  return SSE_RETRY_PING
}

function frame(type: string, payload: Record<string, unknown>): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`
}

/** Opaque, stable-per-block placeholder standing in for Anthropic's signature. */
function syntheticSignature(): string {
  return randomBytes(48).toString('base64')
}

/**
 * Fresh `msg_`-prefixed message id.
 *
 * The transformer puts the Kiro `conversationId` in `message_start.message.id`,
 * but that id is stable for the whole chat by design (see session-map.ts), so
 * every assistant turn reported the same id and it carried no `msg_` prefix.
 * Anthropic ids are unique per message, and clients are entitled to key on them.
 */
export function newMessageId(): string {
  return `msg_${randomBytes(12).toString('hex')}`
}

/**
 * Convert normalized stream events into Anthropic SSE frames.
 *
 * Stateful: tracks which block indices are thinking blocks so the required
 * signature_delta can be injected before their content_block_stop.
 */
export function createAnthropicSerializer(): (event: StreamEvent) => string[] {
  const thinkingBlocks = new Set<number>()
  const messageId = newMessageId()

  return (event: StreamEvent): string[] => {
    switch (event.type) {
      case 'message_start':
        return [frame('message_start', { message: { ...event.message, id: messageId } })]

      case 'content_block_start': {
        const block = event.content_block ?? {}
        if (block.type === 'thinking' && typeof event.index === 'number') {
          thinkingBlocks.add(event.index)
          return [
            frame('content_block_start', {
              index: event.index,
              content_block: { type: 'thinking', thinking: '', signature: '' }
            })
          ]
        }
        return [frame('content_block_start', { index: event.index, content_block: block })]
      }

      case 'content_block_delta': {
        // Anthropic has no empty-delta concept; the OpenAI path uses an empty
        // thinking_delta as a block terminator marker, so drop those here.
        const delta = event.delta ?? {}
        if (delta.type === 'thinking_delta' && !delta.thinking) return []
        if (delta.type === 'text_delta' && !delta.text) return []
        return [frame('content_block_delta', { index: event.index, delta })]
      }

      case 'content_block_stop': {
        const frames: string[] = []
        if (typeof event.index === 'number' && thinkingBlocks.has(event.index)) {
          frames.push(
            frame('content_block_delta', {
              index: event.index,
              delta: { type: 'signature_delta', signature: syntheticSignature() }
            })
          )
        }
        frames.push(frame('content_block_stop', { index: event.index }))
        return frames
      }

      case 'message_delta':
        return [
          frame('message_delta', {
            delta: event.delta ?? {},
            usage: event.usage ?? { input_tokens: 0, output_tokens: 0 }
          })
        ]

      case 'message_stop':
        return [frame('message_stop', {})]

      default:
        return []
    }
  }
}

/**
 * Non-streaming `/v1/messages` response body.
 *
 * Claude Code streams by default, but `stream: false` is legal and the
 * count_tokens-less fallback path can use it, so accumulate the same events
 * into a single message object.
 */
export interface AnthropicMessageResult {
  id: string
  type: 'message'
  role: 'assistant'
  model: string
  content: Array<Record<string, unknown>>
  stop_reason: string
  stop_sequence: string | null
  usage: {
    input_tokens: number
    output_tokens: number
    cache_creation_input_tokens: number
    cache_read_input_tokens: number
  }
}

export async function collectAnthropicMessage(
  events: AsyncIterable<StreamEvent>,
  id: string,
  model: string
): Promise<AnthropicMessageResult> {
  const blocks = new Map<number, Record<string, any>>()
  const order: number[] = []
  let stopReason = 'end_turn'
  let usage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0
  }

  for await (const event of events) {
    if (event.type === 'content_block_start' && typeof event.index === 'number') {
      const block = { ...(event.content_block ?? {}) }
      if (block.type === 'tool_use' || block.type === 'server_tool_use') block.input = ''
      blocks.set(event.index, block)
      order.push(event.index)
    } else if (event.type === 'content_block_delta' && typeof event.index === 'number') {
      const block = blocks.get(event.index)
      if (!block) continue
      const delta = event.delta ?? {}
      if (delta.type === 'text_delta') block.text = (block.text || '') + (delta.text || '')
      else if (delta.type === 'thinking_delta')
        block.thinking = (block.thinking || '') + (delta.thinking || '')
      else if (delta.type === 'input_json_delta')
        block.input = (block.input || '') + (delta.partial_json || '')
    } else if (event.type === 'message_delta') {
      if (event.delta?.stop_reason) stopReason = event.delta.stop_reason
      if (event.usage) usage = { ...usage, ...event.usage }
    }
  }

  const content = order
    .map((index) => blocks.get(index))
    .filter((block): block is Record<string, any> => !!block)
    .map((block) => {
      if (block.type === 'tool_use' || block.type === 'server_tool_use') {
        let input: unknown = {}
        try {
          input = block.input ? JSON.parse(block.input) : {}
        } catch {
          input = {}
        }
        return { type: block.type, id: block.id, name: block.name, input }
      }
      if (block.type === 'thinking') {
        return { type: 'thinking', thinking: block.thinking || '', signature: syntheticSignature() }
      }
      // Server-tool results carry their payload on the opening event and have no
      // deltas, so they pass through as-is. Collapsing them to text here would
      // silently drop every web-search result on a non-streaming request.
      if (block.type === 'web_search_tool_result') return block
      return { type: 'text', text: block.text || '' }
    })
    // Anthropic rejects zero-length text blocks; drop them rather than risk a
    // client-side parse of an empty turn.
    .filter((block) => block.type !== 'text' || (block as any).text.length > 0)

  return {
    id,
    type: 'message',
    role: 'assistant',
    model,
    content: content.length > 0 ? content : [{ type: 'text', text: '' }],
    stop_reason: stopReason,
    stop_sequence: null,
    usage
  }
}
