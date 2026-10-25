// Account policy and launch of Codex in the user's own profile, checked against
// the independent fake server. The fake logs every message it receives to a
// file, so the tests can prove what did (and did not) reach the server.

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  API_KEY_VARIABLES,
  CodexAuthError,
  connectCodex,
  type CodexSession,
  type CodexSessionOptions,
} from '../src/index.js';
import { ISOLATED_PROFILE_OVERRIDES } from '../dev/isolated-profile.js';

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

const PROXY = ['--provider=headroom', '--provider-name=Headroom persistent proxy'];
const HEADROOM = {
  id: 'headroom',
  name: 'Headroom persistent proxy',
  baseUrl: 'http://127.0.0.1:9/v1',
  unofficialBaseUrl: true,
};

describe('account verification', () => {
  it('verifies the account right after the handshake, before anything else', async () => {
    await connect('none');
    expect(receivedMethods()).toEqual(['initialize', 'initialized', 'account/read', 'config/read']);
  });

  it('reads again when the startup announcement of the account races the first read', async () => {
    const notifications: string[] = [];
    const session = await connect('chatgpt', {
      onNotification: (method) => notifications.push(method),
    });
    expect(notifications).toContain('account/updated');
    expect(session.auth).toMatchObject({ status: 'authorized', planType: 'plus' });
    expect(receivedMethods()).toEqual([
      'initialize',
      'initialized',
      'account/read',
      'config/read',
      'account/read',
      'config/read',
    ]);
  });

  it('gives up after three startup reads that all raced with a change', async () => {
    const session = await connect('updateOnEveryRead');
    expect(session.auth).toMatchObject({ status: 'rejected', reason: 'read_failed' });
    expect(receivedMethods().filter((method) => method === 'account/read')).toHaveLength(3);
    await authFailure(session.request('turn/start'));
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

  it.each(['apiKey', 'customProviderApiKey'])(
    'rejects the API key account %s and never forwards model requests',
    async (kind) => {
      const session = await connect(kind, { allowUnverifiedProvider: true }, PROXY);
      expect(session.auth).toMatchObject({ status: 'rejected', reason: 'api_key' });

      const error = await authFailure(session.request('turn/start'));
      expect(error.state).toMatchObject({ status: 'rejected', reason: 'api_key' });
      expect(receivedMethods()).not.toContain('turn/start');
    },
  );

  it('reports login_required and points to the CLI login, without starting one', async () => {
    const session = await connect('none');
    expect(session.auth).toEqual({ status: 'login_required' });

    const error = await authFailure(session.request('turn/start'));
    expect(error.message).toMatch(/codex login/);
    expect(receivedMethods()).not.toContain('turn/start');
    expect(receivedMethods()).not.toContain('account/login/start');
  });

  it.each(['bedrock', 'futureMode'])('rejects the unsupported account kind %s', async (kind) => {
    const session = await connect(kind);
    expect(session.auth).toMatchObject({ status: 'rejected', reason: 'unsupported_mode' });
    await authFailure(session.request('turn/start'));
  });

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

describe('providers that cannot be verified', () => {
  it.each(['customProvider', 'customProviderChatgpt'])(
    'refuses %s by default, naming the provider and how to allow it',
    async (kind) => {
      const session = await connect(kind, {}, PROXY);
      const provider = HEADROOM;
      expect(session.auth).toMatchObject({
        status: 'rejected',
        reason: 'provider_not_verified',
        provider,
      });
      const error = await authFailure(session.request('turn/start'));
      expect(error.message).toMatch(/Headroom persistent proxy/);
      expect(error.message).toMatch(/allowUnverifiedProvider/);
      // A rejected state is read again before refusing the request.
      expect(receivedMethods().slice(-2)).toEqual(['account/read', 'config/read']);
      expect(receivedMethods()).not.toContain('turn/start');
    },
  );

  it('accepts it as unverified_provider when allowUnverifiedProvider is on', async () => {
    const session = await connect('customProvider', { allowUnverifiedProvider: true }, PROXY);
    expect(session.auth).toEqual({ status: 'unverified_provider', provider: HEADROOM });
    expect(await session.request('turn/start')).toEqual({ turn: { id: 'turn-1' } });
  });

  it('still decides when config/read fails, with an unknown provider', async () => {
    const session = await connect('customProvider', {}, ['--provider=readError']);
    expect(session.auth).toMatchObject({
      status: 'rejected',
      reason: 'provider_not_verified',
      provider: { id: 'unknown', name: null, baseUrl: null, unofficialBaseUrl: true },
    });
    expect(session.provider).toBeNull();
  });

  it('exposes the provider and its proxy base URL with OpenAI authentication too', async () => {
    const session = await connect('chatgpt', {}, PROXY);
    expect(session.auth).toMatchObject({ status: 'authorized' });
    expect(session.provider).toEqual(HEADROOM);
  });

  it('marks the built-in OpenAI provider as official', async () => {
    const session = await connect('chatgpt');
    expect(session.provider).toEqual({
      id: 'openai',
      name: null,
      baseUrl: null,
      unofficialBaseUrl: false,
    });
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
    const before = receivedMethods().filter((method) => method === 'account/read').length;
    await session.request('turn/start');
    expect(receivedMethods().filter((method) => method === 'account/read')).toHaveLength(
      before + 1,
    );
  });

  it('does not keep an authorization that was read while the account was changing', async () => {
    const session = await connect('updateDuringRead');
    const error = await authFailure(session.request('turn/start'));
    expect(error.state).toMatchObject({ status: 'rejected', reason: 'api_key' });
    expect(receivedMethods()).not.toContain('turn/start');
  });
});

describe('launch in the user profile', () => {
  const userEnv = {
    OPENAI_API_KEY: 'sk-should-not-leak',
    codex_api_key: 'sk-should-not-leak',
    CODEX_ACCESS_TOKEN: 'token-should-not-leak',
    ANTHROPIC_API_KEY: 'should-not-leak',
    ANTHROPIC_AUTH_TOKEN: 'should-not-leak',
    GEMINI_API_KEY: 'should-not-leak',
    GOOGLE_API_KEY: 'should-not-leak',
    // The user's own setup, which must keep working:
    OPENAI_BASE_URL: 'http://127.0.0.1:8787/v1',
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:8787',
    HTTPS_PROXY: 'http://127.0.0.1:3128',
    CODEX_HOME: 'C:\\profiles\\codex',
    RTK_ENABLED: '1',
  };

  it('passes the user environment minus the API key variables, whatever their case', async () => {
    const session = await connect('chatgpt', { baseEnv: { ...process.env, ...userEnv } });
    const env = (await session.request('test/env')) as Record<string, string>;

    const names = Object.keys(env).map((key) => key.toUpperCase());
    for (const name of API_KEY_VARIABLES) expect(names).not.toContain(name);
    expect(JSON.stringify(env)).not.toContain('should-not-leak');
    for (const name of [
      'OPENAI_BASE_URL',
      'ANTHROPIC_BASE_URL',
      'HTTPS_PROXY',
      'CODEX_HOME',
      'RTK_ENABLED',
    ] as const) {
      expect(env[name]).toBe(userEnv[name]);
    }
  });

  it('launches plain app-server: no override of provider, base URL or login method', async () => {
    const session = await connect('chatgpt');
    const argv = (await session.request('test/argv')) as string[];
    expect(argv.slice(argv.indexOf('--log=' + log) + 1)).toEqual(['app-server']);
    expect(argv).not.toContain('-c');
  });

  it('adds the isolated-profile overrides only when asked, before app-server', async () => {
    const session = await connect('chatgpt', { configOverrides: ISOLATED_PROFILE_OVERRIDES });
    const argv = (await session.request('test/argv')) as string[];
    for (const override of ISOLATED_PROFILE_OVERRIDES) {
      const at = argv.indexOf(override);
      expect(at).toBeGreaterThan(0);
      expect(argv[at - 1]).toBe('-c');
      expect(at).toBeLessThan(argv.indexOf('app-server'));
    }
  });
});

describe('methods never sent', () => {
  it('never declares the experimentalApi capability that remote control needs', async () => {
    await expect(connect('chatgpt', { capabilities: { experimentalApi: true } })).rejects.toThrow(
      /experimentalApi/,
    );
    const session = await connect('chatgpt');
    const received = (await session.request('test/received')) as { params?: unknown }[];
    expect(JSON.stringify(received[0]?.params)).not.toContain('experimentalApi');
  });

  it.each([
    ['remoteControl/enable', /remote control/],
    ['remoteControl/status/read', /remote control/],
    ['remoteControl/pairing/start', /remote control/],
    ['account/rateLimitResetCredit/consume', /credit/],
    ['account/sendAddCreditsNudgeEmail', /e-mail/],
    ['feedback/upload', /feedback/],
    ['plugin/share/save', /publishes/],
    ['plugin/share/updateTargets', /shared/],
    ['account/login/start', /Codex CLI/],
    ['account/login/cancel', /Codex CLI/],
    ['account/logout', /sign/],
  ])('refuses %s without sending it, even when authorized', async (method, reason) => {
    const session = await connect('chatgpt');
    await expect(session.request(method, {})).rejects.toThrow(reason);
    expect(receivedMethods()).not.toContain(method);
  });
});
