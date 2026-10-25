// Subscription-only authentication for Codex, checked against the independent
// fake server. The fake logs every message it receives to a file, so the tests
// can prove what did (and did not) reach the server.

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CodexAuthError,
  connectCodex,
  type CodexSession,
  type CodexSessionOptions,
} from '../src/index.js';

const FAKE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-app-server.mjs');

let dir: string;
let log: string;
const sessions: CodexSession[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'codex auth '));
  log = join(dir, 'received.jsonl');
});
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.close()));
  rmSync(dir, { recursive: true, force: true });
});

async function connect(
  account: string,
  overrides: Partial<CodexSessionOptions> = {},
  fakeFlags: string[] = [],
): Promise<CodexSession> {
  const session = await connectCodex({
    executable: process.execPath,
    launcherArgs: [FAKE, `--account=${account}`, `--log=${log}`, ...fakeFlags],
    codexHome: join(dir, 'dedicated codex home'),
    clientInfo: { name: 'only-one-chat-tests', version: '0.0.0' },
    requestTimeoutMs: 5_000,
    ...overrides,
  });
  sessions.push(session);
  return session;
}

function receivedMethods(): string[] {
  if (!existsSync(log)) return [];
  return readFileSync(log, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => String((JSON.parse(line) as { method?: string }).method));
}

async function authFailure(promise: Promise<unknown>): Promise<CodexAuthError> {
  const error: unknown = await promise.then(
    () => {
      throw new Error('expected the promise to reject');
    },
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(CodexAuthError);
  return error as CodexAuthError;
}

describe('account verification', () => {
  it('verifies the account right after the handshake, before anything else', async () => {
    await connect('chatgpt');
    expect(receivedMethods()).toEqual(['initialize', 'initialized', 'account/read']);
  });

  it('authorizes a ChatGPT account and then lets requests through', async () => {
    const session = await connect('chatgpt');
    expect(session.auth).toEqual({
      status: 'authorized',
      email: 'user@example.com',
      planType: 'plus',
    });
    expect(await session.request('turn/start')).toEqual({ turn: { id: 'turn-1' } });
  });

  it('rejects an API key account and never forwards model requests', async () => {
    const session = await connect('apiKey');
    expect(session.auth).toMatchObject({ status: 'rejected', reason: 'api_key' });

    const error = await authFailure(session.request('turn/start'));
    expect(error.state).toMatchObject({ status: 'rejected', reason: 'api_key' });
    expect(receivedMethods()).not.toContain('turn/start');
  });

  it('reports login_required for a missing account, without any fallback', async () => {
    const session = await connect('none');
    expect(session.auth).toEqual({ status: 'login_required' });

    const error = await authFailure(session.request('turn/start'));
    expect(error.state).toEqual({ status: 'login_required' });
    expect(receivedMethods()).not.toContain('turn/start');
    expect(receivedMethods()).not.toContain('account/login/start');
  });

  it.each(['bedrock', 'futureMode'])('rejects the unsupported account kind %s', async (kind) => {
    const session = await connect(kind);
    expect(session.auth).toMatchObject({ status: 'rejected', reason: 'unsupported_mode' });
    await authFailure(session.request('turn/start'));
  });

  it.each(['customProvider', 'customProviderChatgpt'])(
    'refuses %s: the active provider does not require OpenAI auth, so the plan cannot be verified',
    async (kind) => {
      const session = await connect(kind);
      expect(session.auth).toMatchObject({ status: 'rejected', reason: 'provider_not_verified' });
      await authFailure(session.request('turn/start'));
    },
  );

  it('grants nothing when account/read fails', async () => {
    const session = await connect('readError');
    expect(session.auth).toMatchObject({ status: 'rejected', reason: 'read_failed' });
    await authFailure(session.request('turn/start'));
    expect(receivedMethods()).not.toContain('turn/start');
  });

  it('grants nothing when the account/read response is incomplete', async () => {
    const session = await connect('missingField');
    expect(session.auth).toMatchObject({ status: 'rejected', reason: 'read_failed' });
    await authFailure(session.request('turn/start'));
  });
});

describe('account changes', () => {
  it('blocks new requests as soon as the account switches from ChatGPT to an API key', async () => {
    const session = await connect('chatgpt');
    expect(await session.request('test/setAccount', { kind: 'apiKey' })).toBe('switched');

    const error = await authFailure(session.request('turn/start'));
    expect(error.state).toMatchObject({ status: 'rejected', reason: 'api_key' });
    expect(receivedMethods()).not.toContain('turn/start');
  });

  it('re-reads the account after an update instead of trusting the notification', async () => {
    const session = await connect('chatgpt');
    await session.request('test/setAccount', { kind: 'chatgpt' });
    await session.request('turn/start');
    expect(receivedMethods().filter((method) => method === 'account/read')).toHaveLength(2);
  });

  it('does not keep an authorization that was read while the account was changing', async () => {
    const session = await connect('updateDuringRead');
    const error = await authFailure(session.request('turn/start'));
    expect(error.state).toMatchObject({ status: 'rejected', reason: 'api_key' });
    expect(receivedMethods()).not.toContain('turn/start');
  });
});

describe('child process environment and profile', () => {
  const hostile = {
    OPENAI_API_KEY: 'sk-should-not-leak',
    CODEX_API_KEY: 'sk-should-not-leak',
    CODEX_ACCESS_TOKEN: 'token-should-not-leak',
    AZURE_OPENAI_API_KEY: 'should-not-leak',
    ANTHROPIC_API_KEY: 'should-not-leak',
    OPENAI_BASE_URL: 'http://127.0.0.1:8787/v1',
    CODEX_OSS_BASE_URL: 'http://127.0.0.1:11434/v1',
    CODEX_REFRESH_TOKEN_URL_OVERRIDE: 'http://127.0.0.1:9/refresh',
    HTTPS_PROXY: 'http://127.0.0.1:8787',
    https_proxy: 'http://127.0.0.1:8787',
    ALL_PROXY: 'socks5://127.0.0.1:1080',
    CODEX_HOME: join(homedir(), 'personal codex home'),
  };

  it('passes only allow-listed variables, with CODEX_HOME set to the dedicated profile', async () => {
    const session = await connect('chatgpt', { baseEnv: { ...process.env, ...hostile } });
    const env = (await session.request('test/env')) as Record<string, string>;

    for (const name of Object.keys(hostile).filter((key) => key !== 'CODEX_HOME')) {
      expect(Object.keys(env).map((key) => key.toUpperCase())).not.toContain(name.toUpperCase());
    }
    expect(JSON.stringify(env)).not.toContain('should-not-leak');
    expect(env['CODEX_HOME']).toBe(join(dir, 'dedicated codex home'));
    expect(Object.keys(env).some((key) => key.toUpperCase() === 'PATH')).toBe(true);
  });

  it('creates the dedicated profile directory', async () => {
    await connect('chatgpt');
    expect(existsSync(join(dir, 'dedicated codex home'))).toBe(true);
  });

  it('pins the provider, base URL and login method on the command line, before app-server', async () => {
    const session = await connect('chatgpt');
    const argv = (await session.request('test/argv')) as string[];
    const codexArgs = argv.slice(argv.findIndex((arg) => arg === '-c'));
    expect(codexArgs).toEqual([
      '-c',
      'forced_login_method="chatgpt"',
      '-c',
      'model_provider="openai"',
      '-c',
      'openai_base_url=""',
      '-c',
      'features.plugins=false',
      'app-server',
    ]);
  });

  it('disables plugins, and with them the startup sync from GitHub, before app-server', async () => {
    const session = await connect('chatgpt');
    const argv = (await session.request('test/argv')) as string[];
    const at = argv.indexOf('features.plugins=false');
    expect(at).toBeGreaterThan(0);
    expect(argv[at - 1]).toBe('-c');
    expect(at).toBeLessThan(argv.indexOf('app-server'));
  });

  it.each([
    ['the personal ~/.codex profile', join(homedir(), '.codex')],
    ['the CODEX_HOME of the parent environment', join(homedir(), 'personal codex home')],
    ['a relative path', 'codex-home'],
  ])('refuses %s as the dedicated profile', async (_label, codexHome) => {
    await expect(
      connect('chatgpt', {
        codexHome,
        baseEnv: { ...process.env, CODEX_HOME: hostile.CODEX_HOME },
      }),
    ).rejects.toThrow(/profile/i);
    expect(receivedMethods()).toEqual([]);
  });
});

describe('official login methods', () => {
  it('starts the browser ChatGPT login and returns the authorization URL', async () => {
    const session = await connect('none');
    expect(await session.startLogin('chatgpt')).toEqual({
      type: 'chatgpt',
      loginId: 'login-1',
      authUrl: 'https://auth.openai.com/oauth/authorize?x=1',
    });
  });

  it('starts the device-code login and returns the code to show the user', async () => {
    const session = await connect('none');
    expect(await session.startLogin('chatgptDeviceCode')).toEqual({
      type: 'chatgptDeviceCode',
      loginId: 'login-1',
      verificationUrl: 'https://auth.openai.com/codex/device',
      userCode: 'ABCD-1234',
    });
  });

  it('refuses a login URL that is not https', async () => {
    const session = await connect('none', {}, ['--login-url=javascript:alert(1)']);
    await expect(session.startLogin('chatgpt')).rejects.toThrow(/https/);
  });

  it('cannot be used to start any other login type, such as an API key', async () => {
    const session = await connect('none');
    await expect(session.startLogin('apiKey' as 'chatgpt')).rejects.toThrow(/login method/);
    await expect(
      session.request('account/login/start', { type: 'apiKey', apiKey: 'sk-x' }),
    ).rejects.toThrow(/startLogin/);
    expect(receivedMethods()).not.toContain('account/login/start');
  });
});
