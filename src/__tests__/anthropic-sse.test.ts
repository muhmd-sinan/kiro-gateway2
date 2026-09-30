import { describe, expect, test } from 'bun:test'
import {
  collectAnthropicMessage,
  createAnthropicSerializer
} from '../plugin/streaming/anthropic-sse.js'
import type { StreamEvent } from '../plugin/streaming/types.js'

function parse(frames: string[]): Array<Record<string, any>> {
  return frames.map((frame) => {
    const line = frame.split('\n').find((l) => l.startsWith('data: '))!
    return JSON.parse(line.slice(6))
  })
}

function serializeAll(events: StreamEvent[]): Array<Record<string, any>> {
  const serialize = createAnthropicSerializer()
  return parse(events.flatMap((event) => serialize(event)))
}

async function* streamOf(events: StreamEvent[]): AsyncGenerator<StreamEvent> {
  for (const event of events) yield event
}

describe('anthropic SSE serializer', () => {
  test('emits the event name in the SSE frame, not just the JSON type', () => {
    const serialize = createAnthropicSerializer()
    const [frame] = serialize({ type: 'message_stop' })
    // Claude Code reads the `event:` line; a bare data frame is not enough.
    expect(frame).toBe('event: message_stop\ndata: {"type":"message_stop"}\n\n')
  })

  test('injects exactly one signature_delta before a thinking block closes', () => {
    // Anthropic's spec requires a signature_delta immediately before
    // content_block_stop on thinking blocks.
    const events: StreamEvent[] = [
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hmm' } },
      { type: 'content_block_stop', index: 0 }
    ]

    const parsed = serializeAll(events)
    const types = parsed.map((p) => (p.type === 'content_block_delta' ? p.delta.type : p.type))

    expect(types).toEqual([
      'content_block_start',
      'thinking_delta',
      'signature_delta',
      'content_block_stop'
    ])
    expect(parsed[2]!.delta.signature.length).toBeGreaterThan(0)
  })

  test('does not add a signature to text blocks', () => {
    const parsed = serializeAll([
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } },
      { type: 'content_block_stop', index: 0 }
    ])
    expect(parsed.some((p) => p.delta?.type === 'signature_delta')).toBe(false)
  })

  test('opens thinking blocks with an empty signature field', () => {
    const [frame] = createAnthropicSerializer()({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'thinking', thinking: '' }
    })
    expect(parse([frame!])[0]!.content_block).toEqual({
      type: 'thinking',
      thinking: '',
      signature: ''
    })
  })

  test('drops empty deltas used internally as block terminators', () => {
    // The OpenAI path emits an empty thinking_delta as a marker; Anthropic has
    // no equivalent and clients would render an empty block.
    const serialize = createAnthropicSerializer()
    expect(
      serialize({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: '' }
      })
    ).toEqual([])
    expect(
      serialize({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '' } })
    ).toEqual([])
  })

  test('streams tool calls as tool_use blocks with input_json_delta', () => {
    const parsed = serializeAll([
      {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: {} }
      },
      {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'input_json_delta', partial_json: '{"command":"ls"}' }
      },
      { type: 'content_block_stop', index: 1 }
    ])

    expect(parsed[0]!.content_block).toEqual({
      type: 'tool_use',
      id: 'toolu_1',
      name: 'Bash',
      input: {}
    })
    expect(parsed[1]!.delta.partial_json).toBe('{"command":"ls"}')
  })

  test('carries stop_reason and usage on message_delta', () => {
    const parsed = serializeAll([
      {
        type: 'message_delta',
        delta: { stop_reason: 'tool_use', stop_sequence: null },
        usage: { input_tokens: 10, output_tokens: 5 }
      }
    ])
    expect(parsed[0]!.delta.stop_reason).toBe('tool_use')
    expect(parsed[0]!.usage).toEqual({ input_tokens: 10, output_tokens: 5 })
  })

  test('always supplies a usage object so clients never read undefined', () => {
    const parsed = serializeAll([{ type: 'message_delta', delta: { stop_reason: 'end_turn' } }])
    expect(parsed[0]!.usage).toEqual({ input_tokens: 0, output_tokens: 0 })
  })
})

describe('collectAnthropicMessage', () => {
  test('assembles text, thinking, and tool_use blocks in stream order', async () => {
    const message = await collectAnthropicMessage(
      streamOf([
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'thinking', thinking: '' }
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'thinking_delta', thinking: 'reasoning' }
        },
        { type: 'content_block_stop', index: 0 },
        { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Hello' } },
        { type: 'content_block_stop', index: 1 },
        {
          type: 'content_block_start',
          index: 2,
          content_block: { type: 'tool_use', id: 'toolu_1', name: 'Read', input: {} }
        },
        {
          type: 'content_block_delta',
          index: 2,
          delta: { type: 'input_json_delta', partial_json: '{"path":"a.ts"}' }
        },
        { type: 'content_block_stop', index: 2 },
        {
          type: 'message_delta',
          delta: { stop_reason: 'tool_use' },
          usage: { input_tokens: 7, output_tokens: 3 }
        },
        { type: 'message_stop' }
      ]),
      'msg_1',
      'claude-opus-5'
    )

    expect(message.content.map((b) => b.type)).toEqual(['thinking', 'text', 'tool_use'])
    expect(message.stop_reason).toBe('tool_use')
    expect(message.usage.input_tokens).toBe(7)
    // tool_use.input must be a parsed object, unlike the streamed partial_json.
    expect(message.content[2]!.input).toEqual({ path: 'a.ts' })
  })

  test('accumulates fragmented tool arguments before parsing', async () => {
    const message = await collectAnthropicMessage(
      streamOf([
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 't1', name: 'Grep', input: {} }
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '{"pat' }
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: 'tern":"x"}' }
        },
        { type: 'content_block_stop', index: 0 }
      ]),
      'msg_2',
      'claude-opus-5'
    )
    expect(message.content[0]!.input).toEqual({ pattern: 'x' })
  })

  test('falls back to an empty object when tool arguments are unparseable', async () => {
    const message = await collectAnthropicMessage(
      streamOf([
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 't1', name: 'Bad', input: {} }
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: 'not json' }
        }
      ]),
      'msg_3',
      'claude-opus-5'
    )
    expect(message.content[0]!.input).toEqual({})
  })

  test('drops empty text blocks, which Anthropic rejects', async () => {
    const message = await collectAnthropicMessage(
      streamOf([
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_stop', index: 0 },
        {
          type: 'content_block_start',
          index: 1,
          content_block: { type: 'tool_use', id: 't1', name: 'Bash', input: {} }
        },
        {
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'input_json_delta', partial_json: '{}' }
        }
      ]),
      'msg_4',
      'claude-opus-5'
    )
    expect(message.content.map((b) => b.type)).toEqual(['tool_use'])
  })

  test('never returns a zero-block message', async () => {
    // An empty content array risks a client-side parse failure on an empty turn.
    const message = await collectAnthropicMessage(
      streamOf([{ type: 'message_stop' }]),
      'msg_5',
      'auto'
    )
    expect(message.content).toEqual([{ type: 'text', text: '' }])
    expect(message.stop_reason).toBe('end_turn')
  })

  test('reports all four usage counters so /context renders', async () => {
    const message = await collectAnthropicMessage(streamOf([]), 'msg_6', 'auto')
    expect(message.usage).toEqual({
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0
    })
  })
})
