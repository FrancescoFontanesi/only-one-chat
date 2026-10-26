// Behaviour of the Codex App Server client against an independent fake server
// running as a real child process (test/fixtures/fake-app-server.mjs).

import { copyFileSync, linkSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AppServerError,
  startAppServer,
  type AppServerClient,
  type AppServerOptions,
  type ForcedShutdownReport,
} from '../src/index.js';
import { selectOrphans } from '../src/process-tree.js';
import { testEnv } from './env.js';

const FAKE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-app-server.mjs');

const started: AppServerClient[] = [];
/** Grandchildren to kill if a test fails before close() deals with them. */
const strays: number[] = [];
afterEach(async () => {
  await Promise.all(started.splice(0).map((client) => client.close()));
  for (const pid of strays.splice(0)) {
    try {
      process.kill(pid);
    } catch {
      // already gone, as expected
    }
  }
});

async function start(
  overrides: Partial<AppServerOptions> = {},
  flags: string[] = [],
): Promise<AppServerClient> {
  const client = await startAppServer({
    executable: process.execPath,
    env: testEnv(),
    args: [FAKE, 'app-server', ...flags],
    clientInfo: { name: 'only-one-chat-tests', version: '0.0.0' },
    requestTimeoutMs: 5_000,
    ...overrides,
  });
  started.push(client);
  return client;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function rejection(promise: Promise<unknown>): Promise<AppServerError> {
  const error: unknown = await promise.then(
    () => {
      throw new Error('expected the promise to reject');
    },
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(AppServerError);
  return error as AppServerError;
}

describe('handshake', () => {
  it('sends initialize, then the initialized notification, without a jsonrpc field', async () => {
    const client = await start();

    expect(client.initializeResponse).toMatchObject({
      userAgent: expect.stringMatching(/^only-one-chat-tests\/0\.0\.0-fake /) as string,
      codexHome: '/fake/codex-home',
    });
    const received = await client.request('test/received');
    expect(received).toEqual([
      {
        id: expect.any(Number) as number,
        method: 'initialize',
        params: { clientInfo: { name: 'only-one-chat-tests', version: '0.0.0' } },
      },
      { method: 'initialized' },
      { id: expect.any(Number) as number, method: 'test/received' },
    ]);
  });

  it('rejects and stops the process when initialize fails', async () => {
    const exits: unknown[] = [];
    const error = await rejection(
      start({ onExit: (info) => exits.push(info) }, ['--fail-initialize']),
    );
    expect(error.kind).toBe('rpc');
    expect(error.code).toBe(-32603);
    expect(exits).toHaveLength(1);
  });

  it('reports a process that exits before the handshake, with its stderr', async () => {
    const error = await rejection(start({}, ['--exit-at-start']));
    expect(error.kind).toBe('exited');
    expect(error.message).toContain('fatal: fake startup failure');
  });

  it('reports a missing executable as a spawn error', async () => {
    const error = await rejection(start({ executable: join(tmpdir(), 'no-such-codex.exe') }));
    expect(error.kind).toBe('spawn');
  });
});

describe('framing', () => {
  it('reassembles a message split across many chunks, including split UTF-8 sequences', async () => {
    const client = await start();
    const value = 'Ã Ã¨Ã¬Ã²Ã¹ â‚¬ ðŸ˜€ â€” split across chunks';
    expect(await client.request('test/chunked', { value })).toEqual({ value });
  });

  it('handles several messages delivered in one chunk, in order', async () => {
    const ticks: unknown[] = [];
    const client = await start({
      onNotification: (method, params) => {
        if (method === 'test/tick') ticks.push(params);
      },
    });
    expect(await client.request('test/batch', { count: 3 })).toBe('batched');
    expect(ticks).toEqual([{ i: 0 }, { i: 1 }, { i: 2 }]);
  });

  it('skips malformed lines, reports them, and keeps serving requests', async () => {
    const problems: string[] = [];
    const client = await start({ onProtocolError: (error) => problems.push(error.message) });
    expect(await client.request('test/malformed')).toBe('after-garbage');
    expect(problems).toHaveLength(4);
  });

  it('reports every JSON object on the wire, in order, to onWire', async () => {
    const wire: string[] = [];
    const client = await start({
      onWire: (direction, message) => {
        // Unsolicited, so its position relative to the client's messages varies.
        if (message['method'] === 'remoteControl/status/changed') return;
        const method = message['method'];
        const label =
          typeof method === 'string' || typeof method === 'number'
            ? String(method)
            : `response ${JSON.stringify(message['id'])}`;
        wire.push(`${direction} ${label}`);
      },
    });
    await client.request('test/malformed');
    expect(wire).toEqual([
      'client initialize',
      'server response 0',
      'client initialized',
      'client test/malformed',
      // invalid JSON and non-objects are not reported; objects with a bad shape are
      'server 5',
      'server response undefined',
      'server response 1',
    ]);
  });

  it('drains stderr so a chatty server cannot block on a full pipe', async () => {
    const client = await start();
    expect(await client.request('test/stderrFlood', { bytes: 1024 * 1024 })).toBe('flooded');
  });
});

describe('request correlation', () => {
  it('matches concurrent responses that arrive out of order', async () => {
    const client = await start();
    const results = await Promise.all([
      client.request('test/echo', { value: 'slow', delayMs: 80 }),
      client.request('test/echo', { value: 'fast', delayMs: 0 }),
      client.request('test/echo', { value: 'medium', delayMs: 40 }),
    ]);
    expect(results).toEqual([{ value: 'slow' }, { value: 'fast' }, { value: 'medium' }]);
  });

  it('reports responses with unknown ids without resolving anything else', async () => {
    const problems: string[] = [];
    const client = await start({ onProtocolError: (error) => problems.push(error.message) });
    expect(await client.request('test/unknownId')).toBe('ok');
    expect(problems).toHaveLength(2);
  });

  it('rejects with the JSON-RPC error returned by the server', async () => {
    const client = await start();
    const error = await rejection(client.request('test/error'));
    expect(error).toMatchObject({ kind: 'rpc', code: -32602, data: { field: 'x' } });
    expect(error.message).toContain('bad params');
  });

  it('rejects a response that has neither result nor error instead of waiting for it', async () => {
    const client = await start({ requestTimeoutMs: 60_000 });
    const error = await rejection(client.request('test/invalidResponse'));
    expect(error.kind).toBe('protocol');
  });
});

describe('server requests', () => {
  it('answers with the registered handler result', async () => {
    const client = await start({
      onServerRequest: (method, params) => Promise.resolve({ handled: method, params }),
    });
    const reply = await client.request('test/serverRequest', {
      method: 'item/permissions/requestApproval',
      params: { reason: 'test' },
    });
    expect(reply).toEqual({
      id: 1000,
      result: { handled: 'item/permissions/requestApproval', params: { reason: 'test' } },
    });
  });

  it('answers method-not-found when no handler is registered, so the server never waits', async () => {
    const client = await start();
    const reply = await client.request('test/serverRequest', { method: 'anything/at-all' });
    expect(reply).toMatchObject({ id: 1000, error: { code: -32601 } });
  });

  it('turns a failing handler into an error reply', async () => {
    const client = await start({
      onServerRequest: () => Promise.reject(new Error('handler exploded')),
    });
    const reply = await client.request('test/serverRequest', { method: 'x' });
    expect(reply).toMatchObject({ id: 1000, error: { code: -32603, message: 'handler exploded' } });
  });
});

describe('timeouts and cancellation', () => {
  it('rejects a request that gets no answer in time and stays usable', async () => {
    const client = await start();
    const error = await rejection(client.request('test/never', undefined, { timeoutMs: 50 }));
    expect(error.kind).toBe('timeout');
    expect(await client.request('test/echo', { value: 1 })).toEqual({ value: 1 });
  });

  it('rejects when the caller aborts', async () => {
    const client = await start();
    const controller = new AbortController();
    const pending = client.request('test/never', undefined, { signal: controller.signal });
    controller.abort();
    expect((await rejection(pending)).kind).toBe('cancelled');
  });

  it('does not send a request whose signal is already aborted', async () => {
    const client = await start();
    const error = await rejection(
      client.request('test/echo', { value: 'x' }, { signal: AbortSignal.abort() }),
    );
    expect(error.kind).toBe('cancelled');
    const received = (await client.request('test/received')) as { method?: string }[];
    expect(received.map((message) => message.method)).not.toContain('test/echo');
  });
});

describe('process termination', () => {
  it('rejects every pending request when the process exits, and refuses new ones', async () => {
    const exits: unknown[] = [];
    const client = await start({ onExit: (info) => exits.push(info) });
    const pending = [client.request('test/never'), client.request('test/never')];
    void client.request('test/exit', { code: 7 }).catch(() => undefined);

    for (const error of await Promise.all(pending.map(rejection))) {
      expect(error.kind).toBe('exited');
    }
    expect(exits).toEqual([{ code: 7, signal: null }]);
    expect((await rejection(client.request('test/echo', { value: 1 }))).kind).toBe('exited');
  });

  it('still delivers output that reaches stdout after the exit is observed', async () => {
    const client = await start();
    expect(await client.request('test/respondAfterExit')).toBe('last words');
  });
});

describe('close', () => {
  it('rejects pending requests, stops the process and is idempotent', async () => {
    const client = await start();
    const pending = rejection(client.request('test/never'));
    await Promise.all([client.close(), client.close()]);

    expect((await pending).kind).toBe('closed');
    expect(isAlive(client.pid)).toBe(false);
    expect((await rejection(client.request('test/echo'))).kind).toBe('closed');
  });

  it('kills a server that ignores end-of-input once the shutdown timeout expires', async () => {
    const reports: ForcedShutdownReport[] = [];
    const client = await start(
      { shutdownTimeoutMs: 200, onForcedShutdown: (report) => reports.push(report) },
      ['--ignore-eof'],
    );
    await client.close();
    expect(isAlive(client.pid)).toBe(false);
    expect(reports).toEqual([{ reason: 'exit-timeout', terminated: [client.pid], errors: [] }]);
  });

  it('kills the whole tree of a server that ignores end-of-input', async () => {
    const reports: ForcedShutdownReport[] = [];
    const client = await start(
      { shutdownTimeoutMs: 300, onForcedShutdown: (report) => reports.push(report) },
      ['--ignore-eof'],
    );
    const { pid: grandchild } = (await client.request('test/spawnGrandchild')) as { pid: number };
    strays.push(grandchild);
    expect(isAlive(grandchild)).toBe(true);

    await client.close();
    expect(isAlive(client.pid)).toBe(false);
    expect(isAlive(grandchild)).toBe(false);
    expect(reports.map((report) => report.reason)).toEqual(['exit-timeout']);
  });

  it('terminates processes that keep the pipes open after a clean exit, and reports it', async () => {
    const reports: ForcedShutdownReport[] = [];
    const client = await start({
      shutdownTimeoutMs: 300,
      onForcedShutdown: (report) => reports.push(report),
    });
    const { pid: grandchild } = (await client.request('test/spawnGrandchild')) as { pid: number };
    strays.push(grandchild);

    await client.close(); // the server exits at once; the grandchild holds stdout and stderr
    expect(isAlive(client.pid)).toBe(false);
    expect(isAlive(grandchild)).toBe(false);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ reason: 'stdio-open', errors: [] });
    // Windows names each orphan it terminated; POSIX signals the process group as a whole.
    if (process.platform === 'win32') expect(reports[0]?.terminated).toContain(grandchild);
    else expect(reports[0]?.terminated).toEqual([]);
  });

  it('closes a server that already exited without errors or any termination', async () => {
    const reports: ForcedShutdownReport[] = [];
    let exited!: () => void;
    const exit = new Promise<void>((resolve) => (exited = resolve));
    const client = await start({
      onExit: () => {
        exited();
      },
      onForcedShutdown: (report) => reports.push(report),
    });
    void client.request('test/exit', { code: 0 }).catch(() => undefined);
    await exit;

    await client.close();
    await client.close();
    expect(reports).toEqual([]);
  });
});

describe('orphan selection', () => {
  const rows = [
    { pid: 10, createdAtMs: 999 }, // older than the server: not its child
    { pid: 11, createdAtMs: 1_000 },
    { pid: 12, createdAtMs: 1_500 },
    { pid: 13, createdAtMs: 2_000 },
    { pid: 14, createdAtMs: 2_001 }, // created after the exit: child of a reused PID
  ];

  it('keeps only processes created between the server start and its exit', () => {
    expect(selectOrphans(rows, 1_000, 2_000)).toEqual([11, 12, 13]);
  });

  it('selects nothing when every candidate is foreign', () => {
    expect(selectOrphans(rows, 3_000, 4_000)).toEqual([]);
  });
});

describe('paths with spaces', () => {
  it('starts an executable and script whose paths and cwd contain spaces', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex path with spaces '));
    try {
      const executable = join(dir, `node runtime${process.platform === 'win32' ? '.exe' : ''}`);
      try {
        linkSync(process.execPath, executable);
      } catch {
        copyFileSync(process.execPath, executable);
      }
      const script = join(dir, 'fake app server.mjs');
      copyFileSync(FAKE, script);

      const client = await start({ executable, args: [script, 'app-server'], cwd: dir });
      expect(client.initializeResponse.userAgent).toContain('only-one-chat-tests');
      await client.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
