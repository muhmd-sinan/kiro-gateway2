# Kiro Gateway

Use your AWS Kiro (CodeWhisperer) subscription from Claude Code, Hermes Agent, OpenCode, or any
OpenAI/Anthropic-compatible client.

The package ships two things that share one engine:

- **A standalone proxy** (`kiro-proxy`) that serves Kiro over the Anthropic Messages API
  (`/v1/messages`, for Claude Code) and the OpenAI Chat Completions API (`/v1/chat/completions`).
- **An OpenCode plugin** that registers a `kiro` provider inside OpenCode.

Both use the same account pool, token refresh, rate-limit backoff, and request queue. How it works
inside is in [ARCHITECTURE.md](ARCHITECTURE.md).

## Features

- **Claude Code support**: streaming, thinking, tool calls streamed while they're still being
  written, parallel subagents, plan mode.
- **Web search**: Claude Code's built-in `web_search` runs through Kiro's search. Needs a Kiro Pro
  account.
- **PDFs and documents**: attached files and PDFs opened with Claude Code's Read tool are passed to
  the model. Supported formats: PDF, DOCX, DOC, XLSX, XLS, CSV, HTML, MD, TXT.
- **Images**, with older images trimmed from long histories to keep requests small.
- **Stable conversations**: each chat keeps one Kiro conversation id across turns. Subagent and
  compaction requests are kept separate from the main chat.
- **Multiple accounts**, rotated with `sticky`, `round-robin`, or `lowest-usage`. Accounts are
  imported automatically from `kiro-cli` and Kiro IDE.
- **Headless re-auth**: AWS device-code sign-in works over SSH and in containers, from the
  terminal or over HTTP.
- **Effort mapping**: thinking budgets map to Kiro's effort levels (`low`–`max`) per model.

## Models

| Advertised id | Kiro model | Notes |
|---|---|---|
| `claude-opus-5-5[1m]` | claude-opus-5.5 | Claude Code's `opus` / `opusplan` tier |
| `claude-opus-5[1m]` | claude-opus-5 | |
| `claude-opus-4-8[1m]` | claude-opus-4.8 | |
| `claude-sonnet-5[1m]` | claude-sonnet-5 | Claude Code's `sonnet` tier |
| `claude-sonnet-4-6[1m]` | claude-sonnet-4.6-1m | |
| `claude-sol[1m]` / `claude-terra[1m]` / `claude-luna[1m]` | gpt-5.6-sol / terra / luna | Renamed so Claude Code's model picker shows them. Luna is the `haiku` tier. |
| `auto[1m]` | auto | Kiro picks the model |

Every model has a 1M-token context window. The `[1m]` suffix tells Claude Code that; the proxy
strips it before resolving the model. Unknown or retired ids are mapped to the closest current
model instead of failing.

## Proxy quick start

Requires [Bun](https://bun.sh) 1.3+ or Node 20+, and a Kiro account.

```bash
bun install
bun run build
```

Sign in, either with `kiro-cli login` (the proxy imports that session automatically) or with the
proxy's own device-code flow:

```bash
node dist/server/cli.js login
```

Start the proxy:

```bash
node dist/server/cli.js
```

On startup it prints the address, the bearer token, and ready-to-paste client settings.

### Claude Code

PowerShell:

```powershell
$env:ANTHROPIC_BASE_URL="http://127.0.0.1:19899"
$env:ANTHROPIC_AUTH_TOKEN="<token printed at startup>"
$env:ANTHROPIC_DEFAULT_HAIKU_MODEL="claude-luna[1m]"
$env:CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS="1"
claude
```

Then pick a model with `/model`, e.g. `claude-opus-5-5[1m]`.

### Hermes Agent and other OpenAI clients

```yaml
# ~/.hermes/config.yaml
model:
  provider: custom
  base_url: http://127.0.0.1:19899/v1
  api_key: <token printed at startup>
  default: claude-sonnet-4-6
  context_length: 1000000
```

### Windows tray

`scripts/install-shortcut.ps1` creates a Start Menu shortcut that runs the proxy as a
notification-area icon without a console window. Copy the shortcut into
`shell:startup` to launch it at login.

## Proxy options

| Flag | Env | Default | |
|---|---|---|---|
| `-p, --port` | `KIRO_PROXY_PORT` | `19899` | |
| `-h, --host` | `KIRO_PROXY_HOST` | `127.0.0.1` | See [Security](#security) |
| `--token` | `KIRO_PROXY_TOKEN` | generated, saved | Bearer token clients must send |
| `--no-auth` | `KIRO_PROXY_NO_AUTH=1` | off | Disables the token check |
| `-m, --model` | `KIRO_PROXY_DEFAULT_MODEL` | `claude-sonnet-4-6` | Fallback for unrecognized ids |
| `--keepalive` | `KIRO_PROXY_KEEPALIVE_SECONDS` | `15` | Silence before a keep-alive ping |

Endpoints:

| | |
|---|---|
| `POST /v1/messages` | Anthropic Messages (Claude Code) |
| `POST /v1/messages/count_tokens` | Token estimate |
| `POST /v1/chat/completions` | OpenAI Chat Completions |
| `GET /v1/models` | Model list |
| `GET /health` | Status, no auth |
| `POST /auth/login` | Start device-code sign-in |
| `GET /auth/status` | Sign-in progress |

## OpenCode plugin

Add it to `opencode.json`:

```json
{
  "plugin": ["@zhafron/opencode-kiro-auth"]
}
```

The plugin registers the `kiro` provider with every model plus a `-thinking` companion for each
model that supports effort. Pick one with `/models` and cycle its variants to change reasoning
depth.

Sign in with `kiro-cli login` (imported on startup) or `opencode auth login` → Other → `kiro`.
For IAM Identity Center, enter your Start URL and region when prompted; the TUI `/connect` flow
doesn't show those prompts, so use `opencode auth login` instead.

If you define `provider.kiro.models` yourself, it replaces the plugin's list. Every `-thinking`
model you define needs `"reasoning": true` and `"interleaved": { "field": "reasoning_content" }`,
or OpenCode drops its reasoning output.

## Configuration

`~/.config/opencode/kiro.json` (`%APPDATA%\opencode\kiro.json` on Windows) applies to both the
proxy and the plugin. A default file is created on first run.

| Key | Default | |
|---|---|---|
| `account_selection_strategy` | `lowest-usage` | `sticky`, `round-robin`, `lowest-usage` |
| `default_region` | `us-east-1` | |
| `idc_start_url`, `idc_region`, `idc_profile_arn` | — | IAM Identity Center defaults |
| `auto_sync_kiro_cli` | `true` | Import sessions from `kiro-cli` / Kiro IDE |
| `max_concurrent_requests` | `4` | Upstream requests started at once. `1` fully serializes. |
| `history_image_messages` | `3` | Proxy only: history messages that keep their images/PDFs |
| `web_search_enabled` | `true` | Needs a Pro account |
| `effort` | — | Force one effort level for every request |
| `auto_effort_mapping` | `true` | Map thinking budgets to effort levels |
| `rate_limit_retry_delay_ms` | `5000` | |
| `rate_limit_max_retries` | `3` | |
| `max_request_iterations` | `20` | Retry-loop cap |
| `request_timeout_ms` | `120000` | |
| `token_expiry_buffer_ms` | `300000` | Refresh this long before expiry |
| `usage_tracking_enabled` | `true` | |
| `enable_log_api_request` | `false` | Write every request/response to `kiro-logs/` |

Effort per thinking budget:

| Budget | Effort |
|---|---|
| ≤ 16384 | `low` |
| ≤ 32768 | `medium` |
| ≤ 65536 | `high` |
| ≤ 98304 | `xhigh` |
| > 98304 | `max` |

`xhigh` exists on sonnet-5, opus-4.8, opus-5, opus-5.5 and the GPT models. Elsewhere it's clamped
to `max`.

## Limitations

- **No `tool_choice`, `max_tokens`, `stop_sequences`, or `temperature`.** Kiro's API has no fields
  for them, so they're ignored.
- **Token counts are estimates.** Kiro reports only context-usage percentage and credits. Claude
  Code's cache counters always show 0.
- **Prompt caching is automatic.** Kiro caches repeated history on its own (a repeated prefix costs
  about half), and the proxy doesn't need to mark anything. Credits per call are logged so you can
  see it.
- **Server-side `web_fetch` and code execution aren't available.** Claude Code's own `WebFetch`
  runs locally and still works.
- **Limits per message:** 4 images, 5 documents, 4.5 MB per document. Anything over the limit is
  noted in the message instead of failing the request.
- **Background tasks use GPT 5.6 Luna.** Kiro has no Haiku.

## Logs and storage

In `~/.config/opencode/` (`%APPDATA%\opencode\` on Windows):

| | |
|---|---|
| `kiro.db` | Accounts and usage (SQLite) |
| `kiro.json` | Configuration |
| `kiro-sessions.json` | Chat → Kiro conversation id map |
| `kiro-proxy-token` | Proxy bearer token |
| `kiro-logs/plugin.log` | Log, including one `Proxy timing` line per upstream call |

A `Proxy timing` line looks like this:

```
Proxy timing {"model":"claude-opus-5-5","queueMs":0,"responseStartMs":2176,"firstContentMs":56,"streamMs":56,"credits":0.0439,"outcome":"complete"}
```

`responseStartMs` is the wait before Kiro started responding, which is usually most of the
latency.

## Troubleshooting

**403 AccessDeniedException with IAM Identity Center.** You need a profile ARN. Run
`kiro-cli profile`, select one, and restart; or set `idc_profile_arn` in `kiro.json`.

**"No accounts".** Run `kiro-cli login` or `kiro-proxy login`, and check that `auto_sync_kiro_cli`
is `true`. The proxy starts with no accounts so you can sign in over `POST /auth/login`.

**Claude Code doesn't list a model.** Its picker hides ids without "claude" in them. Use the
advertised ids from `GET /v1/models`.

**Web search does nothing.** It needs a Pro account (one with a profile ARN) and
`web_search_enabled: true`. Without them the tool is removed from the request instead of failing.

**Rate limits during heavy subagent use.** Lower `max_concurrent_requests`.

## Security

The proxy listens on `127.0.0.1` and requires a bearer token by default. With `--no-auth`, or with
`--host` set to anything other than loopback, any process that can reach the port can spend your
Kiro credits. The proxy prints a warning in both cases. Keep the token in
`kiro-proxy-token` private.

## Development

```bash
bun test                                       # full suite
bun test src/__tests__/effort.test.ts          # one file
bun test --test-name-pattern "resolveModelId"  # by name
bun run typecheck
bun run format
bun run proxy                                  # run from source
```

`bun run build` is required before anything uses `dist/` (the `kiro-proxy` binary and the tray
scripts). See [CLAUDE.md](CLAUDE.md) for contributor notes.

## Acknowledgements

Thanks to [AIClient-2-API](https://github.com/justlovemaki/AIClient-2-API) for the original Kiro
authentication logic and request patterns.

## Disclaimer

For learning and educational purposes. This is an independent project, not affiliated with or
endorsed by Amazon Web Services or Anthropic. Use at your own risk.
