import { MODEL_MAPPING, SUPPORTED_MODELS } from '../constants.js'

/**
 * Resolve whatever model id a client sends to one Kiro accepts.
 *
 * Clients arrive with three different naming conventions and we can't ask them
 * to change:
 *
 * - OpenCode/Hermes send exactly what `/v1/models` advertised, so they hit the
 *   MODEL_MAPPING fast path.
 * - Claude Code sends real Anthropic API ids (`claude-sonnet-4-5-20250929`) plus
 *   the aliases `sonnet`/`opus`/`haiku`, and its `/model` picker can produce
 *   arbitrary strings.
 * - Hermes' auxiliary tasks (title generation, compaction) may reuse the main
 *   model id, and some gateways prefix with a namespace (`kiro/claude-opus-5`).
 *
 * Resolution is ordered most-specific to least so a precise id is never
 * swallowed by a looser rule. Unknown ids fall back rather than 400: Hermes
 * treats a hard model rejection as permanent and bricks the session, and Claude
 * Code has no way to enumerate what we support.
 */

/**
 * Semantic tiers Claude Code's aliases and dated ids map onto.
 * Points at the newest Kiro model in each family.
 */
const TIER_MODELS = {
  // Verified live: claude-opus-5.5 accepts requests with and without thinking
  // (see thinkingToggleable in effort.ts for why "without" sends no thinking field).
  opus: 'claude-opus-5-5',
  // Verified live 2026-10-05 (scripts/smoke.mjs claude-sonnet-5.5).
  sonnet: 'claude-sonnet-5-5',
  // Kiro exposes no Haiku, and the cheap open-weight models are no longer
  // advertised. GPT Luna (0.6x) is the least expensive model left, which matters
  // because Claude Code routes session titles and classifiers to the haiku tier
  // on nearly every turn.
  haiku: 'gpt-5.6-luna'
} as const

/**
 * Marker that requests the 1M context window.
 *
 * Has to be part of the advertised model *id*, not a display label: Claude Code
 * does not send `anthropic-beta: context-1m-2025-08-07` behind a custom
 * ANTHROPIC_BASE_URL and assumes a 200k window unless the id itself carries the
 * marker (anthropics/claude-code#68522, #88345). Other Anthropic-compatible
 * gateways use the same convention, e.g. `glm-5.2[1m]`.
 *
 * Every model Kiro serves here has a 1M window (see MODEL_SPECS in
 * model-registry.ts), so this applies unconditionally. resolveModelId strips it
 * before matching, so nothing downstream sees it.
 */
const LONG_CONTEXT_SUFFIX = '[1m]'

/**
 * Ids redirected to a different wire model, checked *before* the known() fast
 * path so they win over an exact MODEL_MAPPING match.
 *
 * Sonnet 4.6 is the only family where Kiro exposes the 1M window as a separate
 * wire model rather than a property of the base one. Advertising both gave a
 * confusing near-duplicate pair, and advertising the real `-1m` id spells the
 * window twice once LONG_CONTEXT_SUFFIX is appended (`claude-sonnet-4-6-1m[1m]`).
 *
 * So the base id is what gets advertised, and it resolves to the 1M wire model —
 * one entry, one marker, and the long window that the marker promises. The `-1m`
 * id stays resolvable for anything that already sends it.
 */
const PROXY_REDIRECTS: Record<string, string> = {
  'claude-sonnet-4-6': 'claude-sonnet-4-6-1m'
}

/** Advertised id → real wire id, for models renamed on the way out. */
const HIDDEN_FROM_DISCOVERY = new Set(Object.values(PROXY_REDIRECTS))

/**
 * Claude-prefixed aliases for Kiro's GPT models, advertised in place of the real
 * ids on `GET /v1/models`.
 *
 * Claude Code's model discovery drops any id without "claude" or "anthropic" in
 * it, so `gpt-5.6-sol` and friends are invisible in its picker no matter what we
 * send. Renaming them to `claude-sol` / `claude-luna` / `claude-terra` gets them
 * past that filter; requests are normalized back to the real id here before
 * anything reaches Kiro, so the wire format is unchanged.
 *
 * Proxy-only. The OpenCode plugin resolves through MODEL_MAPPING directly and
 * never sees these names.
 */
const CLAUDE_PREFIXED_GPT: Record<string, string> = {
  'claude-sol': 'gpt-5.6-sol',
  'claude-luna': 'gpt-5.6-luna',
  'claude-terra': 'gpt-5.6-terra'
}

/** Explicit aliases, checked before any pattern matching. */
const ALIASES: Record<string, string> = {
  // Claude-prefixed GPT names, so Claude Code's discovery filter passes them.
  ...CLAUDE_PREFIXED_GPT,

  // Claude Code tier aliases
  opus: TIER_MODELS.opus,
  opusplan: TIER_MODELS.opus,
  sonnet: TIER_MODELS.sonnet,
  haiku: TIER_MODELS.haiku,
  fast: TIER_MODELS.haiku,
  default: TIER_MODELS.sonnet,

  // Convenience ids for hand-written client configs
  'kiro-auto': 'auto',
  'claude-local-main': TIER_MODELS.sonnet,
  'claude-local-fast': TIER_MODELS.haiku,

  // Dotted spellings of Kiro's own ids, which some clients normalize differently
  'claude-sonnet-4.6': 'claude-sonnet-4-6',
  'claude-opus-4.8': 'claude-opus-4-8',
  'claude-opus-5.5': 'claude-opus-5-5',
  'claude-sonnet-5.5': 'claude-sonnet-5-5',

  // Retired models. Kiro's backend still accepts several of these, but they sit
  // below the quality floor this proxy advertises, so requests are lifted to the
  // current model in the same family instead of failing.
  'claude-sonnet-4': TIER_MODELS.sonnet,
  'claude-sonnet-4-5': TIER_MODELS.sonnet,
  'claude-sonnet-4.5': TIER_MODELS.sonnet,
  'claude-opus-4-5': TIER_MODELS.opus,
  'claude-opus-4.5': TIER_MODELS.opus,
  'claude-opus-4-6': TIER_MODELS.opus,
  'claude-opus-4.6': TIER_MODELS.opus,
  'claude-opus-4-7': TIER_MODELS.opus,
  'claude-opus-4.7': TIER_MODELS.opus,

  // Dropped open-weight families, routed to the cheapest advertised model.
  'qwen3-coder-next': TIER_MODELS.haiku,
  'deepseek-3.2': TIER_MODELS.haiku,
  'minimax-m2.5': TIER_MODELS.haiku,
  'minimax-m2.1': TIER_MODELS.haiku,

  // Kiro rejects claude-sonnet-5-1m outright, so route it to the model that works.
  'claude-sonnet-5-1m': 'claude-sonnet-5'
}

/** Trailing Anthropic date stamp, e.g. `-20250929`. */
const DATE_SUFFIX = /-\d{8}$/

/** Leading provider namespace, e.g. `kiro/`, `anthropic/`, `bedrock.`. */
const NAMESPACE_PREFIX = /^[a-z0-9_.-]+[/:]/i

export interface ResolvedModel {
  /** Model id to hand to the transform layer (a MODEL_MAPPING key). */
  id: string
  /** Whether the client asked for extended thinking via a `-thinking` suffix. */
  thinking: boolean
  /** True when we fell back instead of matching the request. */
  fallback: boolean
}

function known(id: string): boolean {
  return Object.prototype.hasOwnProperty.call(MODEL_MAPPING, id)
}

/**
 * Pick a Kiro model for an id we don't recognize, by family keyword.
 *
 * Ordered so the more specific family wins: "opus" before "claude", and the
 * 1M-context hint before the base Sonnet entry.
 */
function inferFromKeywords(id: string): string | undefined {
  if (id.includes('opus')) return TIER_MODELS.opus
  if (id.includes('haiku')) return TIER_MODELS.haiku
  if (id.includes('sonnet')) return TIER_MODELS.sonnet
  if (id.includes('gpt') || id.includes('o1') || id.includes('o3')) return 'gpt-5.6-luna'
  // Open-weight families (minimax, qwen, deepseek, glm, kimi) are no longer
  // advertised; send them to the cheapest model rather than rejecting.
  if (/minimax|qwen|deepseek|glm|kimi|llama|mistral/.test(id)) return TIER_MODELS.haiku
  if (id.includes('claude')) return TIER_MODELS.sonnet
  return undefined
}

export function resolveModelId(requested: string | undefined, defaultModel: string): ResolvedModel {
  const raw = (requested ?? '').trim()
  if (!raw) return { id: defaultModel, thinking: false, fallback: true }

  // Claude Code's 1M-context marker; strip before matching, the model ids
  // encode context separately.
  let id = raw.toLowerCase().replace('[1m]', '').trim()

  // OpenCode variant suffix (model#high). Effort is resolved from config and
  // thinking budget, so the variant tag carries no extra information here.
  const hashIndex = id.indexOf('#')
  if (hashIndex > 0) id = id.slice(0, hashIndex)

  let thinking = false
  if (id.endsWith('-thinking')) {
    thinking = true
    id = id.slice(0, -'-thinking'.length)
  }

  // Redirects come first so they beat an exact MODEL_MAPPING match.
  if (PROXY_REDIRECTS[id]) return { id: PROXY_REDIRECTS[id]!, thinking, fallback: false }
  if (known(id)) return { id, thinking, fallback: false }
  if (ALIASES[id]) return { id: ALIASES[id]!, thinking, fallback: false }

  // Strip a provider namespace and retry (kiro/claude-opus-5 → claude-opus-5).
  const withoutNamespace = id.replace(NAMESPACE_PREFIX, '')
  if (withoutNamespace !== id) {
    if (known(withoutNamespace)) return { id: withoutNamespace, thinking, fallback: false }
    if (ALIASES[withoutNamespace])
      return { id: ALIASES[withoutNamespace]!, thinking, fallback: false }
    id = withoutNamespace
  }

  // Drop an Anthropic date stamp and retry (claude-opus-4-5-20250929 →
  // claude-opus-4-5).
  const undated = id.replace(DATE_SUFFIX, '')
  if (undated !== id) {
    if (known(undated)) return { id: undated, thinking, fallback: false }
    if (ALIASES[undated]) return { id: ALIASES[undated]!, thinking, fallback: false }
    id = undated
  }

  const inferred = inferFromKeywords(id)
  if (inferred) return { id: inferred, thinking, fallback: true }

  return { id: defaultModel, thinking, fallback: true }
}

/**
 * Apply the `-thinking` suffix when the target model has a thinking variant.
 *
 * MODEL_MAPPING only defines `-thinking` keys for Claude models; the suffix on
 * anything else would throw in resolveKiroModel.
 */
export function applyThinking(id: string, thinking: boolean): string {
  if (!thinking) return id
  const candidate = `${id}-thinking`
  return known(candidate) ? candidate : id
}

/**
 * Model ids advertised on `GET /v1/models`.
 *
 * Excludes `-thinking` keys — they are request modifiers rather than separate
 * models, and listing both doubles the picker for no benefit.
 *
 * GPT ids are advertised under their `claude-*` aliases so Claude Code's
 * discovery filter (which drops anything without "claude"/"anthropic") lets them
 * through. resolveModelId maps them back before the request is sent.
 */
export function listPublicModels(): string[] {
  const gptToClaude = new Map(Object.entries(CLAUDE_PREFIXED_GPT).map(([k, v]) => [v, k]))

  return SUPPORTED_MODELS.filter(
    (id) => !id.endsWith('-thinking') && !HIDDEN_FROM_DISCOVERY.has(id)
  ).map((id) => `${gptToClaude.get(id) ?? id}${LONG_CONTEXT_SUFFIX}`)
}

/**
 * Display label for a model on `GET /v1/models`.
 *
 * Mirrors the id, which already carries `[1m]`, so the picker and the wire value
 * agree.
 */
export function publicModelDisplayName(id: string): string {
  return id
}
