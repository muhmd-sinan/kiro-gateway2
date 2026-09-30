import { RESOLVABLE_MODELS, SUPPORTED_MODELS, isLongContextModel } from '../constants'

/**
 * Map an OpenCode-facing model id to the Kiro wire id.
 *
 * Accepts retired ids as well as advertised ones (see LEGACY_MODEL_ALIASES):
 * OpenCode persists the selected model per session, so an existing session can
 * still name a model that has since been dropped. Throwing there would break the
 * session outright, so those ids resolve to the current model in the same family
 * instead.
 */
export function resolveKiroModel(model: string): string {
  const resolved = RESOLVABLE_MODELS[model]
  if (!resolved) {
    throw new Error(`Unsupported model: ${model}. Supported models: ${SUPPORTED_MODELS.join(', ')}`)
  }
  return resolved
}

export function getContextWindowSize(model: string): number {
  return isLongContextModel(model) ? 1000000 : 200000
}
