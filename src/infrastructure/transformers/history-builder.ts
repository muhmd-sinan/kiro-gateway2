import { KIRO_CONSTANTS } from '../../constants.js'
import { attachDocuments, extractDocuments, hasDocuments } from '../../plugin/document-handler.js'
import {
  convertImagesToKiroFormat,
  extractAllImages,
  extractTextFromParts
} from '../../plugin/image-handler.js'
import type { CodeWhispererMessage } from '../../plugin/types'
import { getContentText, parseToolArguments } from './message-transformer.js'
import { deduplicateToolResults, toolResultStatus } from './tool-transformer.js'

const LOOP_PLACEHOLDER = '[system: tool calling continues]'

/**
 * Per-request history shaping, set only by the standalone proxy.
 *
 * The OpenCode plugin never passes these, so its history is built exactly as
 * before. They reach here through RequestHandler.execute, which only the proxy
 * calls.
 */
export interface HistoryOptions {
  /**
   * Keep images only in the N most recent image-bearing history messages;
   * older ones are replaced with a short text note. Undefined keeps every image.
   *
   * Every historical image is decoded and re-uploaded on every request, which is
   * the largest payload in a long session with screenshots.
   */
  historyImageMessages?: number
  /**
   * Keep the assistant's own text on intermediate tool-loop turns instead of
   * replacing it with a placeholder. Only exact repeats of the loop's first text
   * are still collapsed. See collapseAgenticLoops.
   */
  preserveLoopText?: boolean
  /**
   * Forward Anthropic `document` blocks (PDFs etc.) as Kiro documents instead of
   * dropping them. See document-handler.ts. Messages carrying documents count
   * toward `historyImageMessages` the same way images do, because they are
   * re-uploaded every turn just like images.
   */
  documents?: boolean
}

/**
 * Collapse agentic loop sequences in the built history.
 *
 * Written when each agentic iteration got a fresh conversationId, so the model
 * re-derived its preamble (intent detection, greeting) every iteration and, on
 * replay, saw a stack of duplicate preambles.
 *
 * By default strips text from intermediate ASST(toolUses)→USER(toolResults)
 * pairs, keeping only the first assistant text and all tool_use/tool_result
 * pairs. With `preserveLoopText`, which the proxy sets, only text identical to
 * the loop's first turn is stripped: conversation ids are now stable per chat
 * (session-map.ts), so the duplicate-preamble cause is gone, and the blanket
 * strip was deleting the model's own reasoning between tool calls.
 */
export function collapseAgenticLoops(
  history: CodeWhispererMessage[],
  preserveLoopText = false
): CodeWhispererMessage[] {
  if (history.length < 4) return history

  const result: CodeWhispererMessage[] = []
  let i = 0

  while (i < history.length) {
    const entry = history[i]

    if (
      entry?.assistantResponseMessage?.toolUses &&
      i + 1 < history.length &&
      history[i + 1]?.userInputMessage?.userInputMessageContext?.toolResults
    ) {
      const seqStart = i

      let j = i
      while (j < history.length) {
        const asst = history[j]
        if (!asst?.assistantResponseMessage?.toolUses) break
        const nextUser = j + 1 < history.length ? history[j + 1] : null
        if (!nextUser?.userInputMessage?.userInputMessageContext?.toolResults) break
        j += 2
      }

      const seqEnd = j
      const pairCount = (seqEnd - seqStart) / 2

      if (pairCount > 1) {
        const firstText = (history[seqStart]!.assistantResponseMessage!.content || '').trim()
        for (let k = seqStart; k < seqEnd; k += 2) {
          const asst = history[k]
          const user = history[k + 1]

          if (k === seqStart) {
            result.push(asst!)
          } else {
            const text = (asst!.assistantResponseMessage!.content || '').trim()
            // Empty content is replaced either way: an assistant turn with tool
            // uses but no text is what the placeholder always stood in for.
            const keep = preserveLoopText && text.length > 0 && text !== firstText
            result.push({
              assistantResponseMessage: {
                content: keep ? asst!.assistantResponseMessage!.content : LOOP_PLACEHOLDER,
                toolUses: asst!.assistantResponseMessage!.toolUses
              }
            })
          }
          result.push(user!)
        }
      } else {
        for (let k = seqStart; k < seqEnd; k++) {
          result.push(history[k]!)
        }
      }

      i = seqEnd
    } else {
      result.push(entry!)
      i++
    }
  }

  return result
}

/**
 * Indices of the history messages allowed to keep their images, or null to keep
 * all. The last message is the current turn and is never part of history.
 */
function imageKeepSet(
  msgs: any[],
  limit: number | undefined,
  countDocuments = false
): Set<number> | null {
  if (limit === undefined) return null
  const keep = new Set<number>()
  for (let i = msgs.length - 2; i >= 0 && keep.size < limit; i--) {
    const m = msgs[i]
    if (m?.role !== 'user' || !Array.isArray(m.content)) continue
    if (extractAllImages(m.content).length > 0 || (countDocuments && hasDocuments(m.content))) {
      keep.add(i)
    }
  }
  return keep
}

export function buildHistory(
  msgs: any[],
  resolved: string,
  options: HistoryOptions = {}
): CodeWhispererMessage[] {
  let history: CodeWhispererMessage[] = []
  const keepImages = imageKeepSet(msgs, options.historyImageMessages, options.documents)
  for (let i = 0; i < msgs.length - 1; i++) {
    const m = msgs[i]
    if (!m) continue
    if (m.role === 'user') {
      const uim: any = { content: '', modelId: resolved, origin: KIRO_CONSTANTS.ORIGIN_AI_EDITOR }
      const trs: any[] = []

      if (Array.isArray(m.content)) {
        uim.content = extractTextFromParts(m.content)

        for (const p of m.content) {
          if (p.type === 'tool_result') {
            trs.push({
              content: [{ text: getContentText(p.content || p) }],
              status: toolResultStatus(p),
              toolUseId: p.tool_use_id
            })
          }
        }

        const unifiedImages = extractAllImages(m.content)
        if (unifiedImages.length > 0) {
          if (keepImages && !keepImages.has(i)) {
            // Leave a marker so the model knows an image existed here, rather
            // than seeing its own earlier replies refer to nothing.
            uim.content += `\n\n[${unifiedImages.length} image(s) from an earlier turn omitted]`
          } else {
            const { images, omitted } = convertImagesToKiroFormat(unifiedImages)
            uim.images = images
            if (omitted > 0) {
              uim.content += `\n\n[${omitted} image(s) omitted due to API limits]`
            }
          }
        }

        if (options.documents && hasDocuments(m.content)) {
          if (keepImages && !keepImages.has(i)) {
            uim.content += '\n\n[document(s) from an earlier turn omitted]'
          } else {
            attachDocuments(uim, extractDocuments(m.content))
          }
        }
      } else {
        uim.content = getContentText(m)
      }

      if (trs.length) uim.userInputMessageContext = { toolResults: deduplicateToolResults(trs) }
      const prev = history[history.length - 1]
      if (prev && prev.userInputMessage)
        history.push({ assistantResponseMessage: { content: '[system: conversation continues]' } })
      history.push({ userInputMessage: uim })
    } else if (m.role === 'tool') {
      const trs: any[] = []
      if (m.tool_results) {
        for (const tr of m.tool_results)
          trs.push({
            content: [{ text: getContentText(tr) }],
            status: 'success',
            toolUseId: tr.tool_call_id
          })
      } else {
        trs.push({
          content: [{ text: getContentText(m) }],
          status: 'success',
          toolUseId: m.tool_call_id
        })
      }
      const prev = history[history.length - 1]
      if (prev && prev.userInputMessage)
        history.push({ assistantResponseMessage: { content: '[system: conversation continues]' } })
      history.push({
        userInputMessage: {
          content: 'Tool results provided.',
          modelId: resolved,
          origin: KIRO_CONSTANTS.ORIGIN_AI_EDITOR,
          userInputMessageContext: { toolResults: deduplicateToolResults(trs) }
        }
      })
    } else if (m.role === 'assistant') {
      const arm: any = { content: '' }
      const tus: any[] = []
      let th = ''
      if (Array.isArray(m.content)) {
        for (const p of m.content) {
          if (p.type === 'text') arm.content += p.text || ''
          else if (p.type === 'thinking') th += p.thinking || p.text || ''
          else if (p.type === 'tool_use')
            tus.push({ input: p.input, name: p.name, toolUseId: p.id })
        }
      } else arm.content = getContentText(m)
      if (m.tool_calls && Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls) {
          tus.push({
            input: parseToolArguments(tc.function?.arguments),
            name: tc.function?.name,
            toolUseId: tc.id
          })
        }
      }
      if (th)
        arm.content = arm.content
          ? `<thinking>${th}</thinking>\n\n${arm.content}`
          : `<thinking>${th}</thinking>`
      if (tus.length) arm.toolUses = tus

      if (!arm.content && !arm.toolUses) {
        continue
      }

      const prevMsg = history[history.length - 1]
      if (prevMsg && prevMsg.assistantResponseMessage) {
        // Merge consecutive assistant messages instead of injecting synthetic user turn
        const prev = prevMsg.assistantResponseMessage
        if (arm.content) {
          prev.content = prev.content ? `${prev.content}\n\n${arm.content}` : arm.content
        }
        if (arm.toolUses) {
          prev.toolUses = [...(prev.toolUses || []), ...arm.toolUses]
        }
      } else {
        history.push({ assistantResponseMessage: arm })
      }
    }
  }
  return collapseAgenticLoops(history, options.preserveLoopText)
}

export function injectSystemPrompt(
  history: CodeWhispererMessage[],
  system: string | undefined,
  resolved: string
): CodeWhispererMessage[] {
  if (!system) return history
  const firstUserMsg = history.find((h) => !!h.userInputMessage)
  if (firstUserMsg && firstUserMsg.userInputMessage) {
    const oldContent = firstUserMsg.userInputMessage.content || ''
    firstUserMsg.userInputMessage.content = `${system}\n\n${oldContent}`
  } else {
    history.unshift({
      userInputMessage: {
        content: system,
        modelId: resolved,
        origin: KIRO_CONSTANTS.ORIGIN_AI_EDITOR
      }
    })
  }
  return history
}

export function historyHasToolCalling(history: CodeWhispererMessage[]): boolean {
  return history.some(
    (h) =>
      h.assistantResponseMessage?.toolUses ||
      h.userInputMessage?.userInputMessageContext?.toolResults
  )
}

export function extractToolNamesFromHistory(history: CodeWhispererMessage[]): Set<string> {
  const toolNames = new Set<string>()
  for (const h of history) {
    if (h.assistantResponseMessage?.toolUses) {
      for (const tu of h.assistantResponseMessage.toolUses) {
        if (tu.name) toolNames.add(tu.name)
      }
    }
  }
  return toolNames
}
