import * as crypto from 'crypto'
import * as os from 'os'
import { KIRO_CONSTANTS, buildUrl, extractRegionFromArn } from '../constants.js'
import {
  buildHistory,
  extractToolNamesFromHistory,
  historyHasToolCalling,
  injectSystemPrompt,
  type HistoryOptions
} from '../infrastructure/transformers/history-builder.js'
import {
  findOriginalToolCall,
  getContentText,
  mergeAdjacentMessages,
  parseToolArguments
} from '../infrastructure/transformers/message-transformer.js'
import {
  convertToolsToCodeWhisperer,
  createToolNameRegistry,
  deduplicateToolResults,
  toolResultStatus
} from '../infrastructure/transformers/tool-transformer.js'
import { attachDocuments, extractDocuments, hasDocuments } from './document-handler.js'
import { buildReasoningFields, getEffectiveEffort } from './effort.js'
import {
  convertImagesToKiroFormat,
  extractAllImages,
  extractTextFromParts
} from './image-handler.js'
import { resolveKiroModel } from './models.js'
import type {
  CodeWhispererRequest,
  Effort,
  KiroAuthDetails,
  PreparedRequest,
  SdkPreparedRequest,
  ToolNameMap
} from './types'

interface TransformResult {
  request: CodeWhispererRequest
  resolved: string
  convId: string
  toolNameMap: ToolNameMap
}

interface EffortConfig {
  effort?: Effort
  autoEffortMapping?: boolean
}

type ToastFunction = (message: string, variant: 'info' | 'warning' | 'success' | 'error') => void

/**
 * Accept both wire shapes for the system prompt.
 *
 * OpenAI-compatible clients send a plain string (or nothing, putting it in
 * `messages`). Claude Code sends an array of content blocks, each with its own
 * `cache_control`. Flattening to text is lossless for our purposes because
 * CodeWhisperer has no prompt-cache surface to pass `cache_control` through to.
 */
export function normalizeSystemPrompt(system: unknown): string {
  if (!system) return ''
  if (typeof system === 'string') return system
  if (Array.isArray(system)) {
    return system
      .map((block: any) => {
        if (typeof block === 'string') return block
        if (block?.type === 'text' && typeof block.text === 'string') return block.text
        return typeof block?.text === 'string' ? block.text : ''
      })
      .filter(Boolean)
      .join('\n\n')
  }
  return ''
}

function buildCodeWhispererRequest(
  body: any,
  model: string,
  auth: KiroAuthDetails,
  think = false,
  budget = 20000,
  showToast?: ToastFunction,
  conversationId?: string,
  historyOptions?: HistoryOptions
): TransformResult {
  const req = typeof body === 'string' ? JSON.parse(body) : body
  const { messages, tools, system } = req
  const convId = conversationId || crypto.randomUUID()
  if (!messages || messages.length === 0) throw new Error('No messages')
  const resolved = resolveKiroModel(model)
  const systemMsgs = messages.filter((m: any) => m.role === 'system')
  const otherMsgs = messages.filter((m: any) => m.role !== 'system')
  // Claude Code sends `system` as an array of content blocks, not a string.
  let sys = normalizeSystemPrompt(system)
  if (systemMsgs.length > 0) {
    const extractedSystem = systemMsgs.map((m: any) => getContentText(m)).join('\n\n')
    sys = sys ? `${sys}\n\n${extractedSystem}` : extractedSystem
  }
  // Thinking is requested natively via additionalModelRequestFields (see
  // buildReasoningFields), not by injecting <thinking_mode> markers into the
  // prompt. Kiro returns reasoning as reasoningContentEvent either way, and the
  // markers only consumed context — verified live: identical reasoning output
  // with and without them.
  const msgs = mergeAdjacentMessages([...otherMsgs])
  const lastMsg = msgs[msgs.length - 1]
  if (lastMsg && lastMsg.role === 'assistant' && getContentText(lastMsg) === '{') msgs.pop()
  const normalizedTools = Array.isArray(tools) ? tools : []
  const toolNameRegistry = createToolNameRegistry(normalizedTools)
  const cwTools = convertToolsToCodeWhisperer(normalizedTools, toolNameRegistry)
  let history = buildHistory(msgs, resolved, historyOptions)

  const curMsg = msgs[msgs.length - 1]
  if (!curMsg) throw new Error('Empty')

  const isRealUserMsg =
    curMsg.role === 'user' &&
    !(Array.isArray(curMsg.content) && curMsg.content.some((p: any) => p.type === 'tool_result'))

  if (isRealUserMsg && msgs.length >= 2) {
    const prevMsg = msgs[msgs.length - 2]
    if (prevMsg?.role === 'assistant') {
      const lastHistEntry = history[history.length - 1]
      const historyEndsWithUser = lastHistEntry?.userInputMessage
      if (historyEndsWithUser) {
        let prevText = ''
        if (Array.isArray(prevMsg.content)) {
          for (const p of prevMsg.content) {
            if (p.type === 'text') prevText += p.text || ''
          }
        } else prevText = getContentText(prevMsg)
        if (prevText) {
          history.push({ assistantResponseMessage: { content: prevText } })
        }
      }
    }
  }

  history = injectSystemPrompt(history, sys, resolved)
  let curContent = ''
  const curTrs: any[] = []
  const curImgs: any[] = []
  const curDocs: any[] = []

  if (curMsg.role === 'assistant') {
    const arm: any = { content: '' }
    let th = ''
    if (Array.isArray(curMsg.content)) {
      for (const p of curMsg.content) {
        if (p.type === 'text') arm.content += p.text || ''
        else if (p.type === 'thinking') th += p.thinking || p.text || ''
        else if (p.type === 'tool_use') {
          if (!arm.toolUses) arm.toolUses = []
          arm.toolUses.push({ input: p.input, name: p.name, toolUseId: p.id })
        }
      }
    } else arm.content = getContentText(curMsg)
    if ((curMsg as any).tool_calls && Array.isArray((curMsg as any).tool_calls)) {
      if (!arm.toolUses) arm.toolUses = []
      for (const tc of (curMsg as any).tool_calls) {
        arm.toolUses.push({
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

    if (arm.content || arm.toolUses) {
      history.push({ assistantResponseMessage: arm })
    }
    curContent = '[system: conversation continues]'
  } else {
    const prev = history[history.length - 1]
    if (prev && !prev.assistantResponseMessage)
      history.push({ assistantResponseMessage: { content: '[system: conversation continues]' } })
    if (curMsg.role === 'tool') {
      if (curMsg.tool_results) {
        for (const tr of curMsg.tool_results)
          curTrs.push({
            content: [{ text: getContentText(tr) }],
            status: 'success',
            toolUseId: tr.tool_call_id
          })
      } else {
        curTrs.push({
          content: [{ text: getContentText(curMsg) }],
          status: 'success',
          toolUseId: curMsg.tool_call_id
        })
      }
    } else if (Array.isArray(curMsg.content)) {
      curContent = extractTextFromParts(curMsg.content)

      for (const p of curMsg.content) {
        if (p.type === 'tool_result') {
          curTrs.push({
            content: [{ text: getContentText(p.content || p) }],
            status: toolResultStatus(p),
            toolUseId: p.tool_use_id
          })
        }
      }

      const unifiedImages = extractAllImages(curMsg.content)
      if (unifiedImages.length > 0) {
        const { images, omitted } = convertImagesToKiroFormat(unifiedImages)
        curImgs.push(...images)
        if (omitted > 0) {
          curContent += `\n\n[${omitted} image(s) omitted due to API limits]`
        }
      }

      // Proxy-only (see HistoryOptions.documents): the plugin path is unchanged.
      if (historyOptions?.documents && hasDocuments(curMsg.content)) {
        const target: any = { content: curContent }
        attachDocuments(target, extractDocuments(curMsg.content))
        curContent = target.content
        if (target.documents) curDocs.push(...target.documents)
      }
    } else curContent = getContentText(curMsg)
    if (!curContent)
      curContent = curTrs.length ? 'Tool results provided.' : '[system: conversation continues]'
  }
  const request: CodeWhispererRequest = {
    conversationState: {
      chatTriggerType: KIRO_CONSTANTS.CHAT_TRIGGER_TYPE_MANUAL,
      conversationId: convId,
      currentMessage: {
        userInputMessage: {
          content: curContent,
          modelId: resolved,
          origin: KIRO_CONSTANTS.ORIGIN_AI_EDITOR
        }
      }
    }
  }
  if (auth.profileArn) request.profileArn = auth.profileArn
  const toolUsesInHistory = history.flatMap((h) => h.assistantResponseMessage?.toolUses || [])
  const allToolUseIdsInHistory = new Set(toolUsesInHistory.map((tu) => tu.toolUseId))
  const finalCurTrs: any[] = []
  const orphanedTrs: any[] = []
  for (const tr of curTrs) {
    if (allToolUseIdsInHistory.has(tr.toolUseId)) finalCurTrs.push(tr)
    else {
      const originalCall = findOriginalToolCall(messages, tr.toolUseId)
      if (originalCall) {
        orphanedTrs.push({
          call: {
            name: originalCall.name || originalCall.function?.name || 'tool',
            toolUseId: tr.toolUseId,
            input: originalCall.input || parseToolArguments(originalCall.function?.arguments)
          },
          result: tr
        })
      } else {
        curContent += `\n\n[Output for tool call ${tr.toolUseId}]:\n${tr.content?.[0]?.text || ''}`
      }
    }
  }
  if (orphanedTrs.length > 0) {
    const prev = history[history.length - 1]
    if (!prev || prev.assistantResponseMessage) {
      history.push({
        userInputMessage: {
          content: 'Running tools...',
          modelId: resolved,
          origin: KIRO_CONSTANTS.ORIGIN_AI_EDITOR
        }
      })
    }
    history.push({
      assistantResponseMessage: {
        content: 'I will execute the following tools.',
        toolUses: orphanedTrs.map((o) => o.call)
      }
    })
    finalCurTrs.push(...orphanedTrs.map((o) => o.result))
  }

  // CodeWhisperer returns the names it received. Rewrite historical tool calls with the
  // same per-request registry used by current tool specifications so replay stays valid.
  for (const entry of history) {
    for (const toolUse of entry.assistantResponseMessage?.toolUses || []) {
      if (typeof toolUse.name === 'string' && toolUse.name.length > 0) {
        toolUse.name = toolNameRegistry.toWire(toolUse.name)
      }
    }
  }
  if (history.length > 0) (request.conversationState as any).history = history

  const uim = request.conversationState.currentMessage.userInputMessage
  if (uim) {
    uim.content = curContent
    if (curImgs.length) uim.images = curImgs
    if (curDocs.length) (uim as any).documents = curDocs
    const ctx: any = {}
    if (finalCurTrs.length) ctx.toolResults = deduplicateToolResults(finalCurTrs)
    if (cwTools.length) ctx.tools = cwTools
    if (Object.keys(ctx).length) uim.userInputMessageContext = ctx
    const hasToolsInHistory = historyHasToolCalling(history)
    if (hasToolsInHistory) {
      const toolNamesInHistory = extractToolNamesFromHistory(history)
      if (toolNamesInHistory.size > 0) {
        const existingTools = uim.userInputMessageContext?.tools || []
        const existingToolNames = new Set(
          existingTools.map((t: any) => t.toolSpecification?.name).filter(Boolean)
        )
        const missingToolNames = Array.from(toolNamesInHistory).filter(
          (name) => !existingToolNames.has(name)
        )
        if (missingToolNames.length > 0) {
          const placeholderTools = missingToolNames.map((name) => ({
            toolSpecification: {
              name,
              description: 'Tool',
              inputSchema: { json: { type: 'object', properties: {} } }
            }
          }))
          if (!uim.userInputMessageContext) uim.userInputMessageContext = {}
          uim.userInputMessageContext.tools = [...existingTools, ...placeholderTools]
        }
      }
    }
  }

  return { request, resolved, convId, toolNameMap: toolNameRegistry.toOriginalMap() }
}

export function transformToCodeWhisperer(
  url: string,
  body: any,
  model: string,
  auth: KiroAuthDetails,
  think = false,
  budget = 20000
): PreparedRequest {
  const { request, resolved, convId, toolNameMap } = buildCodeWhispererRequest(
    body,
    model,
    auth,
    think,
    budget
  )
  const osP = os.platform(),
    osR = os.release(),
    nodeV = process.version.replace('v', '')
  const osN =
    osP === 'win32' ? `windows#${osR}` : osP === 'darwin' ? `macos#${osR}` : `${osP}#${osR}`
  const ua = `aws-sdk-js/3.738.0 ua/2.1 os/${osN} lang/js md/nodejs#${nodeV} api/codewhisperer#3.738.0 m/E KiroIDE`
  return {
    url: buildUrl(KIRO_CONSTANTS.BASE_URL, extractRegionFromArn(auth.profileArn) ?? auth.region),
    init: {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${auth.access}`,
        'amz-sdk-invocation-id': crypto.randomUUID(),
        'amz-sdk-request': 'attempt=1; max=1',
        'x-amzn-kiro-agent-mode': 'vibe',
        'x-amz-user-agent': 'aws-sdk-js/3.738.0 KiroIDE',
        'user-agent': ua,
        Connection: 'close'
      },
      body: JSON.stringify(request)
    },
    streaming: true,
    effectiveModel: resolved,
    conversationId: convId,
    toolNameMap
  }
}

export function transformToSdkRequest(
  body: any,
  model: string,
  auth: KiroAuthDetails,
  think = false,
  budget = 20000,
  showToast?: ToastFunction,
  effortConfig?: EffortConfig,
  conversationId?: string,
  historyOptions?: HistoryOptions
): SdkPreparedRequest {
  const { request, resolved, convId, toolNameMap } = buildCodeWhispererRequest(
    body,
    model,
    auth,
    think,
    budget,
    showToast,
    conversationId,
    historyOptions
  )

  // Resolve effort level based on config and model capabilities
  const effort = getEffectiveEffort(
    resolved,
    think,
    budget,
    effortConfig?.effort,
    effortConfig?.autoEffortMapping ?? true
  )

  return {
    conversationState: request.conversationState,
    profileArn: request.profileArn,
    streaming: true,
    effectiveModel: resolved,
    conversationId: convId,
    region: extractRegionFromArn(auth.profileArn) ?? auth.region,
    toolNameMap,
    effort,
    reasoningFields: buildReasoningFields(resolved, think, effort)
  }
}
