import type { CodeWhispererMessage } from '../../plugin/types'

export function sanitizeHistory(history: CodeWhispererMessage[]): CodeWhispererMessage[] {
  const result: CodeWhispererMessage[] = []
  for (let i = 0; i < history.length; i++) {
    const m = history[i]
    if (!m) continue
    if (m.assistantResponseMessage?.toolUses) {
      const next = history[i + 1]
      if (next?.userInputMessage?.userInputMessageContext?.toolResults) {
        result.push(m)
      }
    } else if (m.userInputMessage?.userInputMessageContext?.toolResults) {
      const prev = result[result.length - 1]
      if (prev?.assistantResponseMessage?.toolUses) {
        result.push(m)
      }
    } else {
      result.push(m)
    }
  }

  while (result.length > 0) {
    const first = result[0]
    if (first?.userInputMessage && !first.userInputMessage.userInputMessageContext?.toolResults)
      break
    result.shift()
  }
  if (result.length === 0) return []

  while (result.length > 0 && result[result.length - 1]?.assistantResponseMessage) {
    result.pop()
  }

  return result
}

export function findOriginalToolCall(msgs: any[], toolUseId: string): any | null {
  for (const m of msgs) {
    if (m.role === 'assistant') {
      if (m.tool_calls) {
        for (const tc of m.tool_calls) if (tc.id === toolUseId) return tc
      }
      if (Array.isArray(m.content)) {
        for (const p of m.content) if (p.type === 'tool_use' && p.id === toolUseId) return p
      }
    }
  }
  return null
}

/**
 * Shallow-copy a message *and* the arrays the merge below appends to.
 *
 * A plain `{ ...m }` shares `content`/`tool_calls` with the caller's body, so
 * `last.content.push(...)` wrote into the client's own message. The same body is
 * rebuilt on every retry (executeWithRetry) and on every web-search iteration
 * (runServerToolLoop), so each rebuild appended the neighbour's blocks again and
 * the model saw duplicated text and tool results.
 */
function copyMessage(m: any): any {
  const copy = { ...m }
  if (Array.isArray(m.content)) copy.content = [...m.content]
  if (Array.isArray(m.tool_calls)) copy.tool_calls = [...m.tool_calls]
  if (Array.isArray(m.tool_results)) copy.tool_results = [...m.tool_results]
  return copy
}

export function mergeAdjacentMessages(msgs: any[]): any[] {
  const merged: any[] = []
  for (const m of msgs) {
    if (!merged.length) merged.push(copyMessage(m))
    else {
      const last = merged[merged.length - 1]
      if (last && m.role === last.role) {
        if (Array.isArray(last.content) && Array.isArray(m.content)) last.content.push(...m.content)
        else if (typeof last.content === 'string' && typeof m.content === 'string')
          last.content += '\n' + m.content
        else if (Array.isArray(last.content) && typeof m.content === 'string')
          last.content.push({ type: 'text', text: m.content })
        else if (typeof last.content === 'string' && Array.isArray(m.content))
          last.content = [{ type: 'text', text: last.content }, ...m.content]
        if (m.tool_calls) {
          if (!last.tool_calls) last.tool_calls = []
          last.tool_calls.push(...m.tool_calls)
        }
        if (m.role === 'tool') {
          if (!last.tool_results)
            last.tool_results = [{ content: last.content, tool_call_id: last.tool_call_id }]
          last.tool_results.push({ content: m.content, tool_call_id: m.tool_call_id })
        }
      } else merged.push(copyMessage(m))
    }
  }
  return merged
}

/**
 * Parse an OpenAI `tool_calls[].function.arguments` value without throwing.
 *
 * The field is a JSON *string* written by the model and replayed by the client,
 * so it can be truncated or malformed. A bare JSON.parse turned one bad argument
 * string anywhere in the history into a failed request for the whole turn, with
 * no way for the client to recover short of editing its history. An empty object
 * keeps the tool_use/tool_result pairing intact, which is what Kiro validates.
 */
export function parseToolArguments(args: unknown): any {
  if (typeof args !== 'string') return args ?? {}
  if (!args.trim()) return {}
  try {
    return JSON.parse(args)
  } catch {
    return {}
  }
}

export function getContentText(m: any): string {
  if (!m) return ''
  if (typeof m === 'string') return m
  // Anthropic tool_result blocks carry `content` as an array of blocks, so callers
  // doing `getContentText(p.content || p)` hand us a bare array.
  if (Array.isArray(m))
    return m
      .map((p: any) => (typeof p === 'string' ? p : p?.type === 'text' ? p.text || '' : ''))
      .join('')
  if (typeof m.content === 'string') return m.content
  if (Array.isArray(m.content))
    return m.content
      .filter((p: any) => p.type === 'text')
      .map((p: any) => p.text || '')
      .join('')
  return m.text || ''
}
