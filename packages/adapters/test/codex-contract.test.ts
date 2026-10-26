// Contract tests on transcripts recorded from the real Codex CLI
// (test/fixtures/codex/<version>/, written by dev/record-codex.ts).
//
// 1. The client's parsers and wire checks accept what Codex really sends.
// 2. The fake server answers the recorded client messages with the same
//    shapes, error codes and message order as the real one, so the client
//    tests that run against the fake describe real behaviour. When they
//    differ, the fake is what gets fixed.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { afterEach, describe, expect, it } from 'vitest';
import { projectCodexConfig } from '../dev/redact.js';
import { interpretAccountRead, providerFromConfig } from '../src/codex/auth.js';
import { testEnv } from './env.js';

type Json = Record<string, unknown>;
type Entry =
  | { type: 'meta'; scenario: string; codexVersion: string }
  | { type: 'message'; dir: 'client' | 'server'; message: Json }
  | { type: 'stderr'; text: string }
  | { type: 'exit'; code: number | null };

const FIXTURES = join(import.meta.dirname, 'fixtures', 'codex');
const FAKE = join(import.meta.dirname, 'fixtures', 'fake-app-server.mjs');

function compareVersions(a: string, b: string): number {
  const [x, y] = [a, b].map((v) => v.split(/[.-]/).map((part) => Number(part) || 0));
  for (let i = 0; i < Math.max(x?.length ?? 0, y?.length ?? 0); i++) {
    const diff = (x?.[i] ?? 0) - (y?.[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** The newest recorded Codex version: the fake has to match that one. */
const RECORDED_VERSION = readdirSync(FIXTURES).sort(compareVersions).at(-1) ?? 'none';

function load(scenario: string): Entry[] | undefined {
  const path = join(FIXTURES, RECORDED_VERSION, `${scenario}.jsonl`);
  if (!existsSync(path)) return undefined;
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Entry);
}

function messages(entries: Entry[], dir: 'client' | 'server'): Json[] {
  return entries.flatMap((entry) =>
    entry.type === 'message' && entry.dir === dir ? [entry.message] : [],
  );
}

/** Pairs each recorded client request with the server's response. */
function exchanges(entries: Entry[]): { request: Json; response: Json }[] {
  const responses = messages(entries, 'server').filter((m) => m['method'] === undefined);
  return messages(entries, 'client')
    .filter((m) => m['id'] !== undefined)
    .map((request) => {
      const response = responses.find((m) => m['id'] === request['id']);
      if (!response) throw new Error(`No recorded response to ${JSON.stringify(request)}`);
      return { request, response };
    });
}

/** Result of the first successful exchange of `method` in a transcript. */
function result(entries: Entry[] | undefined, method: string): unknown {
  return exchanges(entries ?? []).find(
    (e) => e.request['method'] === method && 'result' in e.response,
  )?.response['result'];
}

const startup = load('startup');
const customProvider = load('custom-provider');
const personalStartup = load('personal-startup');
const questionTurn = load('question-turn');
const subagentTurn = load('subagent-turn');

describe(`recorded Codex ${RECORDED_VERSION}: what the client accepts`, () => {
  const all = [startup, customProvider, personalStartup, questionTurn].filter(
    (t): t is Entry[] => t !== undefined,
  );

  it('has the transcripts to check', () => {
    expect(startup).toBeDefined();
    expect(customProvider).toBeDefined();
    expect(personalStartup).toBeDefined();
    expect(questionTurn).toBeDefined();
  });

  it('answers every request with a result or a well-formed error, never both', () => {
    for (const { response } of all.flatMap(exchanges)) {
      const error = response['error'] as Json | undefined;
      if (error === undefined) expect(response).toHaveProperty('result');
      else {
        expect(response).not.toHaveProperty('result');
        expect(typeof error['code']).toBe('number');
        expect(typeof error['message']).toBe('string');
      }
    }
  });

  it('sends notifications with params and emittedAtMs beside them, and no id', () => {
    const notifications = all
      .flatMap((t) => messages(t, 'server'))
      .filter((m) => m['method'] !== undefined);
    expect(notifications.length).toBeGreaterThan(0);
    for (const notification of notifications) {
      expect(notification).not.toHaveProperty('id');
      expect(typeof notification['params']).toBe('object');
      expect(typeof notification['emittedAtMs']).toBe('number');
    }
  });

  it('never includes a "jsonrpc" field', () => {
    for (const message of all.flatMap((t) => messages(t, 'server'))) {
      expect(message).not.toHaveProperty('jsonrpc');
    }
  });

  it('answers initialize with the fields the client reads', () => {
    const init = exchanges(startup ?? []).find((e) => e.request['method'] === 'initialize');
    expect(init?.response['result']).toMatchObject({
      userAgent: expect.stringContaining(`/${RECORDED_VERSION} `) as string,
      codexHome: expect.any(String) as string,
      platformFamily: expect.any(String) as string,
      platformOs: expect.any(String) as string,
    });
  });

  it('reports a fresh profile as login_required, with nothing else needed', () => {
    expect(
      interpretAccountRead(result(startup, 'account/read'), { allowUnverifiedProvider: false }),
    ).toEqual({ status: 'login_required' });
  });

  it('reads the default provider from a profile without one configured', () => {
    expect(providerFromConfig(result(startup, 'config/read'))).toEqual({
      id: 'openai',
      name: null,
      baseUrl: null,
      unofficialBaseUrl: false,
    });
  });

  it('names a custom provider and refuses it unless allowed', () => {
    const provider = providerFromConfig(result(customProvider, 'config/read'));
    expect(provider).toEqual({
      id: 'recorder-proxy',
      name: 'Recorder proxy',
      baseUrl: 'http://127.0.0.1:9/v1',
      unofficialBaseUrl: true,
    });
    const read = result(customProvider, 'account/read');
    expect(interpretAccountRead(read, { allowUnverifiedProvider: false, provider })).toMatchObject({
      status: 'rejected',
      reason: 'provider_not_verified',
      provider,
    });
    expect(interpretAccountRead(read, { allowUnverifiedProvider: true, provider })).toEqual({
      status: 'unverified_provider',
      provider,
    });
  });
});

describe('recorded personal profile (signed in with ChatGPT, behind Headroom)', () => {
  const server = () => messages(personalStartup ?? [], 'server');

  it('announces the account while the first account/read is in flight', () => {
    const order = server().map((m) => m['method'] ?? `response ${String(m['id'])}`);
    const firstRead = (personalStartup ?? [])
      .filter((e) => e.type === 'message' && e.dir === 'client')
      .map((e) => (e as { message: Json }).message)
      .find((m) => m['method'] === 'account/read');
    expect(order.indexOf('account/updated')).toBeLessThan(
      order.indexOf(`response ${String(firstRead?.['id'])}`),
    );
    expect(order.filter((m) => m === 'account/updated')).toHaveLength(1);
    expect(server().find((m) => m['method'] === 'account/updated')?.['params']).toEqual({
      authMode: 'chatgpt',
      planType: 'plus',
    });
  });

  it('keeps remote control disabled', () => {
    expect(
      server().find((m) => m['method'] === 'remoteControl/status/changed')?.['params'],
    ).toMatchObject({ status: 'disabled', environmentId: null });
  });

  it('authorizes the subscription and shows the proxy base URL', () => {
    const provider = providerFromConfig(result(personalStartup, 'config/read'));
    expect(provider).toEqual({
      id: 'headroom',
      name: 'Headroom persistent proxy',
      baseUrl: 'http://127.0.0.1:8787/v1',
      unofficialBaseUrl: true,
    });
    expect(
      interpretAccountRead(result(personalStartup, 'account/read'), {
        allowUnverifiedProvider: false,
        provider,
      }),
    ).toEqual({ status: 'authorized', email: '<email-1>', planType: 'plus' });
  });
});

// ---------------------------------------------------------------------------
// Fake parity

const children: ChildProcessWithoutNullStreams[] = [];
afterEach(() => {
  for (const child of children.splice(0)) child.kill();
});

/** Replays the recorded client messages against the fake and returns its answers in order. */
async function replayOnFake(entries: Entry[], flags: readonly string[]): Promise<Json[]> {
  const child = spawn(process.execPath, [FAKE, 'app-server', ...flags], { env: testEnv() });
  children.push(child);
  const received: Json[] = [];
  const waiters = new Map<unknown, () => void>();
  createInterface({ input: child.stdout }).on('line', (line) => {
    const message = JSON.parse(line) as Json;
    received.push(message);
    if (message['method'] === undefined) waiters.get(message['id'])?.();
  });
  /** Placeholders of the recording mapped to the fake's own values (e.g. login ids). */
  const substitutions = new Map<string, string>();
  const recordedResponses = messages(entries, 'server');

  for (const sent of messages(entries, 'client')) {
    const outgoing = JSON.parse(
      JSON.stringify(sent, (_key, value: unknown) =>
        typeof value === 'string' ? (substitutions.get(value) ?? value) : value,
      ),
    ) as Json;
    const answered =
      outgoing['id'] === undefined
        ? Promise.resolve()
        : new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => {
              reject(new Error(`fake did not answer ${JSON.stringify(outgoing)}`));
            }, 5_000);
            waiters.set(outgoing['id'], () => {
              clearTimeout(timer);
              resolve();
            });
          });
    child.stdin.write(`${JSON.stringify(outgoing)}\n`);
    await answered;
    const recorded = recordedResponses.find(
      (m) => m['method'] === undefined && m['id'] === sent['id'],
    );
    const fake = received.find((m) => m['method'] === undefined && m['id'] === outgoing['id']);
    if (recorded && fake) collectSubstitutions(recorded, fake, substitutions);
  }
  await new Promise((resolve) => setTimeout(resolve, 300)); // trailing notifications
  return received.map((message) => restore(message, substitutions));
}

function collectSubstitutions(recorded: unknown, fake: unknown, out: Map<string, string>): void {
  if (typeof recorded === 'string' && /^<[\w-]+>$/.test(recorded) && typeof fake === 'string') {
    out.set(recorded, fake);
  } else if (
    typeof recorded === 'object' &&
    recorded !== null &&
    typeof fake === 'object' &&
    fake
  ) {
    for (const [key, value] of Object.entries(recorded)) {
      collectSubstitutions(value, (fake as Json)[key], out);
    }
  }
}

/** Puts the recording's placeholders back into the fake's messages, for comparison. */
function restore(message: Json, substitutions: Map<string, string>): Json {
  const back = new Map([...substitutions].map(([placeholder, value]) => [value, placeholder]));
  return JSON.parse(
    JSON.stringify(message, (_key, value: unknown) => {
      if (typeof value !== 'string') return value;
      let text = back.get(value) ?? value;
      for (const [fakeValue, placeholder] of back) text = text.replaceAll(fakeValue, placeholder);
      return text;
    }),
  ) as Json;
}

/** Values compared exactly; anything else only by type. */
const EXACT = new Set([
  'id',
  'method',
  'type',
  'status',
  'success',
  'requiresOpenaiAuth',
  'code',
  'authMode',
]);

function shape(value: unknown, key = ''): unknown {
  if (value === null) return null;
  if (Array.isArray(value)) return value.map((item) => shape(item));
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, shape(v, k)]),
    );
  }
  if (EXACT.has(key)) return value;
  // Error texts matter to people reading logs; the list of valid methods does not.
  if ((key === 'message' || key === 'error') && typeof value === 'string') {
    return value.split(', expected one of')[0];
  }
  return typeof value;
}

/**
 * config/read returns the whole effective configuration (over a hundred keys);
 * the client reads only the provider, so parity is checked on that projection.
 */
function project(message: Json): Json {
  return projectCodexConfig(message) as Json;
}

describe.each([
  ['startup', startup, ['--account=none']],
  [
    'custom-provider',
    customProvider,
    ['--account=customProvider', '--provider=recorder-proxy', '--provider-name=Recorder proxy'],
  ],
  [
    'personal-startup',
    personalStartup,
    ['--account=chatgpt', '--provider=headroom', '--provider-name=Headroom persistent proxy'],
  ],
] as const)('fake app-server matches the recorded %s', (_name, entries, flags) => {
  it.runIf(entries !== undefined)('with the same messages, in the same order', async () => {
    const recorded = messages(entries ?? [], 'server').map((m) => shape(project(m)));
    const fake = (await replayOnFake(entries ?? [], flags)).map((m) => shape(project(m)));
    expect(fake).toEqual(recorded);
  });
});

/**
 * A real turn (the Part A question, recorded by the demo with OOC_CODEX_TRACE)
 * has hooks, MCP startup and usage notifications the fake does not emit, so
 * parity is checked on the shape of what the client reads, not message by message.
 */
describe('fake app-server matches the recorded question-turn on what the client reads', () => {
  const firstParams = (
    list: Json[],
    method: string,
    pick: (params: Json) => boolean = () => true,
  ) =>
    list.find((m) => m['method'] === method && pick(m['params'] as Json))?.['params'] as
      Json | undefined;
  const isAgentMessage = (params: Json) => (params['item'] as Json)['type'] === 'agentMessage';
  const keys = (value: unknown) => Object.keys(value ?? {}).sort();

  it.runIf(questionTurn !== undefined)('with the same turn, item and response fields', async () => {
    const recorded = messages(questionTurn ?? [], 'server');
    const fake = await replayOnFake(questionTurn ?? [], [
      '--account=chatgpt',
      '--provider=headroom',
      '--provider-name=Headroom persistent proxy',
    ]);
    const threadStart = (list: Json[], entries: Entry[]) => {
      const id = messages(entries, 'client').find((m) => m['method'] === 'thread/start')?.['id'];
      return list.find((m) => m['method'] === undefined && m['id'] === id)?.['result'] as Json;
    };
    const recordedStart = threadStart(recorded, questionTurn ?? []);
    const fakeStart = threadStart(fake, questionTurn ?? []);
    expect(keys(fakeStart)).toEqual(keys(recordedStart));
    for (const method of ['turn/started', 'turn/completed']) {
      expect(keys(firstParams(fake, method))).toEqual(keys(firstParams(recorded, method)));
      expect(keys(firstParams(fake, method)?.['turn'])).toEqual(
        keys(firstParams(recorded, method)?.['turn']),
      );
    }
    const recordedMessage = firstParams(recorded, 'item/completed', isAgentMessage);
    const fakeMessage = firstParams(fake, 'item/completed', isAgentMessage);
    expect(keys(fakeMessage)).toEqual(keys(recordedMessage));
    expect(keys(fakeMessage?.['item'])).toEqual(keys(recordedMessage?.['item']));
    expect(keys(firstParams(fake, 'item/agentMessage/delta'))).toEqual(
      keys(firstParams(recorded, 'item/agentMessage/delta')),
    );
  });

  it.runIf(questionTurn !== undefined)(
    'switched the native sub-agents off per thread, and none started',
    () => {
      const start = messages(questionTurn ?? [], 'client').find(
        (m) => m['method'] === 'thread/start',
      );
      expect((start?.['params'] as Json)['config']).toEqual({
        'features.multi_agent': false,
        'features.multi_agent_v2': false,
      });
      const types = messages(questionTurn ?? [], 'server')
        .filter((m) => m['method'] === 'item/started')
        .map((m) => ((m['params'] as Json)['item'] as Json)['type']);
      expect(types).not.toContain('subAgentActivity');
      expect(types).not.toContain('collabAgentToolCall');
    },
  );
});

/** A real native sub-agent (dev/subagent-check.ts codex, policy gpt-6-luna/low). */
describe.runIf(subagentTurn !== undefined)('recorded sub-agent turn', () => {
  const server = () => messages(subagentTurn ?? [], 'server');
  const activity = (kind: string) =>
    server()
      .filter((m) => m['method'] === 'item/started')
      .map((m) => (m['params'] as Json)['item'] as Json)
      .find((item) => item['type'] === 'subAgentActivity' && item['kind'] === kind);

  it('announces the sub-agent with the model and effort the policy imposes', () => {
    expect(activity('started')).toMatchObject({
      model: 'gpt-6-luna',
      reasoningEffort: 'low',
      agentPath: '/root/env_read',
    });
    expect(activity('completed')).toMatchObject({ model: null, reasoningEffort: null });
  });

  it('runs the sub-agent on its own thread, announced on the same connection', () => {
    const child = activity('started')?.['agentThreadId'];
    const childTurns = server().filter(
      (m) => m['method'] === 'turn/started' && (m['params'] as Json)['threadId'] === child,
    );
    expect(childTurns).toHaveLength(1);
    const childCommands = server().filter(
      (m) =>
        m['method'] === 'item/started' &&
        (m['params'] as Json)['threadId'] === child &&
        ((m['params'] as Json)['item'] as Json)['type'] === 'commandExecution',
    );
    expect(childCommands.length).toBeGreaterThan(0);
  });

  it('passed the policy as per-thread overrides, and the thread effort stayed the profile’s', () => {
    const start = messages(subagentTurn ?? [], 'client').find(
      (m) => m['method'] === 'thread/start',
    );
    expect((start?.['params'] as Json)['config']).toMatchObject({
      'agents.default_subagent_model': 'gpt-6-luna',
      'agents.default_subagent_reasoning_effort': 'low',
      'features.multi_agent_v2.expose_spawn_agent_model_overrides': false,
    });
    expect(result(subagentTurn, 'thread/start')).toMatchObject({
      reasoningEffort: 'high',
      multiAgentMode: 'explicitRequestOnly',
    });
  });
});
