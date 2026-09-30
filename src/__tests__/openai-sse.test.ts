import { describe, expect, test } from 'bun:test'
import type { StreamEvent } from '../plugin/streaming/types.js'
import { collectOpenAICompletion, createOpenAISerializer } from '../server/openai-sse.js'

function dataOf(frames: string[]): Array<Record<string, any> | string> {
  return frames.map((frame) => {
    const payload = frame.slice('data: '.length).trimEnd()
    return payload === '[DONE]' ? '[DONE]' : JSON.parse(payload)
  })
}

async function* streamOf(events: StreamEvent[]): AsyncGenerator<StreamEvent> {
  for (const event of events) yield event
}

const ID = 'chatcmpl-1'
const MODEL = 'claude-opus-5'

describe('openai SSE serializer', () => {
  test('holds usage back for a choiceless final chunk', () => {
    // Hermes sets stream_options.include_usage and looks for usage on a chunk
    // with empty choices, treating it as proof the provider finished cleanly.
    const s = createOpenAISerializer(ID, MODEL, { includeUsage: true })

    const finishFrames = dataOf(
      s.serialize({
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: { input_tokens: 12, output_tokens: 4 }
      })
    )
    expect((finishFrames[0] as any).choices[0].finish_reason).toBe('stop')
    expect((finishFrames[0] as any).usage).toBeUndefined()

    const tail = dataOf(s.finish())
    expect((tail[0] as any).choices).toEqual([])
    expect((tail[0] as any).usage).toEqual({
      prompt_tokens: 12,
      completion_tokens: 4,
      total_tokens: 16
    })
    expect(tail[1]).toBe('[DONE]')
  })

  test('omits the usage chunk when include_usage is off', () => {
    const s = createOpenAISerializer(ID, MODEL, { includeUsage: false })
    expect(dataOf(s.finish())).toEqual(['[DONE]'])
  })

  test('still emits a usage chunk when upstream reported none', () => {
    // Absent usage would read as an incomplete stream to Hermes.
    const s = createOpenAISerializer(ID, MODEL, { includeUsage: true })
    const tail = dataOf(s.finish())
    expect((tail[0] as any).usage).toEqual({
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0
    })
  })

  test('always terminates with the [DONE] sentinel', () => {
    const s = createOpenAISerializer(ID, MODEL, { includeUsage: true })
    const tail = s.finish()
    expect(tail[tail.length - 1]).toBe('data: [DONE]\n\n')
  })

  test('drops Anthropic-only events that OpenAI clients cannot parse', () => {
    const s = createOpenAISerializer(ID, MODEL, { includeUsage: true })
    expect(s.serialize({ type: 'message_start', message: {} })).toEqual([])
    expect(s.serialize({ type: 'content_block_stop', index: 0 })).toEqual([])
    expect(s.serialize({ type: 'message_stop' })).toEqual([])
  })

  test('routes reasoning to reasoning_content, not content', () => {
    const s = createOpenAISerializer(ID, MODEL, { includeUsage: true })
    const frames = dataOf(
      s.serialize({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: 'thinking out loud' }
      })
    )
    expect((frames[0] as any).choices[0].delta).toEqual({
      reasoning_content: 'thinking out loud'
    })
  })
})

describe('collectOpenAICompletion', () => {
  test('assembles content, reasoning, and tool calls', async () => {
    const completion: any = await collectOpenAICompletion(
      streamOf([
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'thinking', thinking: '' }
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'thinking_delta', thinking: 'why' }
        },
        { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Answer' } },
        {
          type: 'content_block_start',
          index: 2,
          content_block: { type: 'tool_use', id: 't1', name: 'Bash', input: {} }
        },
        {
          type: 'content_block_delta',
          index: 2,
          delta: { type: 'input_json_delta', partial_json: '{"command":"ls"}' }
        },
        {
          type: 'message_delta',
          delta: { stop_reason: 'tool_use' },
          usage: { input_tokens: 9, output_tokens: 2 }
        }
      ]),
      ID,
      MODEL
    )

    const message = completion.choices[0].message
    expect(message.content).toBe('Answer')
    expect(message.reasoning_content).toBe('why')
    expect(message.tool_calls).toEqual([
      { id: 't1', type: 'function', function: { name: 'Bash', arguments: '{"command":"ls"}' } }
    ])
    expect(completion.choices[0].finish_reason).toBe('tool_calls')
    expect(completion.usage).toEqual({
      prompt_tokens: 9,
      completion_tokens: 2,
      total_tokens: 11
    })
  })

  test('keeps arguments a non-empty JSON string when upstream sent nothing', async () => {
    // An empty arguments string breaks strict OpenAI client parsers.
    const completion: any = await collectOpenAICompletion(
      streamOf([
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 't1', name: 'NoArgs', input: {} }
        }
      ]),
      ID,
      MODEL
    )
    expect(completion.choices[0].message.tool_calls[0].function.arguments).toBe('{}')
  })

  test('omits reasoning_content entirely when there was no reasoning', async () => {
    const completion: any = await collectOpenAICompletion(
      streamOf([
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } }
      ]),
      ID,
      MODEL
    )
    expect('reasoning_content' in completion.choices[0].message).toBe(false)
  })

  test('preserves tool call order across interleaved indices', async () => {
    const completion: any = await collectOpenAICompletion(
      streamOf([
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'a', name: 'First', input: {} }
        },
        {
          type: 'content_block_start',
          index: 1,
          content_block: { type: 'tool_use', id: 'b', name: 'Second', input: {} }
        },
        {
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'input_json_delta', partial_json: '{"n":2}' }
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '{"n":1}' }
        }
      ]),
      ID,
      MODEL
    )
    const calls = completion.choices[0].message.tool_calls
    expect(calls.map((c: any) => c.id)).toEqual(['a', 'b'])
    expect(calls[0].function.arguments).toBe('{"n":1}')
    expect(calls[1].function.arguments).toBe('{"n":2}')
  })

  test('defaults to stop with zeroed usage on an empty stream', async () => {
    const completion: any = await collectOpenAICompletion(streamOf([]), ID, MODEL)
    expect(completion.choices[0].finish_reason).toBe('stop')
    expect(completion.choices[0].message.content).toBe('')
    expect(completion.usage.total_tokens).toBe(0)
  })
})
