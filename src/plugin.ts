import { tool } from '@opencode-ai/plugin'
import { KIRO_CONSTANTS } from './constants.js'
import { AuthHandler } from './core/auth/auth-handler.js'
import { RequestHandler } from './core/request/request-handler.js'
import { AccountCache } from './infrastructure/database/account-cache.js'
import { AccountRepository } from './infrastructure/database/account-repository.js'
import { AccountManager } from './plugin/accounts.js'
import { bootstrapAuthIfNeeded } from './plugin/auth-bootstrap.js'
import { loadConfig } from './plugin/config/index.js'
import * as logger from './plugin/logger.js'
import { buildModelRegistry } from './plugin/model-registry.js'
import { formatWebSearchResults, kiroWebSearch } from './plugin/web-search.js'

type ToastFunction = (message: string, variant: string) => void

const KIRO_PROVIDER_ID = 'kiro'

// Register Kiro's server-side web search as a custom tool, when enabled and the
// active account is Pro (has a profileArn). Returns an empty object otherwise so
// nothing is advertised to the model on free accounts.
//
// The description is adapted from Kiro's own web_search tool spec so the model
// gets the same guidance on when to search and how to attribute results.
const WEB_SEARCH_DESCRIPTION = `Search the web using Kiro's built-in search engine. Returns titles, URLs, snippets, domains, and publish dates for a query. Billed as Kiro credits.

## When to Use
- The user asks for current or up-to-date information (pricing, versions, release notes, recent events, library APIs).
- Verifying facts that may have changed recently, or details likely newer than the model's training data.
- Looking up specifics of a library, framework, or tool that can't be reliably inferred from the codebase or context.

## When NOT to Use
- Basic concepts, historical facts, or well-established programming syntax the model already knows.
- Anything answerable from the current repository, files, or conversation. Search the codebase first.

## Query Tips
- Keep queries focused; the query MUST be 200 characters or fewer (longer queries are rejected).
- Rephrase the user's request into effective keywords. Run multiple focused searches for complex questions rather than one broad query.
- The snippets often contain enough to answer directly; only fetch a full page (via a separate fetch tool) when you need more detail.

## Using Results & Attribution
- Prioritize the most recently published, authoritative sources (prefer official docs over blogs; use the domain to judge authority).
- ALWAYS cite sources with inline links in the format [description](url).
- Paraphrase and summarize; do not reproduce more than ~30 consecutive words verbatim from any single source. Preserve factual accuracy while condensing.`

function buildTools(config: any, accountManager: AccountManager): Record<string, any> {
  if (!config.web_search_enabled) return {}
  const account = accountManager.getCurrentOrNext()
  if (!account?.profileArn) return {}

  return {
    kiro_web_search: tool({
      description: WEB_SEARCH_DESCRIPTION,
      args: {
        query: tool.schema.string().describe('The search query. Must be 200 characters or fewer.')
      },
      async execute(args: { query: string }) {
        try {
          const results = await kiroWebSearch(accountManager, args.query)
          return formatWebSearchResults(results)
        } catch (e) {
          return `Web search failed: ${e instanceof Error ? e.message : String(e)}`
        }
      }
    })
  }
}

export const createKiroPlugin =
  (id: string) =>
  async ({ client, directory }: any) => {
    const config = loadConfig(directory)

    const showToast: ToastFunction = (message: string, variant: string) => {
      client.tui.showToast({ body: { message, variant } }).catch(() => {})
    }

    const { syncFromKiroCli } = await import('./plugin/sync/kiro-cli.js')
    const { syncFromKiroIde } = await import('./plugin/sync/kiro-ide.js')
    await syncFromKiroCli()
    await syncFromKiroIde()
    logger.log('Startup sync done')

    const cache = new AccountCache(60000)
    const repository = new AccountRepository(cache)

    const authHandler = new AuthHandler(config, repository)
    const accountManager = await AccountManager.loadFromDisk(config.account_selection_strategy)
    authHandler.setAccountManager(accountManager)

    const requestHandler = new RequestHandler(accountManager, config, repository, client)
    await authHandler.initialize(showToast as any)

    const models = buildModelRegistry()
    const intercept = (input: any, init?: any) => {
      logger.log('intercept', typeof input === 'string' ? input : input?.url)
      return requestHandler.handle(input, init, showToast)
    }
    const baseURL = KIRO_CONSTANTS.BASE_URL.replace('/generateAssistantResponse', '').replace(
      '{{region}}',
      config.default_region || 'us-east-1'
    )

    return {
      config: async (input: any) => {
        // Ensure there's an auth entry so OpenCode calls the loader on startup.
        // This is a no-op if the entry already exists.
        bootstrapAuthIfNeeded(id)

        if (!input.provider) input.provider = {}
        if (!input.provider[id]) input.provider[id] = {}
        // Always set npm and api — these must be present regardless of whether
        // the user has already defined the provider in their opencode.json.
        input.provider[id].npm = '@ai-sdk/openai-compatible'
        // Set the base URL at the provider level. OpenCode reads provider.api as
        // model.api.url, which resolveSDK() uses to construct the endpoint URL.
        // Only set if not already overridden by the user.
        input.provider[id].api = baseURL
        input.provider[id].options = {
          ...(input.provider[id].options || {}),
          baseURL,
          apiKey: 'kiro',
          fetch: intercept
        }
        if (!input.provider[id].models) {
          input.provider[id].models = models
        }
      },
      auth: {
        provider: id,
        loader: async (getAuth: any) => {
          await getAuth()
          await authHandler.initialize(showToast as any)

          return {
            apiKey: '',
            // Provide baseURL explicitly so the @ai-sdk/openai-compatible provider
            // always has a valid URL. The custom fetch below intercepts all Kiro
            // API calls, so this value is only used for URL construction.
            baseURL,
            fetch: intercept
          }
        },
        methods: authHandler.getMethods()
      },
      provider: {
        id,
        models: async (provider: any) => {
          const models = provider?.models || {}
          const normalized: Record<string, any> = {}

          for (const [modelID, model] of Object.entries(models)) {
            const modelInfo = model as any
            normalized[modelID] = {
              ...modelInfo,
              api: {
                ...(modelInfo.api || {}),
                npm: '@ai-sdk/openai-compatible',
                // Ensure url is always set. modelInfo.api.url should already be
                // populated from the config hook's provider.api field, but we
                // set it explicitly as a fallback for any edge cases.
                url: baseURL
              }
            }
          }

          return normalized
        }
      },
      'chat.headers': async (input: any, output: any) => {
        if (input?.sessionID) {
          output.headers['x-opencode-session-id'] = input.sessionID
        }
      },
      tool: buildTools(config, accountManager)
    }
  }

export const KiroOAuthPlugin = createKiroPlugin(KIRO_PROVIDER_ID)
