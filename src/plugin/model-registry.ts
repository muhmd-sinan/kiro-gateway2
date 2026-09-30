import {
  EFFORT_LEVELS,
  supportsEffort,
  supportsThinkingToggle,
  supportsXHighEffort,
  THINKING_BUDGETS
} from './effort.js'
import { resolveKiroModel } from './models.js'

type Modalities = {
  input: Array<'text' | 'image' | 'pdf'>
  output: ['text']
}

const TEXT_IMAGE: Modalities = { input: ['text', 'image'], output: ['text'] }
const MULTIMODAL: Modalities = { input: ['text', 'image', 'pdf'], output: ['text'] }

const CONTEXT_1M = { context: 1000000, output: 64000 }

interface ModelSpec {
  /** Display name, without the credit multiplier suffix. */
  name: string
  /** Kiro credit multiplier, rendered into the display name. */
  rate: string
  limit: { context: number; output: number }
  modalities: Modalities
  /**
   * Emit a companion `-thinking` entry. Only set for Claude models that accept
   * `output_config.effort`; the effort ladder is derived from the model's own
   * capabilities in effort.ts.
   */
  thinking?: boolean
}

/**
 * Models Kiro exposes, keyed by the OpenCode-facing model ID.
 *
 * Claude, GPT-5.6 (no -thinking companions; they use a different effort path),
 * and open-weight models.
 */
const MODEL_SPECS: Record<string, ModelSpec> = {
  auto: { name: 'Auto', rate: '1.0x', limit: CONTEXT_1M, modalities: MULTIMODAL },

  'claude-sonnet-4-6': {
    name: 'Claude Sonnet 4.6',
    rate: '1.3x',
    limit: CONTEXT_1M,
    modalities: MULTIMODAL,
    thinking: true
  },
  'claude-sonnet-4-6-1m': {
    name: 'Claude Sonnet 4.6 (1M)',
    rate: '1.3x',
    limit: CONTEXT_1M,
    modalities: MULTIMODAL,
    thinking: true
  },
  'claude-sonnet-5': {
    name: 'Claude Sonnet 5',
    rate: '1.3x',
    limit: CONTEXT_1M,
    modalities: MULTIMODAL,
    thinking: true
  },

  'claude-opus-4-8': {
    name: 'Claude Opus 4.8',
    rate: '2.2x',
    limit: CONTEXT_1M,
    modalities: MULTIMODAL,
    thinking: true
  },
  'claude-opus-5': {
    name: 'Claude Opus 5',
    rate: '2.2x',
    limit: CONTEXT_1M,
    modalities: MULTIMODAL,
    thinking: true
  },
  'claude-opus-5-5': {
    name: 'Claude Opus 5.5',
    rate: '2.2x',
    limit: CONTEXT_1M,
    modalities: MULTIMODAL,
    thinking: true
  },

  'gpt-5.6-luna': {
    name: 'GPT 5.6 Luna',
    rate: '1.1x',
    limit: CONTEXT_1M,
    modalities: TEXT_IMAGE
  },
  'gpt-5.6-terra': {
    name: 'GPT 5.6 Terra',
    rate: '2.2x',
    limit: CONTEXT_1M,
    modalities: TEXT_IMAGE
  },
  'gpt-5.6-sol': {
    name: 'GPT 5.6 Sol',
    rate: '4.4x',
    limit: CONTEXT_1M,
    modalities: TEXT_IMAGE
  }
}

/**
 * Build the thinking variants a model supports.
 *
 * Levels come from the model's own effort capabilities, so xhigh only appears on
 * models that accept it and the budgets stay in step with budgetToEffort.
 */
function buildVariants(kiroModel: string): Record<string, unknown> {
  const variants: Record<string, unknown> = {}

  for (const level of EFFORT_LEVELS) {
    if (level === 'xhigh' && !supportsXHighEffort(kiroModel)) continue
    variants[level] = { thinkingConfig: { thinkingBudget: THINKING_BUDGETS[level] } }
  }

  return variants
}

/**
 * Model registry advertised to OpenCode.
 *
 * `-thinking` entries carry `reasoning` and `interleaved`. Both are required:
 * `reasoning` declares the capability, and `interleaved.field` tells OpenCode
 * that reasoning arrives in the non-standard `reasoning_content` delta this
 * plugin emits (see streaming/openai-converter.ts). Without them OpenCode
 * silently drops every reasoning chunk and no thinking block is rendered.
 */
export function buildModelRegistry(): Record<string, unknown> {
  const models: Record<string, unknown> = {}

  for (const [modelID, spec] of Object.entries(MODEL_SPECS)) {
    // Effort capability is keyed on the resolved Kiro model ID, not the
    // OpenCode-facing one (e.g. claude-opus-5 vs claude-opus-4-6).
    const kiroModel = resolveKiroModel(modelID)

    models[modelID] = {
      name: `${spec.name} (${spec.rate})`,
      limit: spec.limit,
      modalities: spec.modalities
    }

    // GPT models reason on every request (no thinking toggle), so the effort
    // ladder goes on the base entry rather than a -thinking companion. The
    // variant's thinkingBudget maps to `reasoning.effort` via budgetToEffort,
    // the same path the proxy takes for a `reasoning_effort` request.
    if (!spec.thinking && supportsEffort(kiroModel) && !supportsThinkingToggle(kiroModel)) {
      models[modelID] = {
        ...(models[modelID] as object),
        reasoning: true,
        interleaved: { field: 'reasoning_content' },
        variants: buildVariants(kiroModel)
      }
      continue
    }

    if (!spec.thinking) continue
    if (!supportsEffort(kiroModel)) continue

    models[`${modelID}-thinking`] = {
      name: `${spec.name} Thinking (${spec.rate})`,
      limit: spec.limit,
      modalities: spec.modalities,
      reasoning: true,
      interleaved: { field: 'reasoning_content' },
      variants: buildVariants(kiroModel)
    }
  }

  return models
}
