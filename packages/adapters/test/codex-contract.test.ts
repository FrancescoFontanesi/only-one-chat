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
import { interpretAccountRead, parseLoginStart, type CodexLoginMethod } from '../src/codex/auth.js';

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

const startup = load('startup');
const loginCancel = load('login-cancel');

describe(`recorded Codex ${RECORDED_VERSION}: what the client accepts`, () => {
  const all = [startup, loginCancel].filter((t): t is Entry[] => t !== undefined);

  it('has the transcripts to check', () => {
    expect(startup).toBeDefined();
    expect(loginCancel).toBeDefined();
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
    const reads = all
      .flatMap(exchanges)
      .filter((e) => e.request['method'] === 'account/read' && 'result' in e.response);
    expect(reads.length).toBeGreaterThan(0);
    for (const { response } of reads) {
      expect(interpretAccountRead(response['result'])).toEqual({ status: 'login_required' });
    }
  });

  it('starts both official logins with results parseLoginStart accepts', () => {
    const starts = exchanges(loginCancel ?? []).filter(
      (e) => e.request['method'] === 'account/login/start',
    );
    expect(starts.map((e) => (e.request['params'] as Json)['type']).sort()).toEqual([
      'chatgpt',
      'chatgptDeviceCode',
    ]);
    for (const { request, response } of starts) {
      const method = (request['params'] as Json)['type'] as CodexLoginMethod;
      expect(parseLoginStart(method, response['result']).type).toBe(method);
    }
  });
});

// ---------------------------------------------------------------------------
// Fake parity

const children: ChildProcessWithoutNullStreams[] = [];
afterEach(() => {
  for (const child of children.splice(0)) child.kill();
});

/** Replays the recorded client messages against the fake and returns its answers in order. */
async function replayOnFake(entries: Entry[], account: string): Promise<Json[]> {
  const child = spawn(process.execPath, [FAKE, 'app-server', `--account=${account}`]);
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
const EXACT = new Set(['id', 'method', 'type', 'status', 'success', 'requiresOpenaiAuth', 'code']);

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

describe.each([
  ['startup', startup, 'none'],
  ['login-cancel', loginCancel, 'none'],
] as const)('fake app-server matches the recorded %s', (_name, entries, account) => {
  it.runIf(entries !== undefined)('with the same messages, in the same order', async () => {
    const recorded = messages(entries ?? [], 'server').map((m) => shape(m));
    const fake = (await replayOnFake(entries ?? [], account)).map((m) => shape(m));
    expect(fake).toEqual(recorded);
  });
});
