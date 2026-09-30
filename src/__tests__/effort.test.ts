import { describe, expect, test } from 'bun:test'
import {
  budgetToEffort,
  buildReasoningFields,
  getEffectiveEffort,
  resolveEffort,
  supportsEffort,
  supportsThinkingToggle,
  supportsXHighEffort
} from '../plugin/effort.js'

/**
 * Effort capability is keyed on Kiro *wire* model ids (dotted), and only covers
 * the curated model set — retired models were removed from the capability sets
 * along with their MODEL_MAPPING entries, so they now report as unsupported.
 */
describe('effort module', () => {
  describe('supportsEffort', () => {
    test('returns true for the advertised Claude models', () => {
      expect(supportsEffort('claude-opus-4.8')).toBe(true)
      expect(supportsEffort('claude-opus-5')).toBe(true)
      expect(supportsEffort('claude-sonnet-4.6')).toBe(true)
      expect(supportsEffort('claude-sonnet-4.6-1m')).toBe(true)
      expect(supportsEffort('claude-sonnet-5')).toBe(true)
    })

    test('returns false for unsupported models', () => {
      expect(supportsEffort('claude-haiku-4.5')).toBe(false)
      expect(supportsEffort('unknown-model')).toBe(false)
    })

    test('returns false for retired models', () => {
      // These are no longer advertised, so nothing should be able to request
      // effort against them.
      expect(supportsEffort('claude-opus-4.5')).toBe(false)
      expect(supportsEffort('claude-opus-4.6')).toBe(false)
      expect(supportsEffort('claude-opus-4.7')).toBe(false)
      expect(supportsEffort('claude-sonnet-4.5')).toBe(false)
    })

    test('returns true for GPT tiers, which route effort through reasoning.effort', () => {
      // Verified live: GPT accepts `reasoning.effort` and rejects
      // `output_config.effort`; Claude is the reverse.
      expect(supportsEffort('gpt-5.6-luna')).toBe(true)
      expect(supportsEffort('gpt-5.6-terra')).toBe(true)
      expect(supportsEffort('gpt-5.6-sol')).toBe(true)
    })

    test('returns false for auto, whose target is unknown at request time', () => {
      // `auto` dispatches server-side, so a field valid for the chosen model
      // could be rejected by another. Sending nothing is the only safe option.
      expect(supportsEffort('auto')).toBe(false)
    })
  })

  describe('supportsXHighEffort', () => {
    test('returns true for opus 4.8/5 and sonnet 5', () => {
      expect(supportsXHighEffort('claude-opus-4.8')).toBe(true)
      expect(supportsXHighEffort('claude-opus-5')).toBe(true)
      expect(supportsXHighEffort('claude-sonnet-5')).toBe(true)
    })

    test('returns false for other models', () => {
      expect(supportsXHighEffort('claude-sonnet-4.6')).toBe(false)
      expect(supportsXHighEffort('claude-sonnet-4.6-1m')).toBe(false)
    })
  })

  describe('resolveEffort', () => {
    test('returns undefined for unsupported models', () => {
      expect(resolveEffort('claude-haiku-4.5', 'max')).toBeUndefined()
    })

    test('returns effort as-is for supported levels', () => {
      expect(resolveEffort('claude-opus-4.8', 'low')).toBe('low')
      expect(resolveEffort('claude-opus-4.8', 'max')).toBe('max')
      expect(resolveEffort('claude-opus-4.8', 'xhigh')).toBe('xhigh')
      expect(resolveEffort('claude-opus-5', 'xhigh')).toBe('xhigh')
      expect(resolveEffort('claude-opus-5', 'max')).toBe('max')
    })

    test('clamps xhigh to max for models without xhigh support', () => {
      expect(resolveEffort('claude-sonnet-4.6', 'xhigh')).toBe('max')
      expect(resolveEffort('claude-sonnet-4.6-1m', 'xhigh')).toBe('max')
    })
  })

  describe('budgetToEffort', () => {
    test('returns undefined for unsupported models', () => {
      expect(budgetToEffort(100000, 'claude-haiku-4.5')).toBeUndefined()
    })

    test('maps reference budgets to their effort level', () => {
      expect(budgetToEffort(16384, 'claude-opus-4.8')).toBe('low')
      expect(budgetToEffort(32768, 'claude-opus-4.8')).toBe('medium')
      expect(budgetToEffort(65536, 'claude-opus-4.8')).toBe('high')
      expect(budgetToEffort(98304, 'claude-opus-4.8')).toBe('xhigh')
      expect(budgetToEffort(128000, 'claude-opus-4.8')).toBe('max')
    })

    test('maps sub-band and over-ceiling budgets', () => {
      expect(budgetToEffort(1024, 'claude-opus-4.8')).toBe('low')
      expect(budgetToEffort(20000, 'claude-opus-4.8')).toBe('medium')
      expect(budgetToEffort(200000, 'claude-opus-4.8')).toBe('max')
    })

    test('reaches xhigh on every xhigh-capable model', () => {
      expect(budgetToEffort(98304, 'claude-opus-4.8')).toBe('xhigh')
      expect(budgetToEffort(98304, 'claude-opus-5')).toBe('xhigh')
      expect(budgetToEffort(98304, 'claude-sonnet-5')).toBe('xhigh')
    })

    test('clamps the xhigh band to max for non-xhigh models', () => {
      expect(budgetToEffort(98304, 'claude-sonnet-4.6')).toBe('max')
      expect(budgetToEffort(98304, 'claude-sonnet-4.6-1m')).toBe('max')
    })
  })

  describe('getEffectiveEffort', () => {
    test('returns undefined for unsupported models', () => {
      expect(getEffectiveEffort('claude-haiku-4.5', true, 100000)).toBeUndefined()
    })

    test('uses explicit config when provided', () => {
      expect(getEffectiveEffort('claude-opus-4.8', true, 20000, 'max')).toBe('max')
      expect(getEffectiveEffort('claude-opus-4.8', false, 20000, 'high')).toBe('high')
    })

    test('returns undefined when not thinking and no config', () => {
      expect(getEffectiveEffort('claude-opus-4.8', false, 20000)).toBeUndefined()
    })

    test('uses budget mapping when thinking and auto-mapping enabled', () => {
      expect(getEffectiveEffort('claude-opus-4.8', true, 128000, undefined, true)).toBe('max')
      expect(getEffectiveEffort('claude-opus-4.8', true, 20000, undefined, true)).toBe('medium')
      expect(getEffectiveEffort('claude-opus-5', true, 98304, undefined, true)).toBe('xhigh')
      expect(getEffectiveEffort('claude-opus-5', true, 32768, undefined, true)).toBe('medium')
      expect(getEffectiveEffort('claude-opus-5', true, 8192, undefined, true)).toBe('low')
    })

    test('falls back to medium when auto-mapping disabled', () => {
      expect(getEffectiveEffort('claude-opus-4.8', true, 128000, undefined, false)).toBe('medium')
    })
  })

  /**
   * buildReasoningFields produces the exact additionalModelRequestFields payload
   * Kiro validates against a per-model schema. Every expectation here was
   * confirmed against the live generateAssistantResponse endpoint.
   */
  describe('buildReasoningFields', () => {
    test('never sends thinking.type "disabled" to Opus 5.5', () => {
      // Verified live: Opus 5.5's schema only accepts "adaptive" and 400s on
      // "disabled", so a non-thinking request omits the field entirely.
      expect(buildReasoningFields('claude-opus-5.5', false)).toBeUndefined()
      expect(buildReasoningFields('claude-opus-5.5', true)).toEqual({
        thinking: { type: 'adaptive' }
      })
    })

    test('puts Claude effort under output_config', () => {
      expect(buildReasoningFields('claude-opus-5', true, 'max')).toEqual({
        output_config: { effort: 'max' },
        thinking: { type: 'adaptive' }
      })
    })

    test('puts GPT effort under reasoning', () => {
      // The paths are not interchangeable: Kiro 400s on the wrong one.
      expect(buildReasoningFields('gpt-5.6-sol', true, 'high')).toEqual({
        reasoning: { effort: 'high' }
      })
    })

    test('omits the thinking toggle on models that do not expose one', () => {
      const fields = buildReasoningFields('gpt-5.6-luna', true, 'low')
      expect(fields).toBeDefined()
      expect('thinking' in fields!).toBe(false)
    })

    test('disables thinking explicitly when not requested', () => {
      // Omitting the field leaves Kiro's adaptive default on, so suppressing
      // reasoning requires stating it.
      expect(buildReasoningFields('claude-opus-5', false)).toEqual({
        thinking: { type: 'disabled' }
      })
    })

    test('honours an explicit effort even when thinking was not requested', () => {
      // An effort level is itself a request to reason, so it must not be paired
      // with thinking.type=disabled.
      const fields = buildReasoningFields('claude-opus-5', false, 'high')
      expect(fields).toEqual({ output_config: { effort: 'high' } })
    })

    test('returns undefined for auto, so the key is omitted entirely', () => {
      // An empty object would still be sent and could 400 on the chosen target.
      expect(buildReasoningFields('auto', true, 'max')).toBeUndefined()
      expect(buildReasoningFields('auto', false)).toBeUndefined()
    })

    test('rejects the wrong effort path for each family', () => {
      // Claude 400s on reasoning.effort and GPT 400s on output_config.effort, so
      // the payload must never contain the other family's path.
      const claudeFields = buildReasoningFields('claude-opus-5', true, 'high')!
      expect('reasoning' in claudeFields).toBe(false)

      const gptFields = buildReasoningFields('gpt-5.6-sol', true, 'high')!
      expect('output_config' in gptFields).toBe(false)
      expect('thinking' in gptFields).toBe(false)
    })

    test('clamps xhigh to max on models that reject it', () => {
      expect(buildReasoningFields('claude-sonnet-4.6', true, 'xhigh')).toEqual({
        output_config: { effort: 'max' },
        thinking: { type: 'adaptive' }
      })
    })

    test('passes xhigh through on models that accept it', () => {
      expect(buildReasoningFields('claude-opus-5', true, 'xhigh')).toEqual({
        output_config: { effort: 'xhigh' },
        thinking: { type: 'adaptive' }
      })
    })

    test('never emits an empty object', () => {
      // An empty additionalModelRequestFields is indistinguishable from a bug and
      // adds a field for no behaviour.
      for (const model of ['claude-opus-5', 'gpt-5.6-sol', 'claude-sonnet-4.6']) {
        for (const thinking of [true, false]) {
          const fields = buildReasoningFields(model, thinking)
          if (fields) expect(Object.keys(fields).length).toBeGreaterThan(0)
        }
      }
    })
  })

  describe('supportsThinkingToggle', () => {
    test('is true for Claude and false for GPT', () => {
      // GPT rejects thinking.type outright: "Invalid
      // additionalModelRequestFields: property 'thinking'".
      expect(supportsThinkingToggle('claude-opus-5')).toBe(true)
      expect(supportsThinkingToggle('claude-sonnet-4.6')).toBe(true)
      expect(supportsThinkingToggle('gpt-5.6-luna')).toBe(false)
      expect(supportsThinkingToggle('gpt-5.6-sol')).toBe(false)
      expect(supportsThinkingToggle('auto')).toBe(false)
    })
  })
})
