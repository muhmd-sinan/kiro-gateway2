# Architecture

Kiro Gateway puts two client-facing surfaces, an OpenCode plugin and an HTTP proxy, in front of
one Kiro engine. Everything that touches Kiro (accounts, auth, retries, request building, stream
parsing) is shared. Each surface only adds its own wire format.

```
 Claude Code ──► POST /v1/messages ─────────┐
 Hermes, etc. ─► POST /v1/chat/completions ─┤  src/server/   (standalone proxy)
                                            ▼
                                       KiroRuntime ──► server-tools (web search loop)
                                            │
 OpenCode ─────► custom fetch ──────────────┤  src/plugin.ts (OpenCode plugin)
                                            ▼
                                     RequestHandler           src/core/request/
                 account selection · token refresh · retries · concurrency limit
                                            │
                                   transformToSdkRequest      src/plugin/request.ts
                        history · tools · images · documents · reasoning fields
                                            │
                           GenerateAssistantResponseCommand ──► Kiro
                                            │
                                 transformSdkStreamEvents     src/plugin/streaming/
                                  normalized StreamEvent stream
                                            │
                 ┌──────────────────────────┼──────────────────────────┐
           anthropic-sse.ts          server/openai-sse.ts        openai-converter.ts
            (Claude Code)            (proxy, OpenAI)             (OpenCode plugin)
```

## Source layout

| Path | Role |
|---|---|
| `src/server/` | Proxy: CLI, HTTP routing, runtime, model aliases, server tools, device-code auth |
| `src/plugin.ts` | OpenCode plugin entry: provider registration, fetch hook, `kiro_web_search` tool |
| `src/core/` | Account selection, token refresh, error handling, `RequestHandler` |
| `src/infrastructure/` | History building, message and tool transforms, account cache/repository |
| `src/plugin/` | Request building, streaming, effort, models, images, documents, storage, sync, logging |
| `src/kiro/` | Refresh-token encoding, IDC OAuth |
| `src/constants.ts` | Model tables, Kiro endpoints |

## Request lifecycle (proxy)

1. **Routing** (`server/http.ts`). The token is checked, the JSON body parsed, and the request
   dispatched by path.
2. **Model resolution** (`server/model-alias.ts`). The client's id is mapped to a
   `MODEL_MAPPING` key. See [Model resolution](#model-resolution).
3. **Conversation identity** (`plugin/session-map.ts`). The request is matched to a stable Kiro
   `conversationId`. See [Conversation identity](#conversation-identity).
4. **Server tools** (`server/server-tools.ts`, Anthropic route only). Server-executed tool
   declarations are removed; web search is swapped for a tool the proxy runs itself.
5. **Execution** (`core/request/request-handler.ts`). The request waits for a concurrency slot,
   then picks an account, refreshes the token if needed, builds the Kiro request, and sends it,
   retrying on 429/403/network errors.
6. **Stream normalization** (`plugin/streaming/sdk-stream-transformer.ts`). Kiro's events are
   turned into Anthropic-shaped `StreamEvent`s.
7. **Serialization and pumping** (`server/http.ts`). Events are serialized for the client's wire
   format and written, with keep-alives and disconnect handling.

## Design rules

**`StreamEvent` is the internal format.** Kiro's stream is parsed once, in
`transformSdkStreamEvents`, into `message_start` / `content_block_*` / `message_delta` /
`message_stop`. Each client format is a serializer over that, so a tool call sent to Claude Code
and the same call sent to Hermes come from the same code. New output formats should be new
serializers; don't parse the Kiro stream a second time.

**Proxy behavior is opt-in.** Anything added for the proxy is enabled by a parameter that only the
proxy passes: `HistoryOptions` (image/document retention, keeping reasoning in tool loops, PDF
support), `StreamTransformOptions.streamToolInput`, and `ProxyRequest.serverTools`. The OpenCode
plugin never passes them, so its requests are built exactly as before. Tests cover both paths.

**Never reject a model id.** Hermes treats a model error as permanent and breaks the session, and
Claude Code can't list what the proxy supports. `resolveModelId` always returns something usable.

**Comments explain the reason.** Most rules in this code exist because of a Kiro API quirk or a
client's behavior. The comment next to each one says what breaks without it. Keep that reasoning
up to date when you change the rule.

## Model resolution

Three tables, kept separate on purpose:

- **`MODEL_MAPPING`** (`constants.ts`): OpenCode-facing id → Kiro wire id (dashes → dots, e.g.
  `claude-opus-5-5` → `claude-opus-5.5`). `-thinking` keys are companions that select extended
  thinking, not separate models. Every entry is verified to be accepted by Kiro.
- **`LEGACY_MODEL_ALIASES`** (`constants.ts`): retired ids that still resolve. OpenCode saves the
  model id per session, and `resolveKiroModel` throws on unknown ids, so without these an old
  session would fail on every request.
- **`server/model-alias.ts`**: the proxy's forgiving layer. It handles Claude Code's tier aliases
  (`opus` → Opus 5.5, `sonnet` → Sonnet 5, `haiku` → GPT Luna), Anthropic date stamps, namespace
  prefixes, the `[1m]` suffix, `claude-*` names for GPT models (Claude Code's picker hides ids
  without "claude"), and `PROXY_REDIRECTS`, which win over an exact match. Unknown ids are matched
  by family keyword, then fall back to the default model.

`plugin/model-registry.ts` builds OpenCode's model list, including the effort variants.

## Conversation identity

Kiro keeps server-side context per `conversationId`. Starting a new id mid-chat loses that
context; sharing an id between chats mixes them. `resolveConversationId` uses two strategies:

1. **Explicit session header** (`x-claude-code-session-id`, `x-opencode-session-id`, …),
   namespaced by `deriveConversationRequest` in `server/runtime.ts`. Subagent requests carry the
   parent's session id, so they're scoped by `x-claude-code-agent-id`. Compaction and auxiliary
   requests are scoped separately so they don't become part of the chat.
2. **Prefix-chain matching** for clients with no header (Hermes). Each request's messages are
   hashed one prefix at a time. A request continues a conversation if its history extends a known
   chain. Each chain state can be claimed only once, so two chats that happen to start the same
   way stay separate. `<system-reminder>` blocks, thinking text, and `cache_control` are left out
   of the hash because clients change them between turns.

The map lives in memory and is written to `kiro-sessions.json` at most once per second, plus once
on exit. It's pruned after 30 days or 5000 entries.

The conversation id doesn't shorten requests. Clients send the full history every turn and the
proxy forwards all of it. Kiro caches repeated history automatically.

## Accounts and auth

- **Storage**: SQLite via libsql at `kiro.db` (`plugin/storage/`), with migrations and
  cross-process file locking, since the plugin and the proxy can run at the same time. Account ids
  are deterministic hashes because the IDC `clientId` changes on re-auth.
- **Sync**: sessions from `kiro-cli` and Kiro IDE are imported on startup (`plugin/sync/`), and
  refreshed tokens are written back to them.
- **Selection** (`core/account/account-selector.ts`): `sticky`, `round-robin`, or `lowest-usage`,
  skipping unhealthy and rate-limited accounts, with a circuit breaker.
- **Refresh** (`core/auth/token-refresher.ts`): refreshes before expiry, forces a refresh on an
  invalid-bearer 403, and tries a CLI sync first in case another process already has a newer
  token.
- **Re-auth**: the plugin uses OpenCode's OAuth flow. The proxy uses the AWS OIDC device-code flow
  (`server/headless-auth.ts`), which needs no callback server. `asReauthClient()` adapts it to what
  `RequestHandler` expects, so a pool where every account has expired can recover without a
  restart.

## Concurrency

`enqueueKiroRequest` is a process-wide semaphore (`max_concurrent_requests`, default 4). It used
to be a mutex, which made Claude Code's background calls and parallel subagents wait for each
other. The slot is held only until Kiro's response *starts*; the stream is read afterwards, outside
the limit. So the setting caps how many requests are being started at once, which is what causes
429s, not how many streams are open.

## Request building

`plugin/request.ts` and `infrastructure/transformers/` turn a client body into Kiro's
`conversationState`:

- **Messages** are merged when adjacent messages share a role. The merge copies arrays rather than
  modifying the client's objects, because retries and web-search iterations rebuild from the same
  body. System prompts (string or Claude Code's block array) go into the first user message.
- **Tool results** carry `status: error` when the client set `is_error`, so the model knows a
  command failed.
- **Tool loops**: `collapseAgenticLoops` replaces repeated assistant text between tool calls with a
  placeholder. The proxy sets `preserveLoopText`, so the model's own reasoning between calls is
  kept and only exact repeats and empty turns are collapsed.
- **Tool names** that Kiro would reject are replaced with aliases through a per-request registry
  and restored on the way back.
- **Tool schemas** are reduced to the subset of JSON Schema Kiro accepts: local `$ref`s resolved,
  `allOf` merged, nullable unions flattened.
- **Images** become `images` (at most 4 per message). **Documents** (`plugin/document-handler.ts`)
  become `documents`, including PDFs nested inside a `tool_result`, which is how Claude Code's Read
  tool returns them. Plain-text documents are pasted in as text. Only the newest
  `history_image_messages` history messages keep their images and documents; older ones get a
  text note instead.
- **Reasoning fields** (`plugin/effort.ts`): see below.

## Effort and thinking

`REASONING_CAPABILITIES` in `plugin/effort.ts` is keyed on Kiro wire ids. Kiro checks
`additionalModelRequestFields` against a per-model schema and returns 400 on any mismatch, so each
model gets exactly the fields it accepts:

| Family | Effort field | Thinking toggle |
|---|---|---|
| Claude | `output_config.effort` | `thinking.type`: `adaptive` / `disabled` |
| Claude Opus 5.5 | `output_config.effort` | `adaptive` only (`disabled` returns 400) |
| GPT 5.6 | `reasoning.effort` | none (`thinking` returns 400) |

Models not in the table, including `auto`, get no reasoning fields. Thinking budgets map to effort
levels in bands scaled to Kiro's real range (1024–128000). `xhigh` is clamped to `max` on models
that don't accept it.

## Streaming

`transformSdkStreamEvents` reads Kiro's event stream:

- **Reasoning**: native `reasoningContentEvent` becomes a thinking block. If a model writes
  `<thinking>` tags into its text instead, they're pulled out as a fallback, ignoring tags inside
  code blocks.
- **Tool calls** arrive as many `toolUseEvent` pieces (one file write measured 224 pieces over
  ~9s). With `streamToolInput` (proxy) each piece goes out as an `input_json_delta` as it arrives;
  the first tool block appeared at 3.1s instead of 12.4s. Without it (plugin), calls are buffered
  and sent once at the end.
- **Block order**: only one block is open at a time. Opening a tool block closes text and
  thinking first, and text after a tool call opens a new block. Every block gets exactly one
  `content_block_stop`; Claude Code stalls on a block that never closes. Tests check this order.
- **Bracket-style calls** (`[Called X with args: {...}]`) found in text are turned into real tool
  calls. A quick substring check skips the regex when none are present.
- **Usage**: output tokens are estimated from text, reasoning, and tool input. Input tokens come
  from Kiro's context-usage percentage minus output. Credits from `meteringEvent` travel on
  `message_delta.metering` for logging only; no serializer sends them to a client.

### Anthropic serialization (`plugin/streaming/anthropic-sse.ts`)

- Each response gets a new `msg_…` id. The conversation id is the same for every turn in a chat
  and can't be used as a message id.
- Thinking blocks get a generated `signature_delta` before they close. That's safe because only
  this proxy ever reads those signatures back.
- Empty deltas used internally as markers are dropped.
- `collectAnthropicMessage` builds the same content blocks for non-streaming requests.

### Pumping (`server/http.ts`)

Headers are flushed immediately and Nagle's algorithm is disabled. Each event is one write. A
single interval sends a keep-alive (`ping`, or an SSE comment for OpenAI) after
`keepAliveSeconds` of silence; Claude Code aborts a stream that's silent for 300s, and Kiro can
pause that long while reasoning. When the client disconnects, the event generator is closed, which
stops reading from Kiro and stops the web-search loop.

## Web search (server tools)

Claude Code declares web search as a *server* tool (`web_search_20250305`): it has no input schema
and expects the API to run the search itself. Passed straight through, Kiro would see a
parameterless `web_search` tool, the model would call it, and Claude Code would wait forever on a
tool it can't run.

`server/server-tools.ts` handles this on the Anthropic route:

1. `normalizeServerToolHistory` turns earlier `server_tool_use` / `web_search_tool_result` blocks
   into text, so the model can see what it already searched.
2. `planServerTools` removes every server-executed tool (`web_search`, `web_fetch`, code
   execution). Removing them is what stops the hang. If search was requested and is available
   (enabled and a Pro account), a real `web_search` tool with a `query` parameter is added.
3. `runServerToolLoop` catches calls to that tool, runs `kiroWebSearch` (Kiro's `InvokeMCP`
   target), and sends the results back to Kiro as a normal tool_use/tool_result pair so the model
   continues. The client receives the documented `server_tool_use` + `web_search_tool_result`
   blocks, with block indices renumbered across upstream calls and one set of message frames.
   `max_uses` is respected (`max_uses_exceeded`), failures become
   `web_search_tool_result_error`, and the loop stops if the model also calls a client tool.

The OpenCode plugin exposes the same search as its own `kiro_web_search` tool.

## Logging and diagnostics

`plugin/logger.ts` buffers lines and writes them every 250 ms (errors are written immediately), so
disk writes don't block streaming. Each upstream call logs one `Proxy timing` line: time waiting
for a slot, time until Kiro started responding, time to first content, total stream time, credits,
and outcome (`complete` / `error` / `aborted`). `enable_log_api_request` also writes every request
and response as JSON files, with binary data base64-encoded.

## Build

`tsc` emits relative imports without file extensions, which Bun 1.3.13+ and Node reject.
`scripts/fix-esm-imports.mjs` rewrites them to `./foo.js` or `./foo/index.js` after the build. The
`kiro-proxy` binary and the tray scripts run `dist/`, so rebuild after every source change.
