import { describe, expect, test } from 'bun:test'
import { SUPPORTED_MODELS } from '../constants.js'
import type { Effort } from '../plugin/config/schema.js'
import { budgetToEffort, THINKING_BUDGETS } from '../plugin/effort.js'
import { buildModelRegistry } from '../plugin/model-registry.js'
import { resolveKiroModel } from '../plugin/models.js'

const registry = buildModelRegistry() as Record<string, any>

const thinkingIDs = Object.keys(registry).filter((id) => id.endsWith('-thinking'))
const XHIGH_MODELS = [
  'claude-opus-4-8-thinking',
  'claude-opus-5-thinking',
  'claude-opus-5-5-thinking',
  'claude-sonnet-5-thinking'
]

describe('model registry', () => {
  test('every advertised model is resolvable to a Kiro model ID', () => {
    for (const modelID of Object.keys(registry)) {
      expect(SUPPORTED_MODELS).toContain(modelID)
    }
  })

  test('advertises a thinking companion for each effort-capable Claude model', () => {
    expect(thinkingIDs.sort()).toEqual(
      [
        'claude-opus-4-8-thinking',
        'claude-opus-5-thinking',
        'claude-opus-5-5-thinking',
        'claude-sonnet-4-6-thinking',
        'claude-sonnet-4-6-1m-thinking',
        'claude-sonnet-5-thinking'
      ].sort()
    )
  })

  test('advertises the GPT tiers without thinking companions', () => {
    // GPT models reach reasoning through reasoning_effort rather than Kiro's
    // output_config.effort, so a -thinking variant would not do anything.
    const gptIDs = Object.keys(registry).filter((id) => id.startsWith('gpt-'))
    expect(gptIDs.sort()).toEqual(['gpt-5.6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra'])
    for (const id of gptIDs) {
      expect(registry[`${id}-thinking`]).toBeUndefined()
    }
  })

  test('does not advertise models below the quality floor', () => {
    // Sonnet 4.6 and Opus 4.8 are the floor; open-weight families are dropped.
    const ids = Object.keys(registry)
    for (const retired of [
      'claude-sonnet-4',
      'claude-sonnet-4-5',
      'claude-opus-4-5',
      'claude-opus-4-6',
      'claude-opus-4-7',
      'qwen3-coder-next',
      'deepseek-3.2',
      'minimax-m2.5',
      'minimax-m2.1'
    ]) {
      expect(ids).not.toContain(retired)
    }
  })

  test('advertises only Claude, GPT, and auto', () => {
    for (const id of Object.keys(registry)) {
      expect(id === 'auto' || id.startsWith('claude-') || id.startsWith('gpt-'), id).toBe(true)
    }
  })

  describe('reasoning capability flags', () => {
    // Both are required: `reasoning` declares the capability, `interleaved.field`
    // tells OpenCode reasoning arrives as `reasoning_content` deltas. Missing
    // either one means reasoning chunks are silently dropped.
    test('every thinking model declares reasoning and the reasoning_content field', () => {
      for (const id of thinkingIDs) {
        expect(registry[id].reasoning).toBe(true)
        expect(registry[id].interleaved).toEqual({ field: 'reasoning_content' })
      }
    })

    test('non-thinking Claude models and auto declare neither', () => {
      for (const [id, model] of Object.entries(registry)) {
        if (id.endsWith('-thinking') || id.startsWith('gpt-')) continue
        expect(model.reasoning).toBeUndefined()
        expect(model.interleaved).toBeUndefined()
      }
    })

    test('GPT models carry reasoning flags and the full effort ladder on the base entry', () => {
      for (const id of ['gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.6-sol']) {
        const model = registry[id]
        expect(model.reasoning).toBe(true)
        expect(model.interleaved).toEqual({ field: 'reasoning_content' })
        expect(Object.keys(model.variants)).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
        const kiroModel = resolveKiroModel(id)
        for (const [name, variant] of Object.entries<any>(model.variants)) {
          expect(budgetToEffort(variant.thinkingConfig.thinkingBudget, kiroModel)).toBe(
            name as Effort
          )
        }
      }
    })
  })

  describe('thinking variants', () => {
    test('offers xhigh only on models Kiro documents as xhigh-capable', () => {
      for (const id of thinkingIDs) {
        const hasXHigh = Object.keys(registry[id].variants).includes('xhigh')
        expect(hasXHigh).toBe(XHIGH_MODELS.includes(id))
      }
    })

    test('variant budgets map back to the effort level they are named for', () => {
      for (const id of thinkingIDs) {
        const kiroModel = resolveKiroModel(id)
        for (const [name, variant] of Object.entries<any>(registry[id].variants)) {
          const level = name as Effort
          const budget = variant.thinkingConfig.thinkingBudget
          expect(budget).toBe(THINKING_BUDGETS[level])
          expect(budgetToEffort(budget, kiroModel)).toBe(level)
        }
      }
    })

    test('variants are ordered low to max', () => {
      for (const id of thinkingIDs) {
        const budgets = Object.values<any>(registry[id].variants).map(
          (v) => v.thinkingConfig.thinkingBudget
        )
        expect(budgets).toEqual([...budgets].sort((a, b) => a - b))
      }
    })
  })

  test('carries limit and modalities through to both entries', () => {
    expect(registry['claude-opus-5'].limit).toEqual({ context: 1000000, output: 64000 })
    expect(registry['claude-opus-5-thinking'].limit).toEqual(registry['claude-opus-5'].limit)
    expect(registry['claude-opus-5-thinking'].modalities).toEqual(
      registry['claude-opus-5'].modalities
    )
  })
})
