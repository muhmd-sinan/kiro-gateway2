import { describe, expect, test } from 'bun:test'
import { MODEL_MAPPING } from '../constants.js'
import { applyThinking, listPublicModels, resolveModelId } from '../server/model-alias.js'

const DEFAULT = 'claude-sonnet-4-6'

describe('resolveModelId', () => {
  test('passes through ids Kiro already knows', () => {
    const resolved = resolveModelId('claude-opus-5', DEFAULT)
    expect(resolved).toEqual({ id: 'claude-opus-5', thinking: false, fallback: false })
  })

  test('maps Claude Code tier aliases to the newest model in each family', () => {
    expect(resolveModelId('sonnet', DEFAULT).id).toBe('claude-sonnet-5')
    expect(resolveModelId('opus', DEFAULT).id).toBe('claude-opus-5-5')
    // opusplan is what Claude Code sends for Opus in Plan Mode.
    expect(resolveModelId('opusplan', DEFAULT).id).toBe('claude-opus-5-5')
  })

  test('routes haiku/fast tiers to the cheapest model, not Sonnet', () => {
    // Claude Code uses the haiku tier for background work (session titles,
    // classifiers), so this runs on nearly every turn.
    expect(resolveModelId('haiku', DEFAULT).id).toBe('gpt-5.6-luna')
    expect(resolveModelId('claude-3-5-haiku-20241022', DEFAULT).id).toBe('gpt-5.6-luna')
  })

  test('strips Anthropic date stamps that Claude Code appends', () => {
    const resolved = resolveModelId('claude-opus-5-20250929', DEFAULT)
    expect(resolved.id).toBe('claude-opus-5')
    expect(resolved.fallback).toBe(false)
  })

  test('lifts retired models to the current one in the same family', () => {
    // Kiro still accepts these upstream, but they sit below the advertised
    // floor. Lifting beats rejecting: Hermes treats a model rejection as
    // permanent and bricks the session.
    expect(resolveModelId('claude-opus-4-5', DEFAULT).id).toBe('claude-opus-5-5')
    expect(resolveModelId('claude-opus-4-7', DEFAULT).id).toBe('claude-opus-5-5')
    expect(resolveModelId('claude-sonnet-4-5', DEFAULT).id).toBe('claude-sonnet-5')
  })

  test('routes dropped open-weight models to the cheapest advertised model', () => {
    for (const probe of ['qwen3-coder-next', 'deepseek-3.2', 'minimax-m2.5', 'minimax-m2.1']) {
      expect(resolveModelId(probe, DEFAULT).id).toBe('gpt-5.6-luna')
    }
  })

  test('reroutes claude-sonnet-5-1m, which Kiro rejects', () => {
    // Verified live: the 1M variant 400s while plain claude-sonnet-5 works.
    expect(resolveModelId('claude-sonnet-5-1m', DEFAULT).id).toBe('claude-sonnet-5')
  })

  test('keeps GPT tiers, which were explicitly retained', () => {
    expect(resolveModelId('gpt-5.6-luna', DEFAULT).id).toBe('gpt-5.6-luna')
    expect(resolveModelId('gpt-5.6-terra', DEFAULT).id).toBe('gpt-5.6-terra')
    expect(resolveModelId('gpt-5.6-sol', DEFAULT).id).toBe('gpt-5.6-sol')
  })

  test('sends unknown open-weight families to the cheap tier', () => {
    for (const probe of ['qwen-max', 'deepseek-v3', 'glm-4.6', 'kimi-k2', 'llama-3.1-70b']) {
      expect(resolveModelId(probe, DEFAULT).id).toBe('gpt-5.6-luna')
    }
  })

  test('every resolved model is Claude, GPT, or auto', () => {
    const probes = ['sonnet', 'opus', 'haiku', 'qwen-max', 'minimax-m2.5', 'unknown-xyz', 'gpt-4o']
    for (const probe of probes) {
      const { id } = resolveModelId(probe, DEFAULT)
      expect(
        id === 'auto' || id.startsWith('claude-') || id.startsWith('gpt-'),
        `${probe} → ${id}`
      ).toBe(true)
    }
  })

  test('strips a provider namespace prefix', () => {
    expect(resolveModelId('kiro/claude-opus-5', DEFAULT).id).toBe('claude-opus-5')
    expect(resolveModelId('anthropic/claude-opus-4-8', DEFAULT).id).toBe('claude-opus-4-8')
  })

  test('strips the OpenCode variant suffix, which carries no routing information', () => {
    expect(resolveModelId('claude-opus-5#high', DEFAULT).id).toBe('claude-opus-5')
  })

  test('strips the [1m] context marker Claude Code appends', () => {
    // The marker is stripped before matching, then PROXY_REDIRECTS points the
    // base Sonnet 4.6 id at the 1M wire model — so the resolved id is the -1m
    // one, which is what the advertised marker promises.
    expect(resolveModelId('claude-sonnet-4-6[1m]', DEFAULT).id).toBe('claude-sonnet-4-6-1m')
    expect(resolveModelId('claude-opus-5[1m]', DEFAULT).id).toBe('claude-opus-5')
  })

  test('detects the -thinking suffix and reports the base model', () => {
    const resolved = resolveModelId('claude-opus-5-thinking', DEFAULT)
    expect(resolved.id).toBe('claude-opus-5')
    expect(resolved.thinking).toBe(true)
  })

  test('infers a family for unknown ids rather than rejecting them', () => {
    // Hermes treats a hard model rejection as permanent and bricks the session,
    // so an unrecognized id must still resolve to something usable.
    expect(resolveModelId('claude-opus-9-future', DEFAULT).id).toBe('claude-opus-5-5')
    expect(resolveModelId('gpt-4o', DEFAULT).id).toBe('gpt-5.6-luna')
  })

  test('falls back to the configured default for wholly unrecognizable ids', () => {
    const resolved = resolveModelId('totally-made-up-model', DEFAULT)
    expect(resolved.id).toBe(DEFAULT)
    expect(resolved.fallback).toBe(true)
  })

  test('falls back when no model is supplied', () => {
    expect(resolveModelId(undefined, DEFAULT).id).toBe(DEFAULT)
    expect(resolveModelId('   ', DEFAULT).id).toBe(DEFAULT)
  })

  test('every resolved id is a valid MODEL_MAPPING key', () => {
    const probes = [
      'sonnet',
      'opus',
      'haiku',
      'fast',
      'default',
      'opusplan',
      'claude-local-main',
      'claude-local-fast',
      'kiro-auto',
      'claude-sonnet-4.6',
      'claude-opus-4.8',
      'claude-3-5-sonnet-20241022',
      'gpt-5-turbo',
      'qwen-max',
      'minimax-abc',
      'unknown-xyz'
    ]
    for (const probe of probes) {
      const { id } = resolveModelId(probe, DEFAULT)
      expect(MODEL_MAPPING[id], `${probe} → ${id}`).toBeDefined()
    }
  })
})

describe('applyThinking', () => {
  test('adds the suffix when a thinking variant exists', () => {
    expect(applyThinking('claude-opus-5', true)).toBe('claude-opus-5-thinking')
  })

  test('leaves models without a thinking variant untouched', () => {
    // qwen3-coder-next has no -thinking key; adding one would throw in
    // resolveKiroModel.
    expect(applyThinking('qwen3-coder-next', true)).toBe('qwen3-coder-next')
    expect(MODEL_MAPPING['qwen3-coder-next-thinking']).toBeUndefined()
  })

  test('is a no-op when thinking was not requested', () => {
    expect(applyThinking('claude-opus-5', false)).toBe('claude-opus-5')
  })
})

describe('listPublicModels', () => {
  test('omits -thinking entries, which are request modifiers not models', () => {
    expect(listPublicModels().some((id) => id.endsWith('-thinking'))).toBe(false)
  })

  test('advertises only resolvable ids', () => {
    // Advertised ids are not raw MODEL_MAPPING keys: they carry the `[1m]`
    // marker and GPT models wear their `claude-*` discovery aliases. What has to
    // hold is that sending one back resolves to a real key.
    for (const advertised of listPublicModels()) {
      const { id, fallback } = resolveModelId(advertised, DEFAULT)
      expect(fallback, advertised).toBe(false)
      expect(MODEL_MAPPING[id], `${advertised} → ${id}`).toBeDefined()
    }
  })

  test("includes ids Claude Code's discovery filter will keep", () => {
    // Claude Code drops any id without "claude" or "anthropic" in it.
    expect(listPublicModels().some((id) => id.includes('claude'))).toBe(true)
  })
})
