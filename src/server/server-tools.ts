import type { StreamEvent } from '../plugin/streaming/index.js'
import type { WebSearchResult } from '../plugin/web-search.js'

/**
 * Anthropic server-side tools on the `/v1/messages` surface.
 *
 * Claude Code declares web search as a *server* tool: the request carries
 * `{type: "web_search_20250305", name: "web_search", max_uses: N}` and the API is
 * expected to run the search itself and report it back as `server_tool_use` +
 * `web_search_tool_result` content blocks. The client has no executor for it.
 *
 * Passing that spec through to Kiro is what broke web search here. A server tool
 * carries no `input_schema`, so convertToolsToCodeWhisperer turned it into a
 * parameterless `web_search` tool; the model then "called" it, the proxy streamed
 * the tool_use to Claude Code, and Claude Code stalled waiting on a tool it has
 * no way to run.
 *
 * So the server tool is never forwarded. Instead:
 *
 * - Every server-typed tool is stripped from the outbound list, which alone stops
 *   the hang: the model can no longer call something nothing will execute.
 * - When web search was asked for and is actually available, a real client-shaped
 *   tool (with a `query` parameter) is injected under a reserved name, and
 *   `runServerToolLoop` intercepts calls to it, runs Kiro's own search, and
 *   replays the result upstream so the model can keep going. What reaches the
 *   client is the server_tool_use / web_search_tool_result pair Anthropic
 *   documents, which is what Claude Code renders.
 *
 * web_fetch and the code-execution tools are dropped without a substitute — Kiro
 * exposes no equivalent, and dropping is what keeps the model from calling them.
 */

/** Server-executed tool types, with or without Anthropic's date stamp. */
const SERVER_TOOL_TYPE =
  /^(web_search|web_fetch|code_execution|bash_code_execution|text_editor_code_execution)(_\d{8})?$/

/**
 * Name the injected search tool takes on the wire.
 *
 * Matches SAFE_TOOL_NAME_PATTERN in tool-transformer.ts, so the name registry
 * passes it through unaliased and `restoreToolName` round-trips it.
 */
export const WEB_SEARCH_TOOL_NAME = 'web_search'

/** Used when the client already defines a tool called `web_search`. */
const FALLBACK_TOOL_NAME = 'kiro_web_search'

/** Anthropic's own default when `max_uses` is omitted. */
const DEFAULT_MAX_USES = 5

/**
 * Upper bound on upstream round trips per turn.
 *
 * Each intercepted search costs another generateAssistantResponse call, so this
 * caps the blast radius of a model that keeps searching.
 */
const MAX_ITERATIONS = 5

const SEARCH_TOOL_DESCRIPTION = `Search the web and get back titles, URLs, snippets, domains and publish dates.

Use it for current or fast-moving information (pricing, versions, release notes, recent events, library APIs) and to verify facts that may have changed. Do not use it for well-established concepts or anything answerable from the repository or this conversation.

Keep the query focused and 200 characters or fewer. Prefer several narrow searches over one broad one. Cite what you use as inline [description](url) links, and paraphrase rather than quoting at length.`

export interface ServerToolPlan {
  /** Request body with server tools removed and the search tool substituted. */
  body: any
  /** Wire name of the injected search tool, or null when none was injected. */
  searchToolName: string | null
  /** Remaining search budget for this turn. */
  maxUses: number
}

function toolName(tool: any): string | undefined {
  const direct = tool?.name
  if (typeof direct === 'string' && direct) return direct
  const fn = tool?.function?.name
  return typeof fn === 'string' && fn ? fn : undefined
}

/**
 * Strip server-executed tools and substitute an executable web-search tool.
 *
 * Returns the body unchanged when the client sent no server tools, so the common
 * case allocates nothing and the OpenAI surface is unaffected.
 */
export function planServerTools(body: any, searchAvailable: boolean): ServerToolPlan {
  const tools = Array.isArray(body?.tools) ? body.tools : []
  if (tools.length === 0) return { body, searchToolName: null, maxUses: 0 }

  const clientTools: any[] = []
  let searchRequested = false
  let maxUses = DEFAULT_MAX_USES

  for (const tool of tools) {
    const type = typeof tool?.type === 'string' ? tool.type : ''
    if (!SERVER_TOOL_TYPE.test(type)) {
      clientTools.push(tool)
      continue
    }
    if (type.startsWith('web_search')) {
      searchRequested = true
      const requested = tool?.max_uses
      if (typeof requested === 'number' && Number.isFinite(requested)) {
        maxUses = Math.max(1, Math.min(10, Math.floor(requested)))
      }
    }
  }

  if (clientTools.length === tools.length) {
    return { body, searchToolName: null, maxUses: 0 }
  }

  let searchToolName: string | null = null
  if (searchRequested && searchAvailable) {
    const taken = new Set(clientTools.map(toolName).filter(Boolean))
    searchToolName = taken.has(WEB_SEARCH_TOOL_NAME) ? FALLBACK_TOOL_NAME : WEB_SEARCH_TOOL_NAME
    clientTools.push({
      name: searchToolName,
      description: SEARCH_TOOL_DESCRIPTION,
      input_schema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'The search query. Must be 200 characters or fewer.'
          }
        },
        required: ['query']
      }
    })
  }

  return {
    body: { ...body, tools: clientTools },
    searchToolName,
    maxUses: searchToolName ? maxUses : 0
  }
}

/** Render one result set as the `content` of a web_search_tool_result block. */
export function toWebSearchResultBlocks(
  results: WebSearchResult[]
): Array<Record<string, unknown>> {
  return results.map((result) => ({
    type: 'web_search_result',
    title: result.title,
    url: result.url,
    // Anthropic documents this field as required. Nothing downstream validates
    // it — the proxy is the only producer and Claude Code renders title/url — so
    // the snippet stands in for the opaque blob the real API returns.
    encrypted_content: Buffer.from(result.snippet ?? '', 'utf8').toString('base64'),
    page_age:
      typeof result.publishedDate === 'number'
        ? new Date(result.publishedDate).toISOString().slice(0, 10)
        : null
  }))
}

/**
 * Flatten replayed server-tool blocks in the incoming history to text.
 *
 * Claude Code sends back every block it received, including the
 * `server_tool_use` / `web_search_tool_result` pairs from earlier turns. The
 * history builder only understands text/tool_use/tool_result and drops the rest,
 * so without this the model loses all evidence that it already searched and
 * repeats the same queries. Flattening to text keeps the content and avoids
 * inventing tool_use ids that have no matching result upstream.
 */
export function normalizeServerToolHistory(body: any): any {
  const messages = body?.messages
  if (!Array.isArray(messages)) return body

  let touched = false

  const rewritten = messages.map((message: any) => {
    if (!Array.isArray(message?.content)) return message
    if (
      !message.content.some(
        (block: any) =>
          block?.type === 'server_tool_use' || block?.type === 'web_search_tool_result'
      )
    ) {
      return message
    }

    touched = true
    const content = message.content.map((block: any) => {
      if (block?.type === 'server_tool_use') {
        const query = block?.input?.query
        return {
          type: 'text',
          text: `[web search: ${typeof query === 'string' ? query : ''}]`
        }
      }
      if (block?.type === 'web_search_tool_result') {
        const items = Array.isArray(block.content) ? block.content : []
        const rendered = items
          .map((item: any, index: number) =>
            item?.type === 'web_search_result'
              ? `${index + 1}. ${item.title ?? ''} — ${item.url ?? ''}`
              : `${index + 1}. ${item?.error_code ?? 'error'}`
          )
          .join('\n')
        return { type: 'text', text: `[web search results]\n${rendered}` }
      }
      return block
    })

    return { ...message, content }
  })

  return touched ? { ...body, messages: rewritten } : body
}

interface InterceptedSearch {
  id: string
  input: string
}

export interface ServerToolLoopOptions {
  /** Event stream of the first upstream call, already made by the caller. */
  first: AsyncGenerator<StreamEvent>
  /** Run another upstream call with the (mutated) body and return its events. */
  execute: (body: any) => Promise<AsyncGenerator<StreamEvent>>
  /** Body the first call was made with; extended in place across iterations. */
  body: any
  searchToolName: string
  maxUses: number
  search: (query: string) => Promise<WebSearchResult[]>
}

/**
 * Drive the search-and-continue loop, emitting one coherent Anthropic stream.
 *
 * Each upstream call restarts its block indices at 0, so indices are remapped
 * onto a single monotonic sequence and `message_start` / `message_delta` /
 * `message_stop` are emitted once for the whole turn. Calls to the injected
 * search tool are swallowed and replaced with the server_tool_use /
 * web_search_tool_result pair; anything else the model calls is passed straight
 * through for the client to run.
 */
export async function* runServerToolLoop(
  options: ServerToolLoopOptions
): AsyncGenerator<StreamEvent> {
  const { execute, body, searchToolName, search } = options

  let events = options.first
  let remaining = options.maxUses
  let outIndex = 0
  let started = false
  let stopReason = 'end_turn'
  let usage: Record<string, number> = {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0
  }

  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    const indexMap = new Map<number, number>()
    const intercepted = new Map<number, InterceptedSearch>()
    const interceptedOrder: number[] = []
    let assistantText = ''
    let sawPassthroughTool = false

    for await (const event of events) {
      if (event.type === 'message_start') {
        if (started) continue
        started = true
        yield event
        continue
      }

      if (event.type === 'message_delta') {
        if (event.delta?.stop_reason) stopReason = event.delta.stop_reason
        if (event.usage) {
          // Output accumulates across iterations; input reflects the last call,
          // which already carries the whole replayed history.
          usage = {
            ...usage,
            ...event.usage,
            output_tokens: (usage.output_tokens ?? 0) + (event.usage.output_tokens ?? 0)
          }
        }
        continue
      }

      if (event.type === 'message_stop') continue

      if (typeof event.index !== 'number') {
        yield event
        continue
      }

      if (event.type === 'content_block_start') {
        const block = event.content_block ?? {}
        if (block.type === 'tool_use' && block.name === searchToolName) {
          intercepted.set(event.index, { id: String(block.id ?? ''), input: '' })
          interceptedOrder.push(event.index)
          continue
        }
        if (block.type === 'tool_use') sawPassthroughTool = true
        const mapped = outIndex++
        indexMap.set(event.index, mapped)
        yield { ...event, index: mapped }
        continue
      }

      const pending = intercepted.get(event.index)
      if (pending) {
        if (event.type === 'content_block_delta' && event.delta?.type === 'input_json_delta') {
          pending.input += event.delta.partial_json ?? ''
        }
        continue
      }

      const mapped = indexMap.get(event.index)
      if (mapped === undefined) continue
      if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
        assistantText += event.delta.text ?? ''
      }
      yield { ...event, index: mapped }
    }

    if (interceptedOrder.length === 0) break

    // Report each search, run it, and report its results.
    const toolUses: any[] = []
    const toolResults: any[] = []

    for (const upstreamIndex of interceptedOrder) {
      const pending = intercepted.get(upstreamIndex)!
      let query = ''
      try {
        const parsed = pending.input ? JSON.parse(pending.input) : {}
        if (typeof parsed?.query === 'string') query = parsed.query
      } catch {
        query = ''
      }

      const useBlock = outIndex++
      yield {
        type: 'content_block_start',
        index: useBlock,
        content_block: { type: 'server_tool_use', id: pending.id, name: 'web_search', input: {} }
      }
      yield {
        type: 'content_block_delta',
        index: useBlock,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify({ query }) }
      }
      yield { type: 'content_block_stop', index: useBlock }

      let content: Array<Record<string, unknown>> | Record<string, unknown>
      let resultText: string
      if (remaining <= 0) {
        content = { type: 'web_search_tool_result_error', error_code: 'max_uses_exceeded' }
        resultText = 'Web search budget for this turn is exhausted.'
      } else {
        remaining--
        try {
          const results = await search(query)
          content = toWebSearchResultBlocks(results)
          resultText =
            results.length > 0
              ? results
                  .map((r, i) => `${i + 1}. ${r.title} — ${r.url}\n   ${r.snippet ?? ''}`)
                  .join('\n')
              : 'No results found.'
        } catch (e) {
          content = { type: 'web_search_tool_result_error', error_code: 'unavailable' }
          resultText = `Web search failed: ${e instanceof Error ? e.message : String(e)}`
        }
      }

      const resultBlock = outIndex++
      yield {
        type: 'content_block_start',
        index: resultBlock,
        content_block: { type: 'web_search_tool_result', tool_use_id: pending.id, content }
      }
      yield { type: 'content_block_stop', index: resultBlock }

      toolUses.push({
        type: 'tool_use',
        id: pending.id,
        name: searchToolName,
        input: { query }
      })
      toolResults.push({ type: 'tool_result', tool_use_id: pending.id, content: resultText })
    }

    // Replay the exchange upstream as an ordinary tool_use/tool_result pair,
    // which is the shape buildCodeWhispererRequest already handles.
    const assistantContent: any[] = []
    if (assistantText) assistantContent.push({ type: 'text', text: assistantText })
    assistantContent.push(...toolUses)
    body.messages = [
      ...(Array.isArray(body.messages) ? body.messages : []),
      { role: 'assistant', content: assistantContent },
      { role: 'user', content: toolResults }
    ]

    // The model also called a tool the client owns. Continuing here would strand
    // that call, so stop and let the client run it and come back.
    if (sawPassthroughTool) {
      stopReason = 'tool_use'
      break
    }

    events = await execute(body)
  }

  yield {
    type: 'message_delta',
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage
  }
  yield { type: 'message_stop' }
}
