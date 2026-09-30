import { describe, expect, test } from 'bun:test'
import {
  buildHistory,
  collapseAgenticLoops
} from '../infrastructure/transformers/history-builder.js'
import {
  mergeAdjacentMessages,
  parseToolArguments
} from '../infrastructure/transformers/message-transformer.js'
import type { StreamEvent } from '../plugin/streaming/types.js'
import { estimateInputTokens, startProxyServer } from '../server/http.js'
import { withTimingLog } from '../server/runtime.js'

const TIMING = { queueMs: 0, responseStartMs: 0 }
const PNG = 'iVBORw0KGgo'.padEnd(4000, 'A')

async function* streamOf(events: StreamEvent[]): AsyncGenerator<StreamEvent> {
  for (const event of events) yield event
}

describe('mergeAdjacentMessages', () => {
  test('does not mutate the caller’s messages, so rebuilds stay idempotent', () => {
    // Retries and web-search iterations rebuild from the same body. Mutating it
    // used to append the neighbour's blocks again on every rebuild.
    const msgs = [
      { role: 'user', content: [{ type: 'text', text: 'a' }] },
      { role: 'user', content: [{ type: 'text', text: 'b' }] }
    ]
    const first = mergeAdjacentMessages(msgs)
    const second = mergeAdjacentMessages(msgs)
    expect(msgs[0]!.content).toHaveLength(1)
    expect(first[0].content).toHaveLength(2)
    expect(second[0].content).toHaveLength(2)
  })

  test('does not mutate tool_calls either', () => {
    const msgs = [
      { role: 'assistant', content: 'x', tool_calls: [{ id: '1' }] },
      { role: 'assistant', content: 'y', tool_calls: [{ id: '2' }] }
    ]
    mergeAdjacentMessages(msgs)
    mergeAdjacentMessages(msgs)
    expect(msgs[0]!.tool_calls).toHaveLength(1)
  })
})

describe('parseToolArguments', () => {
  test('parses valid JSON', () => {
    expect(parseToolArguments('{"a":1}')).toEqual({ a: 1 })
  })

  test('returns {} for malformed or empty input instead of throwing', () => {
    expect(parseToolArguments('{"a":')).toEqual({})
    expect(parseToolArguments('')).toEqual({})
    expect(parseToolArguments(undefined)).toEqual({})
  })

  test('passes already-parsed objects through', () => {
    expect(parseToolArguments({ a: 1 })).toEqual({ a: 1 })
  })

  test('a malformed argument in history no longer fails the build', () => {
    const msgs = [
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 't1', function: { name: 'Bash', arguments: '{"cmd":' } }]
      },
      { role: 'tool', tool_call_id: 't1', content: 'ok' },
      { role: 'user', content: 'next' }
    ]
    expect(() => buildHistory(msgs, 'claude-opus-5')).not.toThrow()
  })
})

describe('estimateInputTokens', () => {
  test('counts an image as a flat estimate, not as its base64 length', () => {
    const big = 'A'.repeat(800_000)
    const tokens = estimateInputTokens({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'look' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: big } }
          ]
        }
      ]
    })
    // The old estimate would have been ~200k.
    expect(tokens).toBeLessThan(2000)
    expect(tokens).toBeGreaterThan(1600)
  })

  test('still counts text', () => {
    const tokens = estimateInputTokens({ messages: [{ role: 'user', content: 'x'.repeat(4000) }] })
    expect(tokens).toBeGreaterThan(1000)
  })
})

describe('collapseAgenticLoops', () => {
  const loop = (texts: string[]) =>
    texts.flatMap((text, i) => [
      { assistantResponseMessage: { content: text, toolUses: [{ toolUseId: `t${i}` }] } },
      {
        userInputMessage: {
          content: 'r',
          userInputMessageContext: { toolResults: [{ toolUseId: `t${i}` }] }
        }
      }
    ]) as any[]

  test('default still replaces intermediate text (OpenCode path unchanged)', () => {
    const out: any[] = collapseAgenticLoops(loop(['plan', 'step two', 'step three']))
    expect(out[2].assistantResponseMessage.content).toBe('[system: tool calling continues]')
  })

  test('preserveLoopText keeps distinct reasoning, collapses repeats and empties', () => {
    const out: any[] = collapseAgenticLoops(loop(['plan', 'step two', 'plan', '']), true)
    expect(out[2].assistantResponseMessage.content).toBe('step two')
    expect(out[4].assistantResponseMessage.content).toBe('[system: tool calling continues]')
    expect(out[6].assistantResponseMessage.content).toBe('[system: tool calling continues]')
  })
})

describe('buildHistory image retention', () => {
  const imageTurn = (n: number) => ({
    role: 'user',
    content: [
      { type: 'text', text: `shot ${n}` },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } }
    ]
  })
  const msgs = [
    imageTurn(1),
    { role: 'assistant', content: 'a1' },
    imageTurn(2),
    { role: 'assistant', content: 'a2' },
    imageTurn(3),
    { role: 'assistant', content: 'a3' },
    { role: 'user', content: 'now' }
  ]

  const withImages = (history: any[]) =>
    history.filter((h) => h.userInputMessage?.images?.length).length

  test('keeps every image by default', () => {
    expect(withImages(buildHistory(msgs, 'claude-opus-5'))).toBe(3)
  })

  test('keeps only the newest N and marks the dropped ones', () => {
    const history = buildHistory(msgs, 'claude-opus-5', { historyImageMessages: 1 })
    expect(withImages(history)).toBe(1)
    const users: any[] = history.filter((h: any) => h.userInputMessage)
    expect(users[0].userInputMessage.content).toContain('omitted')
    expect(users[2].userInputMessage.images).toHaveLength(1)
  })
})

describe('withTimingLog', () => {
  test('passes every event through unchanged', async () => {
    const events: StreamEvent[] = [
      { type: 'message_start' },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } },
      { type: 'message_stop' }
    ]
    const out: StreamEvent[] = []
    for await (const e of withTimingLog(streamOf(events), 'm', TIMING)) out.push(e)
    expect(out).toEqual(events)
  })

  test('propagates return() to the inner stream on early exit', async () => {
    let innerClosed = false
    async function* inner(): AsyncGenerator<StreamEvent> {
      try {
        yield { type: 'message_start' }
        yield { type: 'message_stop' }
      } finally {
        innerClosed = true
      }
    }
    for await (const _ of withTimingLog(inner(), 'm', TIMING)) break
    expect(innerClosed).toBe(true)
  })
})

describe('client disconnect', () => {
  test('stops consuming the upstream stream when the client hangs up', async () => {
    let yielded = 0
    let closed = false
    let release!: () => void
    const firstSent = new Promise<void>((r) => (release = r))

    async function* slow(): AsyncGenerator<StreamEvent> {
      try {
        yield { type: 'message_start', message: { id: 'x', usage: {} } }
        release()
        for (let i = 0; i < 1000; i++) {
          await new Promise((r) => setTimeout(r, 5))
          yielded++
          yield { type: 'ping' }
        }
      } finally {
        closed = true
      }
    }

    const runtime: any = {
      stream: async () => ({ events: slow(), prep: { conversationId: 'c' }, model: 'm' })
    }
    const port = 20000 + Math.floor(Math.random() * 20000)
    const handle = await startProxyServer(runtime, {
      host: '127.0.0.1',
      port,
      token: '',
      defaultModel: 'claude-opus-5',
      keepAliveSeconds: 0
    })

    try {
      const controller = new AbortController()
      const res = await fetch(`${handle.url}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'claude-opus-5', messages: [] }),
        signal: controller.signal
      })
      const reader = res.body!.getReader()
      await reader.read()
      await firstSent
      controller.abort()

      for (let i = 0; i < 100 && !closed; i++) await new Promise((r) => setTimeout(r, 10))
      expect(closed).toBe(true)
      expect(yielded).toBeLessThan(1000)
    } finally {
      await handle.close()
    }
  })
})
