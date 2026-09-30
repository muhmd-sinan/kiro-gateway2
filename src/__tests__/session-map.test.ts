import { beforeEach, describe, expect, test } from 'bun:test'
import { __resetSessionMapForTests, resolveConversationId } from '../plugin/session-map.js'
import { deriveConversationRequest } from '../server/runtime.js'

/**
 * Kiro derives server-side context from conversationId, so these tests guard two
 * silent failure modes:
 *
 *  - A new id mid-chat: the model loses continuity and re-derives its preamble.
 *  - A shared id across unrelated chats: context bleeds between them.
 *
 * Both look like "the model got confused" rather than an error, which is why
 * they are covered explicitly.
 */

const user = (text: string) => ({ role: 'user', content: text })
const assistant = (text: string) => ({ role: 'assistant', content: text })

beforeEach(() => {
  __resetSessionMapForTests()
})

describe('resolveConversationId — explicit session keys', () => {
  test('reuses one id for a given key', () => {
    const a = resolveConversationId({ explicitKey: 'sess-1' })
    const b = resolveConversationId({ explicitKey: 'sess-1' })
    expect(a).toBe(b)
  })

  test('separates different keys', () => {
    const a = resolveConversationId({ explicitKey: 'sess-1' })
    const b = resolveConversationId({ explicitKey: 'sess-2' })
    expect(a).not.toBe(b)
  })

  test('separates the same key under different scopes', () => {
    // Prevents a subagent, or a second client, colliding with the main chat.
    const main = resolveConversationId({ explicitKey: 'sess-1', scope: 'anthropic' })
    const sub = resolveConversationId({ explicitKey: 'sess-1', scope: 'anthropic|agent:7' })
    expect(main).not.toBe(sub)
  })
})

describe('resolveConversationId — prefix-chain matching (no session header)', () => {
  test('keeps one id as a conversation grows turn by turn', () => {
    const turn1 = [user('hello')]
    const first = resolveConversationId({ messages: turn1 })

    const turn2 = [...turn1, assistant('hi there'), user('what is 2+2?')]
    const second = resolveConversationId({ messages: turn2 })

    const turn3 = [...turn2, assistant('4'), user('and times 3?')]
    const third = resolveConversationId({ messages: turn3 })

    expect(second).toBe(first)
    expect(third).toBe(first)
  })

  test('separates two chats that open with identical text', () => {
    // The original hash-the-first-message approach collided here, bleeding
    // context between unrelated conversations.
    const chatA = [user('hi'), assistant('Hello!'), user('my API key is SECRET')]
    const chatB = [user('hi'), assistant('Hello!'), user('write me a poem')]

    resolveConversationId({ messages: [user('hi')] })
    const a = resolveConversationId({ messages: chatA })
    const b = resolveConversationId({ messages: chatB })

    expect(a).not.toBe(b)
  })

  test('a lone user message always opens a new conversation', () => {
    const a = resolveConversationId({ messages: [user('same opener')] })
    const b = resolveConversationId({ messages: [user('same opener')] })
    expect(a).not.toBe(b)
  })

  test('tolerates system-reminder blocks injected into earlier turns', () => {
    // Claude Code rewrites earlier user messages as files change. Hashing raw
    // content would see a different conversation and silently start a new one.
    const turn1 = [{ role: 'user', content: [{ type: 'text', text: 'fix the bug' }] }]
    const first = resolveConversationId({ messages: turn1 })

    const turn2 = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'fix the bug' },
          { type: 'text', text: '<system-reminder>file changed on disk</system-reminder>' }
        ]
      },
      assistant('on it'),
      { role: 'user', content: [{ type: 'text', text: 'now run the tests' }] }
    ]
    const second = resolveConversationId({ messages: turn2 })

    expect(second).toBe(first)
  })

  test('tolerates added cache_control markers', () => {
    const turn1 = [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }]
    const first = resolveConversationId({ messages: turn1 })

    const turn2 = [
      {
        role: 'user',
        content: [{ type: 'text', text: 'hello', cache_control: { type: 'ephemeral' } }]
      },
      assistant('hi'),
      user('more')
    ]
    expect(resolveConversationId({ messages: turn2 })).toBe(first)
  })

  test('tracks a tool-calling loop through tool_use and tool_result turns', () => {
    const turn1 = [user('what is the weather in Paris?')]
    const first = resolveConversationId({ messages: turn1 })

    const turn2 = [
      ...turn1,
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Checking.' },
          { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'Paris' } }
        ]
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: '14C' }] }
        ]
      }
    ]
    expect(resolveConversationId({ messages: turn2 })).toBe(first)

    const turn3 = [...turn2, assistant('It is 14C.'), user('should I bring a coat?')]
    expect(resolveConversationId({ messages: turn3 })).toBe(first)
  })

  test('tracks OpenAI-shaped tool turns with null assistant content', () => {
    // Hermes replays assistant messages with content: null plus tool_calls.
    const turn1 = [user('weather in Tokyo?')]
    const first = resolveConversationId({ messages: turn1 })

    const turn2 = [
      ...turn1,
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{}' } }
        ]
      },
      { role: 'tool', tool_call_id: 'call_1', content: '{"temp_c":20}' }
    ]
    expect(resolveConversationId({ messages: turn2 })).toBe(first)
  })

  test('ignores regenerated thinking text and rotating signatures', () => {
    const turn1 = [user('compute 5*5')]
    const first = resolveConversationId({ messages: turn1 })

    const turn2 = [
      ...turn1,
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'five times five', signature: 'sig-abc' },
          { type: 'text', text: '25' }
        ]
      },
      user('now add 1')
    ]
    const second = resolveConversationId({ messages: turn2 })
    expect(second).toBe(first)

    // Same history replayed with different thinking text and a rotated signature
    // must still resolve to the same conversation.
    const turn3 = [
      ...turn1,
      {
        role: 'assistant',
        content: [
          {
            type: 'thinking',
            thinking: 'a totally different chain of thought',
            signature: 'sig-xyz'
          },
          { type: 'text', text: '25' }
        ]
      },
      user('now add 1'),
      assistant('26'),
      user('and double it')
    ]
    expect(resolveConversationId({ messages: turn3 })).toBe(first)
  })

  test('separates identical histories across different scopes', () => {
    const messages = [user('hello'), assistant('hi'), user('more')]
    const a = resolveConversationId({ messages, scope: 'openai' })
    __resetSessionMapForTests()
    const b = resolveConversationId({ messages, scope: 'anthropic|agent:3' })
    expect(a).not.toBe(b)
  })

  test('an identical retry of one turn reuses the same id', () => {
    // A client retrying after a network error, or two agents racing the same
    // turn, must not fork the conversation.
    const turn1 = [user('hello')]
    const first = resolveConversationId({ messages: turn1 })

    const turn2 = [...turn1, assistant('hi'), user('again')]
    const a = resolveConversationId({ messages: turn2 })
    const b = resolveConversationId({ messages: turn2 })

    expect(a).toBe(first)
    expect(b).toBe(first)
  })

  test('two branches from one shared state get separate conversations', () => {
    // Regenerating with a different follow-up is a fork, not a continuation of
    // the same Kiro conversation.
    const shared = [user('pick a number'), assistant('7')]
    resolveConversationId({ messages: [user('pick a number')] })
    resolveConversationId({ messages: shared.concat(user('why 7?')) })
    const branchB = resolveConversationId({ messages: shared.concat(user('pick again')) })
    const branchA = resolveConversationId({
      messages: shared.concat(user('why 7?'), assistant('because'), user('ok'))
    })
    expect(branchA).not.toBe(branchB)
  })

  test('starts a new conversation when history was truncated away', () => {
    // After compaction the client sends a summary it has never sent before, so
    // there is no chain to match and a fresh conversation is correct.
    resolveConversationId({ messages: [user('original opener'), assistant('a'), user('b')] })
    const compacted = resolveConversationId({
      messages: [user('[summary of prior conversation]'), assistant('ok'), user('continue')]
    })
    const original = resolveConversationId({
      messages: [user('original opener'), assistant('a'), user('b')]
    })
    expect(compacted).not.toBe(original)
  })

  test('returns an id even with no messages at all', () => {
    expect(resolveConversationId({})).toMatch(/^[0-9a-f-]{36}$/)
  })
})

describe('deriveConversationRequest', () => {
  test('uses the Claude Code session header', () => {
    const req = deriveConversationRequest(
      { 'x-claude-code-session-id': 'sess-abc' },
      { messages: [user('hi')] },
      'anthropic'
    )
    expect(req.explicitKey).toBe('sess-abc')
    expect(req.scope).toBe('anthropic')
  })

  test('namespaces subagents so they do not join the parent conversation', () => {
    // Claude Code sends the parent session id on subagent requests.
    const headers = { 'x-claude-code-session-id': 'sess-abc' }
    const main = deriveConversationRequest(headers, {}, 'anthropic')
    const sub = deriveConversationRequest(
      { ...headers, 'x-claude-code-agent-id': 'agent-7' },
      {},
      'anthropic'
    )

    expect(main.explicitKey).toBe(sub.explicitKey)
    expect(main.scope).not.toBe(sub.scope)
    expect(resolveConversationId(main)).not.toBe(resolveConversationId(sub))
  })

  test('isolates compaction and auxiliary calls from the conversation', () => {
    // These are one-shot summarizations over the history; joining the
    // conversation would append a summarization turn that later replays as real
    // history.
    const headers = {
      'x-claude-code-session-id': 'sess-abc',
      'x-claude-code-request-class': 'compaction'
    }
    const req = deriveConversationRequest(headers, { messages: [user('hi')] }, 'anthropic')
    expect(req.explicitKey).toBeUndefined()
    expect(req.scope).toContain('class:compaction')

    const main = deriveConversationRequest(
      { 'x-claude-code-session-id': 'sess-abc' },
      {},
      'anthropic'
    )
    expect(resolveConversationId(req)).not.toBe(resolveConversationId(main))
  })

  test('falls back to chain matching when no header is present', () => {
    // Hermes sends no session header.
    const req = deriveConversationRequest({}, { messages: [user('hi')] }, 'openai')
    expect(req.explicitKey).toBeUndefined()
    expect(req.messages).toHaveLength(1)
  })

  test('separates the OpenAI and Anthropic surfaces', () => {
    const a = deriveConversationRequest(
      {},
      { messages: [user('x'), assistant('y'), user('z')] },
      'openai'
    )
    const b = deriveConversationRequest(
      {},
      { messages: [user('x'), assistant('y'), user('z')] },
      'anthropic'
    )
    expect(a.scope).not.toBe(b.scope)
  })

  test('accepts array-valued headers without crashing', () => {
    const req = deriveConversationRequest({ 'x-session-id': ['first', 'second'] }, {}, 'openai')
    expect(req.explicitKey).toBe('first')
  })
})
