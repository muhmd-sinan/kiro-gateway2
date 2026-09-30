import { describe, expect, test } from 'bun:test'
import { transformSdkStreamEvents } from '../plugin/streaming/sdk-stream-transformer.js'
import type { StreamEvent } from '../plugin/streaming/types.js'

function sdk(events: any[]) {
  return {
    generateAssistantResponseResponse: (async function* () {
      for (const event of events) yield event
    })()
  }
}

async function run(events: any[], streamToolInput = true): Promise<StreamEvent[]> {
  const out: StreamEvent[] = []
  for await (const e of transformSdkStreamEvents(sdk(events), 'claude-opus-5', 'c', undefined, {
    streamToolInput
  })) {
    out.push(e)
  }
  return out
}

/**
 * The Anthropic block contract Claude Code relies on: blocks are sequential,
 * every start gets exactly one stop, nothing is written to a closed block, and
 * indices are never reused.
 */
function assertWellFormed(events: StreamEvent[]): void {
  const started = new Set<number>()
  const stopped = new Set<number>()
  let open: number | null = null
  for (const e of events) {
    if (e.type === 'content_block_start') {
      expect(open, `block ${e.index} opened while ${open} still open`).toBeNull()
      expect(started.has(e.index!), `index ${e.index} reused`).toBe(false)
      started.add(e.index!)
      open = e.index!
    } else if (e.type === 'content_block_delta') {
      expect(e.index, 'delta to a block that is not open').toBe(open!)
    } else if (e.type === 'content_block_stop') {
      expect(e.index).toBe(open!)
      stopped.add(e.index!)
      open = null
    }
  }
  expect(open).toBeNull()
  expect([...stopped].sort()).toEqual([...started].sort())
}

const frag = (input: string, extra: Record<string, unknown> = {}) => ({
  toolUseEvent: { toolUseId: 't1', name: 'Write', input, ...extra }
})

describe('incremental tool_use streaming', () => {
  test('emits the tool block as fragments arrive, not after the stream ends', async () => {
    const events = await run([
      { assistantResponseEvent: { content: 'Writing it now.' } },
      frag('{"path":'),
      frag('"a.txt",'),
      frag('"content":"hi"}'),
      frag('', { stop: true })
    ])
    assertWellFormed(events)

    const start = events.findIndex(
      (e) => e.type === 'content_block_start' && e.content_block.type === 'tool_use'
    )
    // Three fragment deltas, streamed individually.
    const toolDeltas = events.filter(
      (e) => e.type === 'content_block_delta' && e.delta.type === 'input_json_delta'
    )
    expect(toolDeltas).toHaveLength(3)
    expect(JSON.parse(toolDeltas.map((e) => e.delta.partial_json).join(''))).toEqual({
      path: 'a.txt',
      content: 'hi'
    })
    // The text block closes before the tool opens.
    const textStop = events.findIndex((e) => e.type === 'content_block_stop' && e.index === 0)
    expect(textStop).toBeLessThan(start)

    const final = events.find((e) => e.type === 'message_delta')!
    expect(final.delta.stop_reason).toBe('tool_use')
  })

  test('opens a fresh text block for text that follows a tool call', async () => {
    const events = await run([
      { assistantResponseEvent: { content: 'first ' } },
      frag('{}', { stop: true }),
      { assistantResponseEvent: { content: 'after' } }
    ])
    assertWellFormed(events)
    const textStarts = events.filter(
      (e) => e.type === 'content_block_start' && e.content_block.type === 'text'
    )
    expect(textStarts).toHaveLength(2)
  })

  test('closes native reasoning before a tool call with no text in between', async () => {
    const events = await run([
      { reasoningContentEvent: { text: 'thinking...' } },
      frag('{"path":"x"}', { stop: true })
    ])
    assertWellFormed(events)
    expect(events.find((e) => e.type === 'content_block_start')!.content_block.type).toBe(
      'thinking'
    )
  })

  test('streams consecutive calls as separate blocks', async () => {
    const events = await run([
      { toolUseEvent: { toolUseId: 'a', name: 'Read', input: '{"p":1}' } },
      { toolUseEvent: { toolUseId: 'a', name: 'Read', stop: true } },
      { toolUseEvent: { toolUseId: 'b', name: 'Grep', input: '{"q":2}' } },
      { toolUseEvent: { toolUseId: 'b', name: 'Grep', stop: true } }
    ])
    assertWellFormed(events)
    const ids = events
      .filter((e) => e.type === 'content_block_start')
      .map((e) => e.content_block.id)
    expect(ids).toEqual(['a', 'b'])
  })

  test('holds input that arrives before the name, then sends it first', async () => {
    const events = await run([
      { toolUseEvent: { toolUseId: 't1', input: '{"a":' } },
      { toolUseEvent: { toolUseId: 't1', name: 'Write', input: '1}' } },
      { toolUseEvent: { toolUseId: 't1', stop: true } }
    ])
    assertWellFormed(events)
    const json = events
      .filter((e) => e.type === 'content_block_delta')
      .map((e) => e.delta.partial_json)
      .join('')
    expect(JSON.parse(json)).toEqual({ a: 1 })
  })

  test('closes a tool the stream never marked stopped', async () => {
    const events = await run([frag('{"x":1}')])
    assertWellFormed(events)
  })

  test('buffered mode (OpenCode plugin) still emits calls once, at the end', async () => {
    const events = await run(
      [
        { assistantResponseEvent: { content: 'ok' } },
        frag('{"path":'),
        frag('"a"}'),
        frag('', { stop: true })
      ],
      false
    )
    assertWellFormed(events)
    const toolDeltas = events.filter(
      (e) => e.type === 'content_block_delta' && e.delta.type === 'input_json_delta'
    )
    expect(toolDeltas).toHaveLength(1)
    expect(JSON.parse(toolDeltas[0]!.delta.partial_json)).toEqual({ path: 'a' })
  })
})

describe('metering', () => {
  test('carries Kiro credits on message_delta without leaking into usage', async () => {
    const events = await run([
      { assistantResponseEvent: { content: 'hi' } },
      { meteringEvent: { usage: 0.0439, unit: 'credit' } }
    ])
    const delta = events.find((e) => e.type === 'message_delta')!
    expect(delta.metering).toEqual({ credits: 0.0439 })
    expect('credits' in delta.usage).toBe(false)
  })

  test('omits metering when Kiro sends none', async () => {
    const events = await run([{ assistantResponseEvent: { content: 'hi' } }])
    expect(events.find((e) => e.type === 'message_delta')!.metering).toBeUndefined()
  })
})
