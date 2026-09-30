import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/**
 * Maps client conversations onto stable Kiro conversationIds.
 *
 * Kiro derives server-side context from `conversationId`, so a chat must keep
 * one id for its whole life. Minting a fresh id mid-chat makes the model
 * re-derive its preamble and lose continuity; reusing one id across unrelated
 * chats bleeds context between them. Both are silent failures, which is why this
 * is more careful than a single hash.
 *
 * Two identification strategies, in priority order:
 *
 * 1. An explicit client session key (see `explicitKey`). Reliable when present.
 *    OpenCode and Claude Code both send one; Hermes does not.
 *
 * 2. Prefix-chain matching. Every request carries the full history, so turn N's
 *    message list starts with turn N-1's. We store a rolling hash of each
 *    conversation's normalized message list and, on a new request, look for a
 *    known chain that the incoming history *extends*. That tolerates multi-
 *    message growth (assistant + user arrive together) without assuming a fixed
 *    step size.
 *
 * A single-message request always starts a new conversation: a lone user message
 * is by definition the opening of a chat, so two different chats that happen to
 * open with the same text stay separate.
 */

const MAX_ENTRIES = 5000
const ENTRY_TTL_MS = 30 * 24 * 60 * 60 * 1000

interface Entry {
  /** Kiro conversationId. */
  id: string
  /** Last touched, for TTL pruning. */
  at: number
  /**
   * True once a later turn has extended this state.
   *
   * A chain entry represents "the conversation as it stood, awaiting its next
   * turn". Exactly one turn can consume it. Without this, two unrelated chats
   * that share an opening exchange would both match the same prefix and end up
   * sharing a Kiro conversation.
   */
  used?: boolean
}

const mem = new Map<string, Entry>()
let loaded = false
let dirty = false
/** Disabled in tests so cases never touch the user's real session map. */
let persist = true

function mapPath(): string {
  const override = process.env.KIRO_SESSION_MAP_PATH
  if (override) return override
  if (process.platform === 'win32') {
    return join(
      process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'),
      'opencode',
      'kiro-sessions.json'
    )
  }
  const root = process.env.XDG_CONFIG_HOME || join(homedir(), '.config')
  return join(root, 'opencode', 'kiro-sessions.json')
}

function load(): void {
  if (loaded) return
  loaded = true
  try {
    const p = mapPath()
    if (!existsSync(p)) return
    const data = JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>
    const now = Date.now()
    for (const [k, v] of Object.entries(data)) {
      // Legacy format stored a bare conversationId string.
      if (typeof v === 'string') {
        mem.set(k, { id: v, at: now })
      } else if (v && typeof v === 'object') {
        const entry = v as { id?: unknown; at?: unknown; used?: unknown }
        if (typeof entry.id === 'string') {
          mem.set(k, {
            id: entry.id,
            at: typeof entry.at === 'number' ? entry.at : now,
            used: entry.used === true
          })
        }
      }
    }
  } catch {
    // Corrupt map: start fresh rather than failing every request.
  }
}

/**
 * Drop expired entries, then the oldest if still over budget.
 *
 * The chain index grows by one entry per turn, so an unbounded map would become
 * a multi-megabyte file over months of use.
 */
function prune(): void {
  const cutoff = Date.now() - ENTRY_TTL_MS
  for (const [key, entry] of mem) {
    if (entry.at < cutoff) mem.delete(key)
  }
  if (mem.size <= MAX_ENTRIES) return
  const sorted = [...mem.entries()].sort((a, b) => a[1].at - b[1].at)
  for (const [key] of sorted.slice(0, mem.size - MAX_ENTRIES)) {
    mem.delete(key)
  }
}

/** Write the whole map to disk. Synchronous, so never call it inline. */
function flush(): void {
  if (!dirty) return
  dirty = false
  try {
    prune()
    const p = mapPath()
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, JSON.stringify(Object.fromEntries(mem)))
  } catch {
    // A failed write only costs continuity across restarts.
  }
}

let flushTimer: NodeJS.Timeout | undefined

/**
 * Schedule a write instead of performing one.
 *
 * Every request resolves a conversation id and marks the map dirty, and writing
 * it means pruning, sorting, serializing up to MAX_ENTRIES entries, and a
 * synchronous writeFileSync — all on the request path, before the upstream call
 * has even started. Coalescing to one write per second removes that from
 * latency; the timer is unref'd so a pending write cannot hold the process open,
 * and the exit hooks below cover the shutdown case.
 *
 * The in-memory map is the source of truth within a process, so a dropped write
 * only costs continuity across a restart — the same risk the old inline write
 * already accepted on failure.
 */
function save(): void {
  if (!dirty || !persist || flushTimer) return
  flushTimer = setTimeout(() => {
    flushTimer = undefined
    flush()
  }, 1000)
  flushTimer.unref?.()
}

// Long-lived hosts (the proxy, OpenCode) exit without draining timers, which
// would discard the newest turns of every open conversation.
if (typeof process !== 'undefined' && typeof process.once === 'function') {
  const onExit = () => {
    if (flushTimer) clearTimeout(flushTimer)
    flushTimer = undefined
    if (persist) flush()
  }
  process.once('exit', onExit)
  process.once('beforeExit', onExit)
}

function remember(key: string, id: string): void {
  mem.set(key, { id, at: Date.now() })
  dirty = true
}

function lookup(key: string): string | undefined {
  const entry = mem.get(key)
  if (!entry) return undefined
  // Touch so active conversations survive pruning.
  entry.at = Date.now()
  dirty = true
  return entry.id
}

/**
 * Claim a chain state as the parent of the incoming turn.
 *
 * Returns undefined when the state was already extended by a different turn,
 * which means this request belongs to a separate conversation that merely shares
 * a prefix.
 */
function claimChain(key: string): string | undefined {
  const entry = mem.get(key)
  if (!entry || entry.used) return undefined
  entry.used = true
  entry.at = Date.now()
  dirty = true
  return entry.id
}

/** Volatile context clients re-inject on every turn; must not affect identity. */
const SYSTEM_REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g

/**
 * Reduce one message to a fingerprint that is stable across replays.
 *
 * Clients mutate history in place between turns. Claude Code injects
 * `<system-reminder>` blocks into earlier user messages as files change, and
 * both clients add or move `cache_control` markers. Hashing raw JSON would treat
 * those edits as a different conversation and silently start a new one, so only
 * semantically meaningful parts are fingerprinted.
 */
function fingerprintMessage(message: any): string {
  const role = typeof message?.role === 'string' ? message.role : 'unknown'
  const parts: string[] = []

  const pushText = (value: unknown) => {
    if (typeof value !== 'string' || !value) return
    const cleaned = value.replace(SYSTEM_REMINDER, '').trim()
    if (cleaned) parts.push(cleaned)
  }

  const content = message?.content
  if (typeof content === 'string') {
    pushText(content)
  } else if (Array.isArray(content)) {
    for (const block of content) {
      if (typeof block === 'string') {
        pushText(block)
        continue
      }
      switch (block?.type) {
        case 'text':
          pushText(block.text)
          break
        case 'tool_use':
          // Tool ids are minted once and replayed verbatim, so they anchor the
          // turn better than the arguments, which clients may reformat.
          parts.push(`tool_use:${block.id ?? ''}:${block.name ?? ''}`)
          break
        case 'tool_result':
          parts.push(`tool_result:${block.tool_use_id ?? ''}`)
          break
        case 'image':
          parts.push('image')
          break
        case 'thinking':
          // Thinking text is regenerated and signatures rotate; only presence is
          // stable.
          parts.push('thinking')
          break
        default:
          if (typeof block?.text === 'string') pushText(block.text)
      }
    }
  }

  // OpenAI-shaped tool calls live beside content rather than inside it.
  if (Array.isArray(message?.tool_calls)) {
    for (const call of message.tool_calls) {
      parts.push(`tool_call:${call?.id ?? ''}:${call?.function?.name ?? ''}`)
    }
  }
  if (typeof message?.tool_call_id === 'string') {
    parts.push(`tool_result:${message.tool_call_id}`)
  }

  return `${role}|${parts.join('\u0001')}`
}

/**
 * Rolling hashes of the message list, one per prefix length.
 *
 * `chains[k]` identifies the conversation as it stood after k+1 messages, so a
 * later turn can recognize any earlier state it was built from.
 */
function buildChains(messages: any[], scope: string): string[] {
  const chains: string[] = []
  let running = createHash('sha256').update(scope).digest('hex')
  for (const message of messages) {
    running = createHash('sha256')
      .update(running)
      .update('\u0000')
      .update(fingerprintMessage(message))
      .digest('hex')
    chains.push(`chain:${running.slice(0, 32)}`)
  }
  return chains
}

export interface ConversationRequest {
  /**
   * Client-supplied conversation key, already namespaced (e.g. by subagent id).
   * Trusted outright when present.
   */
  explicitKey?: string
  /** Messages exactly as the client sent them. */
  messages?: unknown
  /**
   * Isolation scope mixed into chain hashes. Prevents two clients, or two
   * subagents, from colliding on identical message text.
   */
  scope?: string
}

/**
 * Resolve the Kiro conversationId for a request.
 *
 * Registers the incoming history so the next turn finds it, and returns an
 * existing id when the request continues a known conversation.
 */
export function resolveConversationId(request: ConversationRequest): string {
  load()

  const scope = request.scope || 'default'

  if (request.explicitKey) {
    const key = `session:${scope}:${request.explicitKey}`
    const existing = lookup(key)
    if (existing) {
      save()
      return existing
    }
    const id = randomUUID()
    remember(key, id)
    save()
    return id
  }

  const messages = Array.isArray(request.messages) ? request.messages : []
  if (messages.length === 0) return randomUUID()

  const chains = buildChains(messages, scope)

  // A lone user message opens a chat. Joining an existing conversation here
  // would merge unrelated chats that happen to start with the same text.
  if (messages.length > 1) {
    const head = chains[chains.length - 1]!

    // An exact replay of a state we've already seen (a retry, or a client
    // resending the same turn) must return the same id without consuming a new
    // chain slot.
    const exact = lookup(head)
    if (exact) {
      save()
      return exact
    }

    // Longest prefix first: prefer the most recent known state of this
    // conversation over an earlier one.
    for (let i = chains.length - 2; i >= 0; i--) {
      const existing = claimChain(chains[i]!)
      if (existing) {
        // Register the new head so the following turn matches in one step.
        remember(head, existing)
        save()
        return existing
      }
    }
  }

  const id = randomUUID()
  remember(chains[chains.length - 1]!, id)
  save()
  return id
}

/**
 * Legacy single-key lookup, kept for the OpenCode plugin path where a session
 * header is always present.
 */
export function conversationIdFor(sessionId?: string): string {
  if (!sessionId) return randomUUID()
  return resolveConversationId({ explicitKey: sessionId })
}

export function readSessionHeader(init: any): string | undefined {
  const h = init?.headers
  if (!h) return
  if (typeof h.get === 'function') {
    return h.get('x-opencode-session-id') || h.get('X-OpenCode-Session-Id') || undefined
  }
  return h['x-opencode-session-id'] || h['X-OpenCode-Session-Id']
}

/**
 * Test hook: clear state and stop writing to disk.
 *
 * Marks the map as already-loaded so tests never read the user's real session
 * file, which would make cases order-dependent on local state.
 */
export function __resetSessionMapForTests(): void {
  mem.clear()
  loaded = true
  dirty = false
  persist = false
  // A timer left over from an earlier case would fire mid-test and write the
  // user's real map, which `persist = false` exists to prevent.
  if (flushTimer) clearTimeout(flushTimer)
  flushTimer = undefined
}
