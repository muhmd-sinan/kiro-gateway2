import type { IncomingMessage, ServerResponse } from 'node:http'
import { createServer } from 'node:http'
import { KiroRequestError } from '../core/request/request-handler.js'
import * as logger from '../plugin/logger.js'
import { anthropicPing, newMessageId } from '../plugin/streaming/anthropic-sse.js'
import type { StreamEvent } from '../plugin/streaming/index.js'
import { collectAnthropicMessage, createAnthropicSerializer } from '../plugin/streaming/index.js'
import type { ServerConfig } from './config.js'
import { isPubliclyBound } from './config.js'
import { listPublicModels, publicModelDisplayName } from './model-alias.js'
import { collectOpenAICompletion, createOpenAISerializer } from './openai-sse.js'
import { deriveConversationRequest, type KiroRuntime } from './runtime.js'

const MAX_BODY_BYTES = 64 * 1024 * 1024

interface RouteContext {
  req: IncomingMessage
  res: ServerResponse
  body: any
  runtime: KiroRuntime
  config: ServerConfig
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const data = JSON.stringify(payload)
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(data)
  })
  res.end(data)
}

/**
 * OpenAI-shaped error envelope.
 *
 * The message is passed through verbatim. Hermes classifies failures by reading
 * the body (a `stream_options` rejection triggers a retry without it; a
 * max_tokens rejection that reads like a context error sends it into a
 * compression loop), so rewording upstream errors breaks its recovery paths.
 */
function sendOpenAIError(
  res: ServerResponse,
  status: number,
  message: string,
  code?: string
): void {
  sendJson(res, status, {
    error: {
      message,
      type: status >= 500 ? 'api_error' : 'invalid_request_error',
      code: code ?? null
    }
  })
}

/**
 * Anthropic-shaped error envelope.
 *
 * Claude Code's auto-recovery matches on upstream error wording, so like the
 * OpenAI path the message is never rewritten.
 */
function sendAnthropicError(
  res: ServerResponse,
  status: number,
  message: string,
  // Present so both error senders share one signature and can be picked per
  // route. Anthropic's envelope has no machine-code field.
  _code?: string
): void {
  const type =
    status === 401
      ? 'authentication_error'
      : status === 429
        ? 'rate_limit_error'
        : status === 400
          ? 'invalid_request_error'
          : status >= 500
            ? 'api_error'
            : 'invalid_request_error'
  sendJson(res, status, { type: 'error', error: { type, message } })
}

/** Extract the bearer credential from either header style. */
function readCredential(req: IncomingMessage): string | undefined {
  const apiKey = req.headers['x-api-key']
  if (typeof apiKey === 'string' && apiKey) return apiKey

  const auth = req.headers.authorization
  if (typeof auth === 'string' && auth) {
    return auth.startsWith('Bearer ') ? auth.slice(7).trim() : auth.trim()
  }
  return undefined
}

/**
 * Start streaming: commit headers and disable buffering.
 *
 * Both clients stall on a buffered response, and Claude Code additionally aborts
 * a stream that emits no bytes for 300s. `flushHeaders` gets the response line
 * out before the first upstream token, and Nagle is disabled so small SSE frames
 * leave immediately.
 */
function beginStream(res: ServerResponse): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  })
  res.flushHeaders?.()
  res.socket?.setNoDelay(true)
}

/**
 * Pump serialized frames to the client with a keep-alive timer.
 *
 * Kiro can sit silent for minutes while a model reasons before emitting the
 * first token. `keepAlive` is sent on a timer rather than between events so the
 * gap that matters — before the first event — is also covered.
 */
async function pumpStream(
  res: ServerResponse,
  events: AsyncGenerator<StreamEvent>,
  serialize: (event: StreamEvent) => string[],
  finish: () => string[],
  keepAlive: string | null,
  keepAliveSeconds: number
): Promise<void> {
  let timer: NodeJS.Timeout | undefined
  // One interval for the whole stream, checked against the last real write.
  // Tearing the timer down and rebuilding it per event cost two timer-heap
  // operations on every token, which on a long answer is thousands of them for a
  // keep-alive that almost never fires.
  let lastWrite = Date.now()

  if (keepAlive && keepAliveSeconds > 0) {
    const intervalMs = keepAliveSeconds * 1000
    timer = setInterval(() => {
      if (res.writableEnded) return
      if (Date.now() - lastWrite < intervalMs) return
      res.write(keepAlive)
      lastWrite = Date.now()
    }, intervalMs)
  }

  // The client hanging up (Esc in Claude Code, a killed agent) used to go
  // unnoticed: the loop kept draining Kiro's stream to the end, spending credits
  // and holding a concurrency slot, and in the web-search loop it could go on to
  // run more searches and more upstream calls for a reader that was gone.
  // `return()` on the generator unwinds it through its finally blocks, which is
  // what stops runServerToolLoop from issuing another iteration.
  let disconnected = false
  const onClose = () => {
    if (res.writableFinished) return
    disconnected = true
    void events.return(undefined).catch(() => {})
  }
  res.on('close', onClose)

  try {
    for await (const event of events) {
      if (disconnected) break
      const frames = serialize(event)
      // One write per event, not per frame: with Nagle off (beginStream), each
      // write can become its own TCP packet, and a thinking block's close is two
      // frames (signature_delta + content_block_stop).
      if (frames.length === 1) res.write(frames[0])
      else if (frames.length > 1) res.write(frames.join(''))
      lastWrite = Date.now()
    }
    if (!disconnected) {
      for (const frame of finish()) {
        res.write(frame)
      }
    }
  } finally {
    if (timer) clearInterval(timer)
    res.off('close', onClose)
  }
}

/** POST /v1/chat/completions — OpenCode and Hermes Agent. */
async function handleChatCompletions(ctx: RouteContext): Promise<void> {
  const { res, body, runtime, config } = ctx
  const wantsStream = body.stream !== false
  const includeUsage = body.stream_options?.include_usage !== false

  const thinking =
    body.reasoning_effort !== undefined && body.reasoning_effort !== 'none'
      ? true
      : !!body.thinking || !!body.thinkingConfig

  const { events, prep, model } = await runtime.stream({
    body,
    model: body.model,
    defaultModel: config.defaultModel,
    conversation: deriveConversationRequest(ctx.req.headers, body, 'openai'),
    thinking
  })

  if (!wantsStream) {
    sendJson(res, 200, await collectOpenAICompletion(events, prep.conversationId, model))
    return
  }

  const serializer = createOpenAISerializer(prep.conversationId, model, { includeUsage })
  beginStream(res)
  // OpenAI SSE has no ping event; a comment line is the conventional keep-alive
  // and every compliant parser ignores it.
  await pumpStream(
    res,
    events,
    serializer.serialize,
    serializer.finish,
    ': keep-alive\n\n',
    config.keepAliveSeconds
  )
  res.end()
}

/** POST /v1/messages — Claude Code. */
async function handleMessages(ctx: RouteContext): Promise<void> {
  const { res, body, runtime, config } = ctx
  const wantsStream = body.stream !== false

  // Claude Code sends `thinking: {type: "adaptive"}` on models it doesn't
  // recognize, which includes every id we advertise. Treat adaptive/enabled as a
  // request for thinking; `budget_tokens` is read downstream for the effort map.
  const thinking = body.thinking?.type === 'enabled' || body.thinking?.type === 'adaptive'

  const { events, prep, model } = await runtime.stream({
    body,
    model: body.model,
    defaultModel: config.defaultModel,
    conversation: deriveConversationRequest(ctx.req.headers, body, 'anthropic'),
    thinking,
    // Anthropic-only: handle the server-side web_search tool here rather than
    // forwarding a tool the client has no executor for. See server-tools.ts.
    serverTools: true
  })

  if (!wantsStream) {
    // Not prep.conversationId: that id is stable for the whole chat, so every
    // turn would report the same message id. See newMessageId.
    sendJson(res, 200, await collectAnthropicMessage(events, newMessageId(), model))
    return
  }

  const serialize = createAnthropicSerializer()
  beginStream(res)
  await pumpStream(res, events, serialize, () => [], anthropicPing(), config.keepAliveSeconds)
  res.end()
}

/**
 * POST /v1/messages/count_tokens — optional for Claude Code.
 *
 * Kiro exposes no token counter, and Anthropic documents this endpoint as the
 * only optional one: without it Claude Code falls back to a character estimate
 * and `/context` shows approximate numbers. Returning our own estimate is
 * strictly better than a 404, and matches what the streaming path reports.
 */
function handleCountTokens(ctx: RouteContext): void {
  sendJson(ctx.res, 200, { input_tokens: estimateInputTokens(ctx.body) })
}

/**
 * Flat per-attachment estimate.
 *
 * Anthropic bills an image at roughly width×height/750 tokens, capped near 1600
 * once it is downscaled to its maximum size; we don't decode the image, so the
 * cap is the honest upper bound.
 */
const TOKENS_PER_ATTACHMENT = 1600

/**
 * Character-based token estimate that does not count binary payloads as text.
 *
 * The old version stringified the whole body, base64 included, and divided by
 * four. A single screenshot is hundreds of kilobytes of base64, so one image
 * read as hundreds of thousands of tokens and Claude Code auto-compacted a
 * conversation that was nowhere near full.
 */
export function estimateInputTokens(body: any): number {
  let attachments = 0
  const serialized = JSON.stringify(
    { system: body?.system ?? '', messages: body?.messages ?? [], tools: body?.tools ?? [] },
    (key, value) => {
      if (
        value &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        (value.type === 'image' || value.type === 'document' || value.type === 'image_url')
      ) {
        attachments++
        return undefined
      }
      // Base64 left anywhere else (e.g. inside a tool_result) is still binary.
      if (key === 'data' && typeof value === 'string' && value.length > 1024) {
        attachments++
        return undefined
      }
      return value
    }
  )
  return Math.ceil(serialized.length / 4) + attachments * TOKENS_PER_ATTACHMENT
}

/** GET /v1/models — model discovery for both clients. */
function handleModels(ctx: RouteContext): void {
  const created = Math.floor(Date.now() / 1000)
  sendJson(ctx.res, 200, {
    object: 'list',
    data: listPublicModels().map((id) => ({
      id,
      object: 'model',
      created,
      owned_by: 'kiro',
      // Claude Code reads display_name when present in its picker.
      display_name: publicModelDisplayName(id)
    }))
  })
}

export interface ProxyServerHandle {
  url: string
  close: () => Promise<void>
}

export async function startProxyServer(
  runtime: KiroRuntime,
  config: ServerConfig
): Promise<ProxyServerHandle> {
  const server = createServer((req, res) => {
    void handleRequest(req, res, runtime, config)
  })

  // Long generations must not be cut off by the default socket timeout, and the
  // request timeout has to exceed the longest plausible Kiro turn.
  server.requestTimeout = 0
  server.headersTimeout = 60_000
  server.keepAliveTimeout = 75_000
  server.timeout = 0

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(config.port, config.host, () => {
      server.removeListener('error', reject)
      resolve()
    })
  })

  return {
    url: `http://${config.host}:${config.port}`,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve())
      })
  }
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  runtime: KiroRuntime,
  config: ServerConfig
): Promise<void> {
  const path = (req.url || '/').split('?')[0]!
  const method = req.method || 'GET'
  const isAnthropicRoute = path.startsWith('/v1/messages')
  const fail = isAnthropicRoute ? sendAnthropicError : sendOpenAIError

  try {
    if (method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'content-type, authorization, x-api-key, anthropic-version'
      })
      res.end()
      return
    }

    // Unauthenticated liveness probe. Claude Code sends HEAD /api/hello to warm
    // the connection and Anthropic documents it as rejectable, but answering it
    // is free and doubles as a health check for scripts.
    if (path === '/api/hello' || path === '/health') {
      if (method === 'HEAD') {
        res.writeHead(200)
        res.end()
        return
      }
      const accounts = runtime.accountCount()
      sendJson(res, accounts > 0 ? 200 : 503, {
        status: accounts > 0 ? 'ok' : 'no_accounts',
        accounts,
        models: listPublicModels().length,
        auth: runtime.auth.status().state
      })
      return
    }

    if (config.token) {
      const credential = readCredential(req)
      if (credential !== config.token) {
        fail(res, 401, 'Invalid or missing API credential.')
        return
      }
    }

    if (path === '/v1/models' && method === 'GET') {
      handleModels({ req, res, body: {}, runtime, config })
      return
    }

    // Re-authentication, so an expired account pool recovers without restarting
    // the server or having shell access to it.
    if (path === '/auth/status' && method === 'GET') {
      sendJson(res, 200, runtime.auth.status())
      return
    }
    if (path === '/auth/login' && method === 'POST') {
      const status = await runtime.auth.begin()
      sendJson(res, 200, {
        ...status,
        instructions: status.url
          ? `Open ${status.url} and enter code ${status.userCode}. Poll GET /auth/status to confirm.`
          : undefined
      })
      return
    }

    if (method !== 'POST') {
      fail(res, 405, `Method ${method} not allowed for ${path}`)
      return
    }

    const raw = await readBody(req)
    let body: any
    try {
      body = raw ? JSON.parse(raw) : {}
    } catch {
      fail(res, 400, 'Request body is not valid JSON.')
      return
    }

    const ctx: RouteContext = { req, res, body, runtime, config }

    if (path === '/v1/chat/completions') {
      await handleChatCompletions(ctx)
      return
    }
    if (path === '/v1/messages') {
      await handleMessages(ctx)
      return
    }
    if (path === '/v1/messages/count_tokens') {
      handleCountTokens(ctx)
      return
    }

    fail(res, 404, `Unknown endpoint: ${path}`)
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    const status = e instanceof KiroRequestError ? e.status : 500
    logger.error('Proxy request failed', { path, status, message })

    // Headers are already committed once streaming starts, so the only way to
    // signal failure is an in-band error event.
    if (res.headersSent) {
      if (!res.writableEnded) {
        const payload = isAnthropicRoute
          ? `event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'api_error', message } })}\n\n`
          : `data: ${JSON.stringify({ error: { message, type: 'api_error' } })}\n\ndata: [DONE]\n\n`
        res.write(payload)
        res.end()
      }
      return
    }

    fail(res, status, message, e instanceof KiroRequestError ? e.code : undefined)
  }
}

export function describeBinding(config: ServerConfig): string[] {
  const lines = [`Listening on http://${config.host}:${config.port}`]
  if (isPubliclyBound(config.host)) {
    lines.push(
      `WARNING: bound to ${config.host}, reachable from other machines. Anyone who can reach this port can spend your Kiro credits. Keep the bearer token secret or bind to 127.0.0.1.`
    )
  }
  if (!config.token) {
    lines.push(
      'WARNING: authentication is disabled (KIRO_PROXY_NO_AUTH). Any local process can use your Kiro account.'
    )
  }
  return lines
}
