import { StreamEvent, StreamState } from './types.js'

/**
 * Open a thinking/text block unless one of that type is already open.
 *
 * Anthropic blocks are strictly sequential: a block is final once it gets
 * content_block_stop, and only one block is open at a time. Kiro breaks the
 * old "thinking, then text" assumption: within one turn it interleaves native
 * reasoning with text and tool calls. So a thinking block that was already
 * stopped got more deltas, and a text block opened while thinking was still
 * open. Claude Code renders those deltas live and then drops them when it
 * finalizes the block, which is why reasoning (and the calls around it)
 * showed briefly and then disappeared. Opening a block here therefore closes
 * the other type first, and a stopped block is never reused.
 */
export function ensureBlockStart(
  blockType: 'thinking' | 'text',
  streamState: StreamState
): StreamEvent[] {
  const key = blockType === 'thinking' ? 'thinkingBlockIndex' : 'textBlockIndex'
  const other = blockType === 'thinking' ? 'textBlockIndex' : 'thinkingBlockIndex'
  const current = streamState[key]
  if (current != null && !streamState.stoppedBlocks.has(current)) return []

  const events = stopBlock(streamState[other], streamState)
  streamState[other] = null
  const idx = streamState.nextBlockIndex++
  streamState[key] = idx
  events.push({
    type: 'content_block_start',
    index: idx,
    content_block:
      blockType === 'thinking' ? { type: 'thinking', thinking: '' } : { type: 'text', text: '' }
  })
  return events
}

export function stopBlock(index: number | null, streamState: StreamState): StreamEvent[] {
  if (index == null) return []
  if (streamState.stoppedBlocks.has(index)) return []
  streamState.stoppedBlocks.add(index)
  return [{ type: 'content_block_stop', index }]
}

export function createTextDeltaEvents(text: string, streamState: StreamState): StreamEvent[] {
  if (!text) return []
  const events: StreamEvent[] = []
  events.push(...ensureBlockStart('text', streamState))
  events.push({
    type: 'content_block_delta',
    index: streamState.textBlockIndex!,
    delta: { type: 'text_delta', text }
  })
  return events
}

export function createThinkingDeltaEvents(
  thinking: string,
  streamState: StreamState
): StreamEvent[] {
  const events: StreamEvent[] = []
  events.push(...ensureBlockStart('thinking', streamState))
  events.push({
    type: 'content_block_delta',
    index: streamState.thinkingBlockIndex!,
    delta: { type: 'thinking_delta', thinking }
  })
  return events
}
