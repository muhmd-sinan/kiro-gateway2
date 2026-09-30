import { describe, expect, test } from 'bun:test'
import type { StreamEvent } from '../plugin/streaming/types.js'
import type { WebSearchResult } from '../plugin/web-search.js'
import {
  normalizeServerToolHistory,
  planServerTools,
  runServerToolLoop,
  WEB_SEARCH_TOOL_NAME
} from '../server/server-tools.js'

const WEB_SEARCH_SPEC = { type: 'web_search_20250305', name: 'web_search', max_uses: 3 }
const CLIENT_TOOL = { name: 'Bash', description: 'run', input_schema: { type: 'object' } }

async function* streamOf(events: StreamEvent[]): AsyncGenerator<StreamEvent> {
  for (const event of events) yield event
}

function collect(gen: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  return (async () => {
    const out: StreamEvent[] = []
    for await (const event of gen) out.push(event)
    return out
  })()
}

const RESULT: WebSearchResult = {
  title: 'Node 24',
  url: 'https://nodejs.org',
  snippet: 'Release notes',
  domain: 'nodejs.org',
  publishedDate: Date.UTC(2026, 0, 15)
}

describe('planServerTools', () => {
  test('leaves a body with no server tools untouched', () => {
    const body = { tools: [CLIENT_TOOL] }
    const plan = planServerTools(body, true)
    expect(plan.body).toBe(body)
    expect(plan.searchToolName).toBeNull()
  })

  test('leaves a body with no tools at all untouched', () => {
    const body = { messages: [] }
    expect(planServerTools(body, true).body).toBe(body)
  })

  test('substitutes an executable search tool when search is available', () => {
    const plan = planServerTools({ tools: [CLIENT_TOOL, WEB_SEARCH_SPEC] }, true)

    expect(plan.searchToolName).toBe(WEB_SEARCH_TOOL_NAME)
    expect(plan.maxUses).toBe(3)

    // The server-typed spec is gone and the replacement has a real query param,
    // which is what the original spec lacked.
    const names = plan.body.tools.map((t: any) => t.name)
    expect(names).toEqual(['Bash', WEB_SEARCH_TOOL_NAME])
    const injected = plan.body.tools[1]
    expect(injected.input_schema.properties.query.type).toBe('string')
    expect(injected.input_schema.required).toEqual(['query'])
  })

  test('strips the server tool without substituting when search is unavailable', () => {
    // This alone is the hang fix: a tool nothing can execute must not be offered.
    const plan = planServerTools({ tools: [CLIENT_TOOL, WEB_SEARCH_SPEC] }, false)
    expect(plan.searchToolName).toBeNull()
    expect(plan.maxUses).toBe(0)
    expect(plan.body.tools.map((t: any) => t.name)).toEqual(['Bash'])
  })

  test('drops server tools Kiro has no equivalent for', () => {
    const plan = planServerTools(
      {
        tools: [
          CLIENT_TOOL,
          { type: 'web_fetch_20250910', name: 'web_fetch' },
          { type: 'code_execution_20250825', name: 'code_execution' }
        ]
      },
      true
    )
    expect(plan.body.tools.map((t: any) => t.name)).toEqual(['Bash'])
    expect(plan.searchToolName).toBeNull()
  })

  test('keeps client-executed tools that also carry a type', () => {
    // bash_20250124 / text_editor_* are run by the client, unlike web_search.
    const plan = planServerTools(
      { tools: [{ type: 'bash_20250124', name: 'bash' }, WEB_SEARCH_SPEC] },
      true
    )
    expect(plan.body.tools.map((t: any) => t.name)).toEqual(['bash', WEB_SEARCH_TOOL_NAME])
  })

  test('falls back to a prefixed name when the client owns `web_search`', () => {
    const plan = planServerTools(
      { tools: [{ name: 'web_search', input_schema: {} }, WEB_SEARCH_SPEC] },
      true
    )
    expect(plan.searchToolName).toBe('kiro_web_search')
  })

  test('clamps max_uses and defaults when it is absent', () => {
    expect(planServerTools({ tools: [{ type: 'web_search' }] }, true).maxUses).toBe(5)
    expect(planServerTools({ tools: [{ type: 'web_search', max_uses: 99 }] }, true).maxUses).toBe(
      10
    )
    expect(planServerTools({ tools: [{ type: 'web_search', max_uses: 0 }] }, true).maxUses).toBe(1)
  })
})

describe('normalizeServerToolHistory', () => {
  test('flattens replayed server-tool blocks to text', () => {
    // The history builder only understands text/tool_use/tool_result, so without
    // this the model loses every trace of an earlier search and re-runs it.
    const body = {
      messages: [
        { role: 'user', content: 'what changed in node 24?' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Searching.' },
            {
              type: 'server_tool_use',
              id: 'srvtoolu_1',
              name: 'web_search',
              input: { query: 'node 24' }
            },
            {
              type: 'web_search_tool_result',
              tool_use_id: 'srvtoolu_1',
              content: [{ type: 'web_search_result', title: 'Node 24', url: 'https://nodejs.org' }]
            }
          ]
        }
      ]
    }

    const out = normalizeServerToolHistory(body)
    const types = out.messages[1].content.map((b: any) => b.type)
    expect(types).toEqual(['text', 'text', 'text'])
    expect(out.messages[1].content[1].text).toContain('node 24')
    expect(out.messages[1].content[2].text).toContain('https://nodejs.org')
    // Untouched messages are shared, not copied.
    expect(out.messages[0]).toBe(body.messages[0])
  })

  test('returns the body unchanged when there is nothing to flatten', () => {
    const body = { messages: [{ role: 'user', content: 'hi' }] }
    expect(normalizeServerToolHistory(body)).toBe(body)
  })
})

describe('runServerToolLoop', () => {
  const searchCall = (id: string, query: string): StreamEvent[] => [
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id, name: WEB_SEARCH_TOOL_NAME, input: {} }
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: JSON.stringify({ query }) }
    },
    { type: 'content_block_stop', index: 0 }
  ]

  test('executes the search and reports it as Anthropic server-tool blocks', async () => {
    const body: any = { messages: [{ role: 'user', content: 'node 24?' }] }
    const queries: string[] = []

    const events = await collect(
      runServerToolLoop({
        first: streamOf([
          { type: 'message_start', message: { id: 'x', usage: {} } },
          ...searchCall('srvtoolu_1', 'node 24 release'),
          { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 4 } }
        ]),
        execute: async () =>
          streamOf([
            { type: 'message_start', message: { id: 'y', usage: {} } },
            { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
            {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'text_delta', text: 'Node 24 ships X.' }
            },
            { type: 'content_block_stop', index: 0 },
            {
              type: 'message_delta',
              delta: { stop_reason: 'end_turn' },
              usage: { input_tokens: 90, output_tokens: 6 }
            }
          ]),
        body,
        searchToolName: WEB_SEARCH_TOOL_NAME,
        maxUses: 3,
        search: async (query) => {
          queries.push(query)
          return [RESULT]
        }
      })
    )

    expect(queries).toEqual(['node 24 release'])

    const starts = events.filter((e) => e.type === 'content_block_start')
    expect(starts.map((e) => e.content_block.type)).toEqual([
      'server_tool_use',
      'web_search_tool_result',
      'text'
    ])

    // The tool_use for the injected tool is never forwarded — Claude Code has no
    // executor for it and would stall.
    expect(starts.some((e) => e.content_block.type === 'tool_use')).toBe(false)

    const result = starts[1]!.content_block
    expect(result.tool_use_id).toBe('srvtoolu_1')
    expect(result.content[0].type).toBe('web_search_result')
    expect(result.content[0].url).toBe('https://nodejs.org')
    expect(result.content[0].page_age).toBe('2026-01-15')

    // Indices stay monotonic across both upstream calls, and the message frames
    // appear exactly once.
    const indices = events.filter((e) => typeof e.index === 'number').map((e) => e.index)
    expect(indices).toEqual([...indices].sort((a, b) => a! - b!))
    expect(events.filter((e) => e.type === 'message_start')).toHaveLength(1)
    expect(events.filter((e) => e.type === 'message_stop')).toHaveLength(1)

    const final = events.find((e) => e.type === 'message_delta')!
    expect(final.delta.stop_reason).toBe('end_turn')
    expect(final.usage.output_tokens).toBe(10)

    // The exchange is replayed upstream as an ordinary tool_use/tool_result pair.
    expect(body.messages).toHaveLength(3)
    expect(body.messages[1].content.at(-1)).toMatchObject({
      type: 'tool_use',
      name: WEB_SEARCH_TOOL_NAME
    })
    expect(body.messages[2].content[0].type).toBe('tool_result')
  })

  test('surfaces a failed search as an error result instead of breaking the stream', async () => {
    const events = await collect(
      runServerToolLoop({
        first: streamOf([
          ...searchCall('srvtoolu_1', 'x'),
          { type: 'message_delta', delta: { stop_reason: 'tool_use' } }
        ]),
        execute: async () =>
          streamOf([{ type: 'message_delta', delta: { stop_reason: 'end_turn' } }]),
        body: { messages: [] },
        searchToolName: WEB_SEARCH_TOOL_NAME,
        maxUses: 1,
        search: async () => {
          throw new Error('upstream down')
        }
      })
    )

    const result = events.find(
      (e) => e.type === 'content_block_start' && e.content_block.type === 'web_search_tool_result'
    )!
    expect(result.content_block.content).toEqual({
      type: 'web_search_tool_result_error',
      error_code: 'unavailable'
    })
    expect(events.at(-1)!.type).toBe('message_stop')
  })

  test('reports max_uses_exceeded rather than searching past the budget', async () => {
    const events = await collect(
      runServerToolLoop({
        first: streamOf([
          ...searchCall('srvtoolu_1', 'x'),
          { type: 'message_delta', delta: { stop_reason: 'tool_use' } }
        ]),
        execute: async () =>
          streamOf([{ type: 'message_delta', delta: { stop_reason: 'end_turn' } }]),
        body: { messages: [] },
        searchToolName: WEB_SEARCH_TOOL_NAME,
        maxUses: 0,
        search: async () => {
          throw new Error('should not be called')
        }
      })
    )

    const result = events.find(
      (e) => e.type === 'content_block_start' && e.content_block.type === 'web_search_tool_result'
    )!
    expect(result.content_block.content.error_code).toBe('max_uses_exceeded')
  })

  test('stops for a client tool call instead of stranding it', async () => {
    // Continuing upstream here would leave the client's tool_use unanswered.
    const events = await collect(
      runServerToolLoop({
        first: streamOf([
          ...searchCall('srvtoolu_1', 'x'),
          {
            type: 'content_block_start',
            index: 1,
            content_block: { type: 'tool_use', id: 'toolu_9', name: 'Bash', input: {} }
          },
          { type: 'content_block_stop', index: 1 },
          { type: 'message_delta', delta: { stop_reason: 'tool_use' } }
        ]),
        execute: async () => {
          throw new Error('should not continue')
        },
        body: { messages: [] },
        searchToolName: WEB_SEARCH_TOOL_NAME,
        maxUses: 2,
        search: async () => [RESULT]
      })
    )

    expect(events.find((e) => e.type === 'message_delta')!.delta.stop_reason).toBe('tool_use')
    const passthrough = events.find(
      (e) => e.type === 'content_block_start' && e.content_block.name === 'Bash'
    )!
    expect(passthrough.content_block.id).toBe('toolu_9')
  })

  test('passes a plain turn straight through', async () => {
    const events = await collect(
      runServerToolLoop({
        first: streamOf([
          { type: 'message_start', message: { id: 'x' } },
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } },
          { type: 'content_block_stop', index: 0 },
          { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }
        ]),
        execute: async () => {
          throw new Error('should not run a second call')
        },
        body: { messages: [] },
        searchToolName: WEB_SEARCH_TOOL_NAME,
        maxUses: 3,
        search: async () => {
          throw new Error('should not search')
        }
      })
    )

    expect(events.map((e) => e.type)).toEqual([
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop'
    ])
  })
})
