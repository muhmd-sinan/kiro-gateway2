import { describe, expect, test } from 'bun:test'
import { MODEL_MAPPING, RESOLVABLE_MODELS, SUPPORTED_MODELS } from '../constants.js'
import { resolveKiroModel } from '../plugin/models.js'

/**
 * The advertised model list is curated, not a mirror of everything Kiro accepts.
 * Kiro's backend still serves older and cheaper models (verified live against
 * generateAssistantResponse), but the floor here is Sonnet 4.6 and Opus 4.8.
 * These tests pin that policy so a model cannot be reintroduced by accident.
 */

const RETIRED_SLUGS = [
  'claude-sonnet-4',
  'claude-sonnet-4-5',
  'claude-opus-4-5',
  'claude-opus-4-6',
  'claude-opus-4-7',
  'deepseek-3.2',
  'qwen3-coder-next',
  'qwen3-coder-480b',
  'minimax-m2.5',
  'minimax-m2.1'
]

describe('resolveKiroModel', () => {
  test('resolves the advertised Claude models', () => {
    expect(resolveKiroModel('claude-sonnet-4-6')).toBe('claude-sonnet-4.6')
    expect(resolveKiroModel('claude-sonnet-4-6-1m')).toBe('claude-sonnet-4.6-1m')
    expect(resolveKiroModel('claude-sonnet-5')).toBe('claude-sonnet-5')
    expect(resolveKiroModel('claude-sonnet-5-5')).toBe('claude-sonnet-5.5')
    expect(resolveKiroModel('claude-sonnet-5-5-thinking')).toBe('claude-sonnet-5.5')
    expect(resolveKiroModel('claude-opus-4-8')).toBe('claude-opus-4.8')
    expect(resolveKiroModel('claude-opus-5')).toBe('claude-opus-5')
  })

  test('maps -thinking suffixes onto the same wire model', () => {
    // The suffix selects extended thinking; the upstream model id is unchanged.
    expect(resolveKiroModel('claude-opus-5-thinking')).toBe('claude-opus-5')
    expect(resolveKiroModel('claude-opus-4-8-thinking')).toBe('claude-opus-4.8')
    expect(resolveKiroModel('claude-sonnet-5-thinking')).toBe('claude-sonnet-5')
    expect(resolveKiroModel('claude-sonnet-4-6-1m-thinking')).toBe('claude-sonnet-4.6-1m')
  })

  test('resolves the GPT tiers', () => {
    expect(resolveKiroModel('gpt-5.6-luna')).toBe('gpt-5.6-luna')
    expect(resolveKiroModel('gpt-5.6-terra')).toBe('gpt-5.6-terra')
    expect(resolveKiroModel('gpt-5.6-sol')).toBe('gpt-5.6-sol')
  })

  test('advertises only Claude, GPT, and auto', () => {
    // Open-weight families are dropped entirely; this pins the surface so one
    // cannot creep back in.
    for (const id of SUPPORTED_MODELS) {
      expect(id === 'auto' || id.startsWith('claude-') || id.startsWith('gpt-'), id).toBe(true)
    }
  })

  test('resolves auto', () => {
    expect(resolveKiroModel('auto')).toBe('auto')
  })

  test('does not advertise models below the quality floor', () => {
    for (const slug of RETIRED_SLUGS) {
      expect(SUPPORTED_MODELS).not.toContain(slug)
    }
  })

  test('still resolves retired ids, so saved OpenCode sessions keep working', () => {
    // OpenCode persists the selected model per session and in opencode.json, and
    // the plugin resolves ids here directly rather than through the proxy's alias
    // layer. Throwing would break an existing session on every request.
    const lifted: Record<string, string> = {
      'claude-sonnet-4': 'claude-sonnet-4.6',
      'claude-sonnet-4-5': 'claude-sonnet-4.6',
      'claude-sonnet-4-5-thinking': 'claude-sonnet-4.6',
      'claude-opus-4-5': 'claude-opus-4.8',
      'claude-opus-4-6': 'claude-opus-4.8',
      'claude-opus-4-7': 'claude-opus-4.8',
      'claude-opus-4-7-thinking': 'claude-opus-4.8',
      'claude-sonnet-5-1m': 'claude-sonnet-5',
      'minimax-m2.5': 'gpt-5.6-luna',
      'minimax-m2.1': 'gpt-5.6-luna',
      'qwen3-coder-next': 'gpt-5.6-luna',
      'deepseek-3.2': 'gpt-5.6-luna'
    }
    for (const [legacy, expected] of Object.entries(lifted)) {
      expect(resolveKiroModel(legacy), legacy).toBe(expected)
    }
  })

  test('every resolvable id maps to a wire model Kiro accepts', () => {
    // Guards against a legacy alias pointing at a model that was itself removed.
    const advertisedWire = new Set(Object.values(MODEL_MAPPING))
    for (const [id, wire] of Object.entries(RESOLVABLE_MODELS)) {
      expect(advertisedWire.has(wire), `${id} → ${wire}`).toBe(true)
    }
  })

  test('legacy aliases stay out of the advertised list', () => {
    const legacyOnly = Object.keys(RESOLVABLE_MODELS).filter((id) => !SUPPORTED_MODELS.includes(id))
    expect(legacyOnly.length).toBeGreaterThan(0)
    for (const id of legacyOnly) {
      expect(SUPPORTED_MODELS).not.toContain(id)
    }
  })

  test('omits claude-sonnet-5-1m, which Kiro rejects', () => {
    // Verified live: the 1M variant returns 400 "Invalid model" even though
    // plain claude-sonnet-5 works. Advertising it would surface a hard failure.
    expect(SUPPORTED_MODELS).not.toContain('claude-sonnet-5-1m')
  })

  test('rejects unknown slugs', () => {
    expect(() => resolveKiroModel('this-model-does-not-exist')).toThrow(
      'Unsupported model: this-model-does-not-exist'
    )
  })

  test('every mapping target is a dotted Kiro wire id', () => {
    // OpenCode-facing keys use dashes (claude-opus-4-8); Kiro wants dots
    // (claude-opus-4.8). Mixing them up produces a 400 at request time.
    // Covers legacy aliases too, which are easy to typo in dashed form.
    for (const [key, wire] of Object.entries(RESOLVABLE_MODELS)) {
      expect(wire, `${key} → ${wire}`).not.toMatch(/-\d-\d/)
    }
  })
})
