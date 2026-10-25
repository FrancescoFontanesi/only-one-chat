// Prints how the user's personal Codex and Claude CLIs are configured, without
// using model quota: Codex `account/read`, `config/read` and `model/list` over
// app-server, and `claude auth status --json`. Only whitelisted fields are
// printed (never e-mails, ids, tokens or whole config sections); credential
// files are never opened. Dev tooling only.
//
// Usage (PowerShell):
//   $env:CODEX_EXECUTABLE = 'F:\...\codex.exe'; $env:CLAUDE_EXECUTABLE = 'F:\...\claude.exe'
//   pnpm diagnose
// Runs under Vitest only to execute TypeScript without new dependencies.

import { execFileSync, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { describe, it } from 'vitest';

type Json = Record<string, unknown>;

/** API key variables, removed exactly as the adapters do. */
const KEY_VARS = new Set([
  'OPENAI_API_KEY',
  'CODEX_API_KEY',
  'CODEX_ACCESS_TOKEN',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
]);

function userEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !KEY_VARS.has(key.toUpperCase())),
  );
}

function record(value: unknown): Json {
  return typeof value === 'object' && value !== null ? (value as Json) : {};
}

async function diagnoseCodex(executable: string): Promise<Json> {
  const child = spawn(executable, ['app-server'], {
    env: userEnv(),
    stdio: 'pipe',
    windowsHide: true,
  });
  child.stderr.resume();
  const waiting = new Map<number, (message: Json) => void>();
  createInterface({ input: child.stdout }).on('line', (line) => {
    const message = JSON.parse(line) as Json;
    const id = message['id'];
    if (typeof id === 'number' && message['method'] === undefined) waiting.get(id)?.(message);
  });
  let nextId = 0;
  const request = (method: string, params: unknown) =>
    new Promise<Json>((resolve) => {
      const id = nextId++;
      waiting.set(id, resolve);
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  try {
    const init = record(
      (
        await request('initialize', {
          clientInfo: { name: 'only-one-chat-diagnose', version: '0' },
        })
      )['result'],
    );
    child.stdin.write(`${JSON.stringify({ method: 'initialized' })}\n`);
    const account = record((await request('account/read', {}))['result']);
    const config = record(record((await request('config/read', {}))['result'])['config']);
    const models = record((await request('model/list', { includeHidden: true }))['result']);
    const providerId =
      typeof config['model_provider'] === 'string' ? config['model_provider'] : 'openai';
    const provider = record(record(config['model_providers'])[providerId]);
    return {
      userAgent: init['userAgent'],
      requiresOpenaiAuth: account['requiresOpenaiAuth'],
      accountType: record(account['account'])['type'] ?? null,
      planType: record(account['account'])['planType'] ?? null,
      model: config['model'] ?? null,
      reasoningEffort: config['model_reasoning_effort'] ?? null,
      modelProvider: providerId,
      providerName: provider['name'] ?? null,
      providerBaseUrl: provider['base_url'] ?? null,
      providerRequiresOpenaiAuth: provider['requires_openai_auth'] ?? null,
      providerEnvKey: provider['env_key'] ?? null,
      models: (Array.isArray(models['data']) ? models['data'] : []).map((model) => {
        const m = record(model);
        const efforts = Array.isArray(m['supportedReasoningEfforts'])
          ? m['supportedReasoningEfforts'].map((e) => record(e)['reasoningEffort'])
          : [];
        return `${String(m['id'])} [${efforts.join(',')}]`;
      }),
    };
  } finally {
    child.stdin.end();
  }
}

function diagnoseClaude(executable: string): Json {
  const status = record(
    JSON.parse(
      execFileSync(executable, ['auth', 'status', '--json'], {
        env: userEnv(),
        encoding: 'utf8',
        windowsHide: true,
      }),
    ),
  );
  return {
    version: execFileSync(executable, ['--version'], {
      encoding: 'utf8',
      windowsHide: true,
    }).trim(),
    loggedIn: status['loggedIn'],
    authMethod: status['authMethod'],
    apiProvider: status['apiProvider'],
    subscriptionType: status['subscriptionType'],
    anthropicVarsInEnv: Object.keys(process.env).filter((key) => /^ANTHROPIC_/i.test(key)),
  };
}

const codex = process.env['CODEX_EXECUTABLE'];
const claude = process.env['CLAUDE_EXECUTABLE'];

describe.runIf(codex ?? claude)('diagnose personal CLI configuration (no model quota)', () => {
  it.runIf(codex)(
    'codex',
    async () => {
      console.log('codex', JSON.stringify(await diagnoseCodex(codex ?? ''), null, 2));
    },
    60_000,
  );
  it.runIf(claude)(
    'claude',
    () => {
      console.log('claude', JSON.stringify(diagnoseClaude(claude ?? ''), null, 2));
    },
    60_000,
  );
});
