#!/usr/bin/env node
/**
 * Standalone Kiro proxy server.
 *
 * Exposes Kiro's Claude/GPT/open-weight models over two wire formats from one
 * process, so any agent CLI can use them:
 *
 *   POST /v1/chat/completions   OpenAI-compatible  → Hermes Agent, OpenCode, most tools
 *   POST /v1/messages           Anthropic Messages → Claude Code
 *   GET  /v1/models             model discovery for both
 *
 * Account rotation, token refresh, rate-limit backoff, and request queueing are
 * shared with the OpenCode plugin — this only adds the HTTP layer.
 *
 * Usage:
 *   kiro-proxy [--port N] [--host H] [--token T] [--no-auth] [--model ID]
 */
import { DEFAULT_PORT, loadServerConfig, tokenPath, type ServerConfig } from './config.js'
import { describeBinding, startProxyServer } from './http.js'
import { KiroRuntime } from './runtime.js'

function parseArgs(argv: string[]): Partial<ServerConfig> & { help?: boolean; login?: boolean } {
  const out: Partial<ServerConfig> & { help?: boolean; login?: boolean } = {}

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const next = () => argv[++i]

    switch (arg) {
      case 'login':
        out.login = true
        break
      case '--port':
      case '-p': {
        const value = Number.parseInt(next() ?? '', 10)
        if (Number.isFinite(value)) out.port = value
        break
      }
      case '--host':
      case '-h':
        out.host = next()
        break
      case '--token':
        out.token = next()
        break
      case '--no-auth':
        out.token = ''
        break
      case '--model':
      case '-m':
        out.defaultModel = next()
        break
      case '--keepalive': {
        const value = Number.parseInt(next() ?? '', 10)
        if (Number.isFinite(value)) out.keepAliveSeconds = value
        break
      }
      case '--help':
        out.help = true
        break
    }
  }

  return out
}

const USAGE = `kiro-proxy — serve Kiro models over OpenAI and Anthropic APIs

Options:
  -p, --port <n>        Port to listen on (default ${DEFAULT_PORT}, env KIRO_PROXY_PORT)
  -h, --host <addr>     Bind address (default 127.0.0.1, env KIRO_PROXY_HOST)
      --token <tok>     Bearer token clients must send (env KIRO_PROXY_TOKEN)
      --no-auth         Disable the credential check (loopback only)
  -m, --model <id>      Fallback model for unknown ids (default claude-sonnet-4-6)
      --keepalive <n>   Seconds between stream keep-alives (default 15)
      --help            Show this message

Endpoints:
  POST /v1/chat/completions   OpenAI-compatible (Hermes Agent, OpenCode)
  POST /v1/messages           Anthropic Messages (Claude Code)
  GET  /v1/models             Model list
  GET  /health                Status probe (no auth)
  POST /auth/login            Start device-code re-authentication
  GET  /auth/status           Re-authentication state

Commands:
  login                 Run the device-code flow and exit (no server)
`

/**
 * Run the device-code flow to completion and exit.
 *
 * Prints the URL and code, then polls. Works over SSH and in containers because
 * approval happens in whatever browser the user has, not on this machine.
 */
async function runLogin(runtime: KiroRuntime): Promise<void> {
  const started = await runtime.auth.begin()
  if (!started.url) {
    process.stderr.write('Could not start the authentication flow.\n')
    process.exitCode = 1
    return
  }

  process.stdout.write(
    [
      '',
      'Open this URL and approve the request:',
      `  ${started.url}`,
      '',
      `Code: ${started.userCode}`,
      '',
      'Waiting for approval...',
      ''
    ].join('\n')
  )

  const final = await runtime.auth.waitForCompletion()
  if (final.state === 'success') {
    process.stdout.write(`Authenticated as ${final.email}. Accounts: ${final.accounts}\n`)
    return
  }
  process.stderr.write(`Authentication failed: ${final.error ?? 'unknown error'}\n`)
  process.exitCode = 1
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    process.stdout.write(USAGE)
    return
  }

  const { help: _help, login, ...overrides } = args
  const config = loadServerConfig(overrides)

  process.stdout.write('Starting Kiro proxy...\n')
  const runtime = await KiroRuntime.create()

  if (login) {
    await runLogin(runtime)
    return
  }

  // A zero-account pool is recoverable now: start anyway and let the operator
  // authenticate via `kiro-proxy login` or POST /auth/login. Exiting would make
  // the server unable to host the very flow that fixes it.
  if (runtime.accountCount() === 0) {
    process.stdout.write(
      '\nNo Kiro accounts found. The server will start, but requests fail until you authenticate:\n' +
        '  kiro-proxy login          (device-code flow in this terminal)\n' +
        '  POST /auth/login          (same flow over HTTP)\n'
    )
  }

  const handle = await startProxyServer(runtime, config)

  const lines = [
    '',
    ...describeBinding(config),
    `Accounts: ${runtime.accountCount()}${runtime.hasProAccount() ? ' (Pro)' : ''}`,
    `Default model: ${config.defaultModel}`,
    ''
  ]
  if (config.token) {
    lines.push(`Token: ${config.token}`, `  stored at ${tokenPath()}`, '')
  }
  lines.push(
    'Claude Code:',
    `  $env:ANTHROPIC_BASE_URL="${handle.url}"`,
    `  $env:ANTHROPIC_AUTH_TOKEN="${config.token || 'unused'}"`,
    '  $env:ANTHROPIC_DEFAULT_HAIKU_MODEL="claude-luna[1m]"',
    '  $env:CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS="1"',
    '',
    'Hermes Agent (~/.hermes/config.yaml):',
    '  model:',
    '    provider: custom',
    `    base_url: ${handle.url}/v1`,
    `    api_key: ${config.token || 'no-key-required'}`,
    `    default: ${config.defaultModel}`,
    '    context_length: 1000000',
    ''
  )
  process.stdout.write(lines.join('\n'))

  const shutdown = () => {
    process.stdout.write('\nShutting down...\n')
    void handle.close().then(() => process.exit(0))
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch((e) => {
  process.stderr.write(`Failed to start: ${e instanceof Error ? e.message : String(e)}\n`)
  process.exit(1)
})
