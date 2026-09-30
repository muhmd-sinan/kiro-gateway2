import { RegionSchema } from './plugin/config/schema'
import type { KiroRegion } from './plugin/types'

const VALID_REGIONS: readonly KiroRegion[] = RegionSchema.options

export function isValidRegion(region: string): region is KiroRegion {
  return VALID_REGIONS.includes(region as KiroRegion)
}

export function normalizeRegion(region: string | undefined): KiroRegion {
  if (!region || !isValidRegion(region)) {
    return 'us-east-1'
  }
  return region
}

export function buildUrl(template: string, region: KiroRegion): string {
  const url = template.replace('{{region}}', region)

  try {
    new URL(url)
    return url
  } catch {
    throw new Error(`Invalid URL generated: ${url}`)
  }
}

export function extractRegionFromArn(arn: string | undefined): KiroRegion | undefined {
  if (!arn) return undefined
  const parts = arn.split(':')
  if (parts.length < 6) return undefined
  if (parts[0] !== 'arn') return undefined
  const region = parts[3]
  if (typeof region !== 'string' || !region) return undefined
  return isValidRegion(region) ? (region as KiroRegion) : undefined
}

export const KIRO_CONSTANTS = {
  REFRESH_URL: 'https://prod.{{region}}.auth.desktop.kiro.dev/refreshToken',
  REFRESH_IDC_URL: 'https://oidc.{{region}}.amazonaws.com/token',
  BASE_URL: 'https://q.{{region}}.amazonaws.com/generateAssistantResponse',
  USAGE_LIMITS_URL: 'https://q.{{region}}.amazonaws.com/getUsageLimits',
  DEFAULT_REGION: 'us-east-1' as KiroRegion,
  AXIOS_TIMEOUT: 120000,
  USER_AGENT: 'KiroIDE',
  SDK_VERSION: '3.738.0',
  SDK_VERSION_USAGE: '3.0.0',
  CHAT_TRIGGER_TYPE_MANUAL: 'MANUAL',
  ORIGIN_AI_EDITOR: 'AI_EDITOR'
}

/**
 * OpenCode-facing model id → Kiro wire model id.
 *
 * Curated rather than exhaustive: Claude (Sonnet 4.6+ / Opus 4.8+) and GPT only.
 * Kiro's backend also serves older Claude revisions and open-weight models
 * (deepseek, qwen, glm, minimax) which are deliberately not exposed.
 *
 * Every entry is verified to be accepted by generateAssistantResponse. Note
 * there is no `claude-sonnet-5-1m` — Kiro rejects it with "Invalid model" even
 * though the non-1M variant works.
 */
export const MODEL_MAPPING: Record<string, string> = {
  auto: 'auto',

  'claude-sonnet-4-6': 'claude-sonnet-4.6',
  'claude-sonnet-4-6-thinking': 'claude-sonnet-4.6',
  'claude-sonnet-4-6-1m': 'claude-sonnet-4.6-1m',
  'claude-sonnet-4-6-1m-thinking': 'claude-sonnet-4.6-1m',
  'claude-sonnet-5': 'claude-sonnet-5',
  'claude-sonnet-5-thinking': 'claude-sonnet-5',

  'claude-opus-4-8': 'claude-opus-4.8',
  'claude-opus-4-8-thinking': 'claude-opus-4.8',
  'claude-opus-5': 'claude-opus-5',
  'claude-opus-5-thinking': 'claude-opus-5',
  'claude-opus-5-5': 'claude-opus-5.5',
  'claude-opus-5-5-thinking': 'claude-opus-5.5',

  'gpt-5.6-luna': 'gpt-5.6-luna',
  'gpt-5.6-terra': 'gpt-5.6-terra',
  'gpt-5.6-sol': 'gpt-5.6-sol'
}

/**
 * Retired ids kept resolvable for backward compatibility.
 *
 * OpenCode persists the selected model per session and in opencode.json, so a
 * session created before these models were dropped still sends the old id. The
 * OpenCode plugin resolves ids directly through resolveKiroModel, bypassing the
 * proxy's alias layer, so without this a saved session would hard-fail on every
 * request instead of quietly moving to a current model.
 *
 * Not advertised in the registry (see listPublicModels / MODEL_SPECS), so nothing
 * new can select them.
 */
const LEGACY_MODEL_ALIASES: Record<string, string> = {
  // Older Claude revisions, lifted to the current model in the same family.
  'claude-sonnet-4': 'claude-sonnet-4.6',
  'claude-sonnet-4-thinking': 'claude-sonnet-4.6',
  'claude-sonnet-4-5': 'claude-sonnet-4.6',
  'claude-sonnet-4-5-thinking': 'claude-sonnet-4.6',
  'claude-sonnet-4-5-1m': 'claude-sonnet-4.6-1m',
  'claude-sonnet-4-5-1m-thinking': 'claude-sonnet-4.6-1m',
  'claude-sonnet-5-1m': 'claude-sonnet-5',
  'claude-sonnet-5-1m-thinking': 'claude-sonnet-5',
  'claude-opus-4-5': 'claude-opus-4.8',
  'claude-opus-4-5-thinking': 'claude-opus-4.8',
  'claude-opus-4-6': 'claude-opus-4.8',
  'claude-opus-4-6-thinking': 'claude-opus-4.8',
  'claude-opus-4-6-1m': 'claude-opus-4.8',
  'claude-opus-4-6-1m-thinking': 'claude-opus-4.8',
  'claude-opus-4-7': 'claude-opus-4.8',
  'claude-opus-4-7-thinking': 'claude-opus-4.8',

  // Dropped open-weight families, routed to the cheapest advertised model.
  'minimax-m2.5': 'gpt-5.6-luna',
  'minimax-m2.1': 'gpt-5.6-luna',
  'qwen3-coder-next': 'gpt-5.6-luna',
  'deepseek-3.2': 'gpt-5.6-luna'
}

/**
 * Every id resolveKiroModel accepts: advertised models plus legacy aliases.
 */
export const RESOLVABLE_MODELS: Record<string, string> = {
  ...MODEL_MAPPING,
  ...LEGACY_MODEL_ALIASES
}

/**
 * Advertised ids only. Legacy aliases resolve but are deliberately absent, so
 * nothing surfaces them to a user.
 */
export const SUPPORTED_MODELS = Object.keys(MODEL_MAPPING)

// Derived from RESOLVABLE_MODELS so legacy 1M ids still report the right context
// window rather than silently falling back to 200K.
const LONG_CONTEXT_MODELS = new Set(Object.keys(RESOLVABLE_MODELS).filter((k) => k.includes('-1m')))

export function isLongContextModel(model: string): boolean {
  return LONG_CONTEXT_MODELS.has(model)
}

export const KIRO_AUTH_SERVICE = {
  ENDPOINT: 'https://prod.{{region}}.auth.desktop.kiro.dev',
  SSO_OIDC_ENDPOINT: 'https://oidc.{{region}}.amazonaws.com',
  BUILDER_ID_START_URL: 'https://view.awsapps.com/start',
  USER_INFO_URL: 'https://view.awsapps.com/api/user/info',
  SCOPES: [
    'codewhisperer:completions',
    'codewhisperer:analysis',
    'codewhisperer:conversations',
    'codewhisperer:transformations',
    'codewhisperer:taskassist'
  ]
}
