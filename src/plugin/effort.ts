import { EffortSchema, type Effort } from './config/schema'

/**
 * Effort levels ordered from lowest to highest reasoning depth.
 */
export const EFFORT_LEVELS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'] as const

/**
 * Reference thinking budget for each effort level.
 *
 * Scaled to Kiro's real thinking range (1024–128000 on opus-4.8/opus-5) rather
 * than OpenCode's conventional 32768 cap, so every effort level is reachable
 * from a budget alone. These double as the upper bound of each mapping band in
 * budgetToEffort, and as the variant budgets the plugin advertises, so the two
 * cannot drift apart.
 */
export const THINKING_BUDGETS: Readonly<Record<Effort, number>> = {
  low: 16384,
  medium: 32768,
  high: 65536,
  xhigh: 98304,
  max: 128000
}

/**
 * Where a model expects its effort level inside `additionalModelRequestFields`.
 *
 * Kiro validates this field against a per-model schema and rejects a mismatch
 * with HTTP 400, so the paths are mutually exclusive rather than alternatives.
 * kiro-cli carries the same two-element list internally
 * (`["output_config.effort", "reasoning.effort"]`) and selects one per model.
 */
export type EffortSchemaPath = 'output_config' | 'reasoning'

/**
 * Thinking toggle, mirroring kiro-cli's `thinking.type` values.
 *
 * `disabled` verifiably suppresses reasoning entirely (three consecutive runs
 * returned zero reasoning bytes); `adaptive` lets the model decide how much to
 * spend, which is Kiro's default when the field is omitted.
 */
export type ThinkingType = 'adaptive' | 'disabled'

interface ReasoningCapability {
  effortPath: EffortSchemaPath
  /** Effort levels this model's schema accepts. */
  levels: readonly Effort[]
  /**
   * Whether thinking can be switched off, i.e. the model's `thinking.type` enum
   * includes `"disabled"`. Same definition kiro-cli uses: its `/model` picker
   * shows the thinking toggle only for these models, and only then writes
   * `thinking.type` into the request. Opus 5.5 (`["adaptive"]`) and Sonnet 5.5
   * (`["adaptive", "between_tools"]`) aren't toggleable; Kiro 400s on
   * `"disabled"` there, and omitting the field leaves them reasoning adaptively.
   */
  thinkingToggleable: boolean
}

/**
 * Levels kiro-cli treats as requiring thinking. Picking one turns thinking on;
 * turning thinking off steps effort down to the highest level below them.
 */
const THINKING_ONLY_LEVELS: ReadonlySet<Effort> = new Set(['xhigh', 'max'])

// Claude 4.6 rejects `xhigh` ("does not have..."); Opus 4.8 and the 5-series accept it.
const FOUR_LEVELS: readonly Effort[] = ['low', 'medium', 'high', 'max']
const FIVE_LEVELS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']

/** Claude: effort under `output_config`, plus `thinking.type` where it can be turned off. */
const claude = (
  levels: readonly Effort[],
  { thinkingToggleable = true }: { thinkingToggleable?: boolean } = {}
): ReasoningCapability => ({
  effortPath: 'output_config',
  levels,
  thinkingToggleable
})

/** GPT: effort under `reasoning`, and no thinking toggle. */
const gpt = (): ReasoningCapability => ({
  effortPath: 'reasoning',
  levels: FIVE_LEVELS,
  thinkingToggleable: false
})

/**
 * Per-model reasoning schema, keyed on Kiro *wire* model ids (dotted form).
 *
 * Mirrors `additionalModelRequestFieldsSchema` from Kiro's ListAvailableModels
 * (see ARCHITECTURE.md for how to fetch it). Each model accepts exactly one
 * effort path and 400s on the other — verified live against
 * generateAssistantResponse:
 *
 * - Claude accepts `output_config.effort` and `thinking.type`. It rejects
 *   `reasoning.effort`, including when sent alongside the path it does accept.
 * - GPT accepts `reasoning.effort` only. It rejects `thinking.type` outright.
 *
 * Absence from this table means the model takes no reasoning fields. `auto` is
 * omitted deliberately: it dispatches to an unknown target, so a field valid for
 * one model could be rejected by another.
 */
const REASONING_CAPABILITIES: Readonly<Record<string, ReasoningCapability>> = {
  'claude-sonnet-4.6': claude(FOUR_LEVELS),
  'claude-sonnet-4.6-1m': claude(FOUR_LEVELS),
  'claude-sonnet-5': claude(FIVE_LEVELS),
  'claude-sonnet-5.5': claude(FIVE_LEVELS, { thinkingToggleable: false }),
  'claude-opus-4.8': claude(FIVE_LEVELS),
  'claude-opus-5': claude(FIVE_LEVELS),
  'claude-opus-5.5': claude(FIVE_LEVELS, { thinkingToggleable: false }),

  'gpt-5.6-luna': gpt(),
  'gpt-5.6-terra': gpt(),
  'gpt-5.6-sol': gpt()
}

function capabilityOf(kiroModel: string): ReasoningCapability | undefined {
  return REASONING_CAPABILITIES[kiroModel]
}

/**
 * Check if a model accepts an effort level.
 */
export function supportsEffort(kiroModel: string): boolean {
  return capabilityOf(kiroModel) !== undefined
}

/**
 * Check if a model accepts the `xhigh` level specifically.
 */
export function supportsXHighEffort(kiroModel: string): boolean {
  return capabilityOf(kiroModel)?.levels.includes('xhigh') ?? false
}

/**
 * Check if a model honours an explicit thinking on/off toggle.
 */
export function supportsThinkingToggle(kiroModel: string): boolean {
  return capabilityOf(kiroModel)?.thinkingToggleable ?? false
}

/**
 * Resolve an effort level against what the model actually accepts.
 *
 * Clamps to the model's ceiling rather than passing a level through that would
 * be rejected at request time.
 */
export function resolveEffort(kiroModel: string, requested: Effort): Effort | undefined {
  const capability = capabilityOf(kiroModel)
  if (!capability) return undefined
  if (capability.levels.includes(requested)) return requested

  // Only `xhigh` is ever missing from a supported ladder, and `max` is the
  // nearest equivalent above it.
  return 'max'
}

/**
 * Map OpenCode thinking budget to a Kiro effort level.
 *
 * Budget bands are scaled to Kiro's real thinking ceiling (1024–128000 for
 * opus-4.8/opus-5), not OpenCode's conventional 32768 cap, so the full effort
 * enum is reachable. Each THINKING_BUDGETS value is the inclusive upper bound of
 * its band, so a variant configured with a reference budget maps back to the
 * same level.
 */
export function budgetToEffort(budget: number, kiroModel: string): Effort | undefined {
  if (!supportsEffort(kiroModel)) return undefined

  // EFFORT_LEVELS is ordered low→max, so the first band the budget fits wins.
  const effort =
    EFFORT_LEVELS.find((level) => budget <= THINKING_BUDGETS[level]) ??
    EFFORT_LEVELS[EFFORT_LEVELS.length - 1]!

  return resolveEffort(kiroModel, effort)
}

/**
 * Get the effective effort level from config, budget, and model.
 *
 * Priority:
 * 1. Explicit effort config, applied regardless of thinking state
 * 2. Budget-to-effort mapping, when auto_effort_mapping is on and thinking
 * 3. 'medium' default when thinking
 * 4. undefined when not thinking
 */
export function getEffectiveEffort(
  kiroModel: string,
  thinking: boolean,
  budget: number,
  configEffort?: Effort,
  autoEffortMapping = true
): Effort | undefined {
  if (!supportsEffort(kiroModel)) return undefined
  if (configEffort) return resolveEffort(kiroModel, configEffort)
  if (!thinking) return undefined
  if (autoEffortMapping) return budgetToEffort(budget, kiroModel)
  return 'medium'
}

/**
 * Build the `additionalModelRequestFields` payload for a request.
 *
 * This is the whole reasoning contract in one place, following kiro-cli's rules
 * (its `chat.modelDefaults` writer and the reconcile step behind `/model`):
 *
 * - `thinking.type` is sent only on toggleable models: `"adaptive"` when
 *   thinking, `"disabled"` when not. Non-toggleable models get no thinking
 *   field at all and reason adaptively.
 * - Effort is independent of the toggle, so `disabled` plus an effort is valid,
 *   except that xhigh/max need thinking. A non-thinking request on a toggleable
 *   model steps them down to the highest remaining level, as kiro-cli does when
 *   you switch thinking off.
 * - No effort means no effort field, leaving Kiro's per-model default (medium on
 *   Opus 5.5, high elsewhere).
 *
 * Returns undefined when the model accepts no reasoning fields, so the caller
 * omits the key entirely — Kiro rejects the field outright on models like
 * MiniMax, and an empty object is not a safe stand-in.
 */
export function buildReasoningFields(
  kiroModel: string,
  thinking: boolean,
  effort?: Effort
): Record<string, unknown> | undefined {
  const capability = capabilityOf(kiroModel)
  if (!capability) return undefined

  const fields: Record<string, unknown> = {}

  let resolved = effort ? resolveEffort(kiroModel, effort) : undefined
  if (
    capability.thinkingToggleable &&
    !thinking &&
    resolved &&
    THINKING_ONLY_LEVELS.has(resolved)
  ) {
    resolved = capability.levels.filter((level) => !THINKING_ONLY_LEVELS.has(level)).at(-1)
  }
  if (resolved) fields[capability.effortPath] = { effort: resolved }

  if (capability.thinkingToggleable) {
    fields.thinking = { type: thinking ? 'adaptive' : 'disabled' }
  }

  return Object.keys(fields).length > 0 ? fields : undefined
}

/**
 * Read an effort level the client asked for directly.
 *
 * Claude Code sends `output_config.effort` (its `/effort` setting), OpenAI-style
 * clients send `reasoning_effort` or `reasoning.effort`. Without this, those
 * requests fell through to the budget mapping, and since they rarely carry a
 * budget they all landed on the 20000-token default, i.e. `medium`.
 *
 * OpenAI's `minimal` becomes `low`. `none` and unknown values return undefined;
 * `none` is already handled as "thinking off" by the caller.
 */
export function requestedEffort(body: any): Effort | undefined {
  const raw = body?.output_config?.effort ?? body?.reasoning_effort ?? body?.reasoning?.effort
  if (raw === 'minimal') return 'low'
  const parsed = EffortSchema.safeParse(raw)
  return parsed.success ? parsed.data : undefined
}

/**
 * The thinking budget the client sent, if any, across the OpenCode, AI SDK and
 * Anthropic request shapes. Undefined means "no budget", which lets the
 * configured default effort apply instead of the budget map.
 */
export function clientBudget(body: any): number | undefined {
  const budget =
    body?.providerOptions?.thinkingConfig?.thinkingBudget ??
    body?.thinkingConfig?.thinkingBudget ??
    body?.thinkingConfig?.budget_tokens ??
    body?.thinking?.budget_tokens
  return typeof budget === 'number' && budget > 0 ? budget : undefined
}
