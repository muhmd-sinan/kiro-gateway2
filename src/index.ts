export { KiroOAuthPlugin } from './plugin.js'

export type { KiroConfig } from './plugin/config/index.js'
export type { KiroAuthMethod, KiroRegion, ManagedAccount, WireFormat } from './plugin/types.js'

// Standalone proxy server: serves Kiro over OpenAI and Anthropic HTTP APIs so
// external agent CLIs (Hermes Agent, Claude Code) can use the same account pool
// as the OpenCode plugin. See src/server/cli.ts for the executable entrypoint.
export { loadServerConfig, tokenPath, type ServerConfig } from './server/config.js'
export { startProxyServer, type ProxyServerHandle } from './server/http.js'
export { listPublicModels, resolveModelId } from './server/model-alias.js'
export { KiroRuntime } from './server/runtime.js'

export default { id: 'kiro', server: (await import('./plugin.js')).KiroOAuthPlugin }
