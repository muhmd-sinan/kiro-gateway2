# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
bun install
bun test                              # full suite (bun:test)
bun test src/__tests__/effort.test.ts  # single file
bun test --test-name-pattern "resolveModelId"  # single test by name
bun run typecheck                     # tsc --noEmit
bun run build                         # tsc -p tsconfig.build.json + scripts/fix-esm-imports.mjs
bun run format                        # prettier over src/**/*.ts
bun run proxy                         # run the standalone proxy from source
bun run src/server/cli.ts login       # device-code auth, no server
```

[README.md](README.md) covers usage and configuration; [ARCHITECTURE.md](ARCHITECTURE.md) covers internals in more depth than this file. Keep both in step when you change behavior they describe. Where docs and source disagree, the source is right.

`build` is mandatory before anything consumes `dist/`: `tsc` emits extensionless relative imports and `scripts/fix-esm-imports.mjs` rewrites them to `./foo.js` / `./foo/index.js` so Bun 1.3.13+ and Node can load the output. The npm `bin` (`kiro-proxy`) and the tray scripts run `dist/`, not `src/`.

Baseline is **311 pass / 1 skip / 0 fail**. Any failure is a regression.

## Architecture

One codebase, two consumers of the same Kiro (AWS CodeWhisperer) engine:

1. **OpenCode plugin** (`src/plugin.ts`; `src/index.ts` default-exports `{ id: 'kiro', server: KiroOAuthPlugin }`). Registers the `kiro` provider and installs a custom `fetch` that intercepts OpenCode's outbound calls and reroutes them through `RequestHandler`. The root `index.ts` is a second, unpackaged re-export surface — `package.json.files` ships only `dist/`.
2. **Standalone HTTP proxy** (`src/server/`), entry `src/server/cli.ts`. Serves `POST /v1/chat/completions` (OpenAI), `POST /v1/messages` + `/v1/messages/count_tokens` (Anthropic / Claude Code), `GET /v1/models`, `/health` and `/api/hello` (unauthenticated), `POST /auth/login`, `GET /auth/status`.

Both paths converge on `RequestHandler.execute()`, so account rotation, token refresh, rate-limit backoff, and request queueing exist once.

### Request pipeline

```
client request
  → model id resolution        server/model-alias.ts (proxy) | plugin/models.ts (plugin)
  → RequestHandler.execute     core/request/request-handler.ts
      AccountSelector          core/account/account-selector.ts
      TokenRefresher           core/auth/token-refresher.ts
      transformToSdkRequest    plugin/request.ts
      GenerateAssistantResponseCommand via plugin/sdk-client.ts
  → transformSdkStreamEvents   plugin/streaming/sdk-stream-transformer.ts  (normalized StreamEvent)
  → wire serializer            streaming/anthropic-sse.ts | server/openai-sse.ts | streaming/openai-converter.ts
```

`StreamEvent` (Anthropic-shaped: `message_start`, `content_block_*`, `message_delta`, `message_stop`) is the internal normal form. Add new output formats as serializers over it; don't parse the SDK stream twice.

### Model id layers

Three tables, deliberately separate:

- `MODEL_MAPPING` in `src/constants.ts` — OpenCode-facing id → Kiro wire id. `-thinking` keys are companions, not models. Every key is verified accepted by `generateAssistantResponse`.
- `LEGACY_MODEL_ALIASES` / `RESOLVABLE_MODELS` (same file) — retired ids kept resolvable because OpenCode persists a model id per session; `resolveKiroModel` throws on anything outside `RESOLVABLE_MODELS`, which would brick an old session.
- `src/server/model-alias.ts` — proxy-only fuzzy layer: Claude Code tier aliases (`sonnet`/`opus`/`haiku`), dated Anthropic ids, namespace prefixes, the `[1m]` marker, `claude-*` renames for Kiro's GPT models (Claude Code's discovery filter drops ids without "claude"/"anthropic"), and `PROXY_REDIRECTS`. It never throws — unknown ids fall back, because Hermes treats a model rejection as permanent.

`src/plugin/model-registry.ts` builds what OpenCode's `/models` picker shows, including the effort ladder as variants.

### Conversation identity

`src/plugin/session-map.ts` maps a client chat onto one stable Kiro `conversationId` — Kiro derives server-side context from it, so minting a new id mid-chat loses continuity and sharing one across chats bleeds context. Two strategies: an explicit session header, else prefix-chain matching over the message list (for clients like Hermes that send no header). `deriveConversationRequest` in `src/server/runtime.ts` namespaces subagent and compaction/auxiliary requests so they don't merge into the parent conversation.

### Accounts and storage

libsql (SQLite) at `~/.config/opencode/kiro.db` (`%APPDATA%\opencode\kiro.db` on Windows), same dir for `kiro.json` config and `kiro-logs/`. `src/plugin/storage/` owns schema, migrations, and cross-process locking (`proper-lockfile`). Accounts are synced in from the local `kiro-cli` / Kiro IDE SQLite databases (`src/plugin/sync/`); account ids are deterministic hashes because IDC `clientId` rotates on re-auth.

Auth differs per surface: the plugin delegates to OpenCode's OAuth plumbing, the proxy uses the AWS OIDC device-code flow in `src/server/headless-auth.ts` (no callback server, works over SSH), and `asReauthClient()` adapts it to the interface `RequestHandler` expects.

### Effort / thinking

`src/plugin/effort.ts` is the single source of truth, keyed on Kiro **wire** ids (dotted form). Kiro validates the effort field against a per-model schema and 400s on a mismatch, so the path is either `output_config.effort` + `thinking.type` (Claude) or `reasoning.effort` (GPT-5.6) — never both, and never mixed. Absence from `REASONING_CAPABILITIES` means the model takes no reasoning fields at all; `auto` is omitted deliberately because it dispatches to an unknown target. Budget→effort bands are scaled to Kiro's real ceiling (1024–128000). `xhigh` is accepted by sonnet-5, opus-4.8, opus-5, opus-5.5 and the GPT models, but not sonnet-4.6. Opus 5.5 rejects `thinking.type: "disabled"` (`thinkingDisableable: false`).

## Conventions

- This working copy is not a git repository (no `.git`), so the husky hook never fires here — run `bun run format` yourself. Prettier config: no semicolons, single quotes, no trailing commas, 100 cols, imports organized by plugin.
- `strict` + `noUncheckedIndexedAccess` are on; indexed access needs a guard or `!`.
- Relative imports inside `src/` are written with `.js` extensions in most modules (required for the emitted ESM). Match the surrounding file.
- Comments in this codebase explain *why* a non-obvious rule exists (a Kiro API quirk, a client's behavior). When you change such code, update the reasoning; when you add a workaround for upstream behavior, record what breaks without it.
- `src/plugin/logger.ts` writes to the log file; `console` is not the logging path. Detailed request logging is gated behind `enable_log_api_request` in `kiro.json`.

## Security notes

The proxy binds `127.0.0.1` with a bearer token by default. `--no-auth` / `KIRO_PROXY_NO_AUTH` and a non-loopback `--host` both let any reachable process spend the user's Kiro credits; `describeBinding()` warns on both. Keep those warnings intact.
