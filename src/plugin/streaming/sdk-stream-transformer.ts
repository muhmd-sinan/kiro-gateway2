import { parseBracketToolCalls } from '../../infrastructure/transformers/tool-call-parser.js'
import { restoreToolName } from '../../infrastructure/transformers/tool-transformer.js'
import { getContextWindowSize } from '../models.js'
import { estimateTokens } from '../response.js'
import type { ToolNameMap } from '../types.js'
import { convertToOpenAI } from './openai-converter.js'
import { findRealTag } from './stream-parser.js'
import { createTextDeltaEvents, createThinkingDeltaEvents, stopBlock } from './stream-state.js'
import {
  StreamEvent,
  StreamState,
  THINKING_END_TAG,
  THINKING_START_TAG,
  ToolCallState
} from './types.js'

interface PendingToolCall {
  toolUseId: string
  name?: string
  input: string
}

/**
 * Core CodeWhisperer SDK stream reader.
 *
 * Yields Anthropic-shaped `StreamEvent`s (message_start, content_block_*,
 * message_delta, message_stop). This is the single source of truth for turning
 * the SDK's event stream into a normalized block structure: it handles native
 * `reasoningContentEvent` reasoning, scrapes inline `<thinking>` tags as a
 * fallback, accumulates fragmented tool-use events, and recovers bracket-style
 * tool calls from the raw text.
 *
 * Wire-format adapters sit on top:
 * - `transformSdkStream` maps these to OpenAI chat.completion.chunk objects.
 * - The Anthropic `/v1/messages` surface serializes them close to verbatim.
 *
 * Keeping the block/index bookkeeping here means both formats see identical
 * content boundaries, so a tool call streamed to Claude Code and the same call
 * streamed to Hermes are derived from one code path.
 */
export interface StreamTransformOptions {
  /**
   * Emit tool_use blocks as Kiro streams their input, instead of buffering every
   * call until the response ends.
   *
   * Kiro sends a tool call as many small toolUseEvent fragments — measured live,
   * a file write arrived as 224 fragments spread over ~9.4s. Buffering them meant
   * Claude Code saw nothing for that whole window and then the entire call at
   * once. Streaming lets it render the call as it forms. Both surfaces enable it:
   * the OpenAI view (transformSdkStream) turns each fragment into a
   * `tool_calls[].function.arguments` delta, which @ai-sdk/openai-compatible
   * accumulates per index until the arguments parse as JSON.
   */
  streamToolInput?: boolean
}

export async function* transformSdkStreamEvents(
  sdkResponse: any,
  model: string,
  conversationId: string,
  toolNameMap?: ToolNameMap,
  options: StreamTransformOptions = {}
): AsyncGenerator<StreamEvent> {
  const thinkingRequested = true
  const streamToolInput = options.streamToolInput === true

  const streamState: StreamState = {
    thinkingRequested,
    buffer: '',
    inThinking: false,
    thinkingExtracted: false,
    thinkingBlockIndex: null,
    textBlockIndex: null,
    nextBlockIndex: 0,
    stoppedBlocks: new Set()
  }

  // Set when the API returns native reasoning via reasoningContentEvent. The
  // <thinking> tag scraper below stays as a fallback for responses that only
  // carry reasoning inline in the assistant text.
  let sawNativeReasoning = false

  let totalContent = ''
  let textOnlyContent = ''
  // Native reasoning text, kept separately from textOnlyContent: it never reaches
  // the assistant text buffer but is still billed as output.
  let reasoningContent = ''
  let outputTokens = 0
  let inputTokens = 0
  let contextUsagePercentage: number | null = null
  // Kiro reports no cache token counts, but it does report credits. Kiro caches
  // repeated prefixes automatically (verified live: a repeat of the same history
  // costs about half), so credits are the only visible sign caching is working.
  let credits: number | null = null
  const toolCallFragments = new Map<string, PendingToolCall>()
  const toolCallOrder: string[] = []

  // Incremental tool streaming state (streamToolInput only). Anthropic blocks
  // are sequential, so at most one block is open at a time: opening a tool block
  // closes text/thinking, and text after a tool call opens a fresh block.
  let openTool: { toolUseId: string; index: number } | null = null
  const streamedToolIds = new Set<string>()

  function* closeOpenTool(): Generator<StreamEvent> {
    if (!openTool) return
    const index = openTool.index
    openTool = null
    yield* stopBlock(index, streamState)
  }

  function* closeTextAndThinking(): Generator<StreamEvent> {
    // Text held back for tag detection belongs before the tool call.
    if (streamState.buffer) {
      const pending = streamState.buffer
      streamState.buffer = ''
      if (streamState.inThinking) yield* createThinkingDeltaEvents(pending, streamState)
      else yield* createTextDeltaEvents(pending, streamState)
    }
    yield* stopBlock(streamState.thinkingBlockIndex, streamState)
    yield* stopBlock(streamState.textBlockIndex, streamState)
    // Cleared so later text or reasoning opens a new block rather than writing
    // into one that has already received its content_block_stop.
    streamState.thinkingBlockIndex = null
    streamState.textBlockIndex = null
  }

  const eventStream = sdkResponse.generateAssistantResponseResponse
  if (!eventStream) {
    throw new Error('SDK response has no event stream')
  }

  // Anthropic clients expect message_start first. Usage is unknown until the
  // stream ends, so input_tokens starts at 0 and the real count lands in
  // message_delta, which Anthropic documents as cumulative.
  yield {
    type: 'message_start',
    message: {
      id: conversationId,
      type: 'message',
      role: 'assistant',
      content: [],
      model,
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 }
    }
  }

  for await (const event of eventStream) {
    if (event.reasoningContentEvent) {
      // Native reasoning stream. redactedContent is encrypted by the provider
      // and has no readable form, so only text is surfaced.
      const reasoning = event.reasoningContentEvent.text
      if (typeof reasoning === 'string' && reasoning.length > 0) {
        yield* closeOpenTool()
        sawNativeReasoning = true
        reasoningContent += reasoning
        yield* createThinkingDeltaEvents(reasoning, streamState)
      }
    } else if (event.assistantResponseEvent?.content) {
      const text = event.assistantResponseEvent.content
      totalContent += text
      textOnlyContent += text

      yield* closeOpenTool()

      // Native reasoning already streamed, so close that block and route the
      // remaining content straight to text instead of scraping for tags.
      if (sawNativeReasoning && !streamState.thinkingExtracted) {
        streamState.thinkingExtracted = true
        yield* stopBlock(streamState.thinkingBlockIndex, streamState)
      }

      if (!thinkingRequested) {
        yield* createTextDeltaEvents(text, streamState)
        continue
      }

      streamState.buffer += text
      const deltaEvents: StreamEvent[] = []

      while (streamState.buffer.length > 0) {
        if (!streamState.inThinking && !streamState.thinkingExtracted) {
          const startPos = findRealTag(streamState.buffer, THINKING_START_TAG)
          if (startPos !== -1) {
            const before = streamState.buffer.slice(0, startPos)
            if (before) {
              deltaEvents.push(...createTextDeltaEvents(before, streamState))
            }
            streamState.buffer = streamState.buffer.slice(startPos + THINKING_START_TAG.length)
            streamState.inThinking = true
            continue
          }

          const safeLen = Math.max(0, streamState.buffer.length - THINKING_START_TAG.length)
          if (safeLen > 0) {
            const safeText = streamState.buffer.slice(0, safeLen)
            if (safeText) {
              deltaEvents.push(...createTextDeltaEvents(safeText, streamState))
            }
            streamState.buffer = streamState.buffer.slice(safeLen)
          }
          break
        }

        if (streamState.inThinking) {
          const endPos = findRealTag(streamState.buffer, THINKING_END_TAG)
          if (endPos !== -1) {
            const thinkingPart = streamState.buffer.slice(0, endPos)
            if (thinkingPart) {
              deltaEvents.push(...createThinkingDeltaEvents(thinkingPart, streamState))
            }
            streamState.buffer = streamState.buffer.slice(endPos + THINKING_END_TAG.length)
            streamState.inThinking = false
            streamState.thinkingExtracted = true
            deltaEvents.push(...createThinkingDeltaEvents('', streamState))
            deltaEvents.push(...stopBlock(streamState.thinkingBlockIndex, streamState))
            if (streamState.buffer.startsWith('\n\n')) {
              streamState.buffer = streamState.buffer.slice(2)
            }
            continue
          }

          const safeLen = Math.max(0, streamState.buffer.length - THINKING_END_TAG.length)
          if (safeLen > 0) {
            const safeThinking = streamState.buffer.slice(0, safeLen)
            if (safeThinking) {
              deltaEvents.push(...createThinkingDeltaEvents(safeThinking, streamState))
            }
            streamState.buffer = streamState.buffer.slice(safeLen)
          }
          break
        }

        if (streamState.thinkingExtracted) {
          const rest = streamState.buffer
          streamState.buffer = ''
          if (rest) {
            deltaEvents.push(...createTextDeltaEvents(rest, streamState))
          }
          break
        }
      }

      yield* deltaEvents
    } else if (event.toolUseEvent) {
      const tc = event.toolUseEvent
      if (tc.name) totalContent += tc.name
      if (tc.input) totalContent += tc.input

      const toolUseId = tc.toolUseId
      if (typeof toolUseId === 'string' && toolUseId.length > 0) {
        let accumulated = toolCallFragments.get(toolUseId)
        if (!accumulated) {
          accumulated = { toolUseId, input: '' }
          toolCallFragments.set(toolUseId, accumulated)
          toolCallOrder.push(toolUseId)
        }
        if (typeof tc.name === 'string' && tc.name.length > 0) {
          accumulated.name = restoreToolName(tc.name, toolNameMap)
        }
        const fragment =
          tc.input === undefined
            ? ''
            : typeof tc.input === 'string'
              ? tc.input
              : (JSON.stringify(tc.input) ?? '')
        accumulated.input += fragment

        if (streamToolInput) {
          // A new call starting means the previous one is complete.
          if (openTool && openTool.toolUseId !== toolUseId) yield* closeOpenTool()

          if (!openTool && accumulated.name && !streamedToolIds.has(toolUseId)) {
            // Opened only once the name is known; anything that arrived before
            // it is sent as the first delta.
            yield* closeTextAndThinking()
            const index = streamState.nextBlockIndex++
            openTool = { toolUseId, index }
            streamedToolIds.add(toolUseId)
            yield {
              type: 'content_block_start',
              index,
              content_block: { type: 'tool_use', id: toolUseId, name: accumulated.name, input: {} }
            }
            if (accumulated.input) {
              yield {
                type: 'content_block_delta',
                index,
                delta: { type: 'input_json_delta', partial_json: accumulated.input }
              }
            }
          } else if (openTool && openTool.toolUseId === toolUseId && fragment) {
            yield {
              type: 'content_block_delta',
              index: openTool.index,
              delta: { type: 'input_json_delta', partial_json: fragment }
            }
          }

          if (tc.stop && openTool && openTool.toolUseId === toolUseId) yield* closeOpenTool()
        }
      }
    } else if (event.meteringEvent) {
      const usage = event.meteringEvent.usage
      if (typeof usage === 'number' && Number.isFinite(usage)) credits = (credits ?? 0) + usage
    } else if (event.metadataEvent) {
      if (event.metadataEvent.contextUsagePercentage) {
        contextUsagePercentage = event.metadataEvent.contextUsagePercentage
      }
    } else if ((event as any).contextUsageEvent) {
      const cue = (event as any).contextUsageEvent
      if (cue.contextUsagePercentage) {
        contextUsagePercentage = cue.contextUsagePercentage
      }
    }
  }

  yield* closeOpenTool()

  const toolCalls = toolCallOrder
    .map((toolUseId) => toolCallFragments.get(toolUseId))
    .filter((toolCall): toolCall is ToolCallState => typeof toolCall?.name === 'string')

  if (thinkingRequested && streamState.buffer) {
    if (streamState.inThinking) {
      yield* createThinkingDeltaEvents(streamState.buffer, streamState)
      streamState.buffer = ''
      yield* createThinkingDeltaEvents('', streamState)
      yield* stopBlock(streamState.thinkingBlockIndex, streamState)
    } else {
      yield* createTextDeltaEvents(streamState.buffer, streamState)
      streamState.buffer = ''
    }
  }

  // Both blocks must be closed before any tool_use block opens. The thinking
  // block is normally stopped when the first assistant text arrives, but a model
  // that reasons natively and then calls a tool emits no text at all — that path
  // used to leave the thinking block open, and Claude Code stalls on a content
  // block that never receives its content_block_stop. stopBlock is idempotent.
  yield* stopBlock(streamState.thinkingBlockIndex, streamState)
  yield* stopBlock(streamState.textBlockIndex, streamState)

  const bracketToolCalls = parseBracketToolCalls(totalContent)
  if (bracketToolCalls.length > 0) {
    for (const btc of bracketToolCalls) {
      toolCalls.push({
        toolUseId: btc.toolUseId,
        name: restoreToolName(btc.name, toolNameMap),
        input: typeof btc.input === 'string' ? btc.input : JSON.stringify(btc.input)
      })
    }
  }

  // Calls already streamed incrementally are complete; only the rest (buffered
  // mode, a call whose name never arrived in time, bracket calls) go out here.
  // toolCalls itself stays whole for stop_reason and the token estimate.
  const pendingToolCalls = toolCalls.filter((tc) => !streamedToolIds.has(tc.toolUseId))

  if (pendingToolCalls.length > 0) {
    const baseIndex = streamState.nextBlockIndex
    for (let i = 0; i < pendingToolCalls.length; i++) {
      const tc = pendingToolCalls[i]
      if (!tc) continue
      const blockIndex = baseIndex + i

      yield {
        type: 'content_block_start',
        index: blockIndex,
        content_block: {
          type: 'tool_use',
          id: tc.toolUseId,
          name: tc.name,
          input: {}
        }
      }

      let inputJson: string
      try {
        inputJson = JSON.stringify(JSON.parse(tc.input))
      } catch {
        inputJson = tc.input
      }

      yield {
        type: 'content_block_delta',
        index: blockIndex,
        delta: { type: 'input_json_delta', partial_json: inputJson }
      }

      yield { type: 'content_block_stop', index: blockIndex }
    }
  }

  // Every billed output byte, not just assistant text: reasoning and serialized
  // tool arguments are output too. Counting text alone under-reported
  // output_tokens and, because inputTokens is derived by subtracting it from the
  // context-usage total below, over-reported input_tokens by the same amount.
  const toolOutputChars = toolCalls.reduce(
    (sum, tc) => sum + tc.name.length + (tc.input?.length ?? 0),
    0
  )
  outputTokens = estimateTokens(textOnlyContent + reasoningContent) + Math.ceil(toolOutputChars / 4)

  if (contextUsagePercentage !== null && contextUsagePercentage > 0) {
    const contextWindow = getContextWindowSize(model)
    const totalTokens = Math.round((contextWindow * contextUsagePercentage) / 100)
    inputTokens = Math.max(0, totalTokens - outputTokens)
  }

  yield {
    type: 'message_delta',
    delta: { stop_reason: toolCalls.length > 0 ? 'tool_use' : 'end_turn', stop_sequence: null },
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0
    },
    ...(credits !== null ? { metering: { credits } } : {})
  }

  yield { type: 'message_stop' }
}

/**
 * OpenAI chat.completion.chunk view of the SDK stream.
 *
 * Thin adapter over transformSdkStreamEvents; convertToOpenAI returns null for
 * Anthropic-only events (message_start, content_block_stop, message_stop),
 * which are dropped here.
 */
export async function* transformSdkStream(
  sdkResponse: any,
  model: string,
  conversationId: string,
  toolNameMap?: ToolNameMap,
  options: StreamTransformOptions = {}
): AsyncGenerator<any> {
  for await (const event of transformSdkStreamEvents(
    sdkResponse,
    model,
    conversationId,
    toolNameMap,
    options
  )) {
    const chunk = convertToOpenAI(event, conversationId, model)
    if (chunk !== null) yield chunk
  }
}
