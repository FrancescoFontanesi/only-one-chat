// Records real `codex app-server` traffic as JSONL fixtures for the contract
// tests. Dev tooling, never bundled in the extension (the VSIX ships dist/ only).
//
// It speaks the wire format itself instead of going through the client under
// test, so a client bug cannot shape the recording. The launch (arguments and
// allow-listed environment) comes from `prepareCodexLaunch`, the same function
// `connectCodex` uses. Everything is redacted in memory before it is written.
//
// Only interactions that use no model quota are scripted: initialize,
// account/read, starting and cancelling a login, a completed login done by a
// person, and account/rateLimits/read (two GETs, see docs/codex-app-server.md).
//
// Usage (PowerShell):
//   $env:CODEX_EXECUTABLE = 'F:\...\codex.exe'
//   $env:CODEX_RECORD_SCENARIO = 'startup' | 'login-cancel' | 'login-complete'
//   $env:CODEX_RECORD_HOME = 'F:\...\profile'   # required for login-complete only
//   pnpm record:codex
// Runs under Vitest only to execute TypeScript without new dependencies.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, hostname, tmpdir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'vitest';
import { resolveCodexExecutable } from '../src/codex/executable.js';
import { prepareCodexLaunch } from '../src/codex/session.js';
import { findLeaks, redactTranscript, type RedactionLiterals } from './redact.js';

type Json = Record<string, unknown>;

type Entry =
  | {
      readonly type: 'message';
      readonly dir: 'client' | 'server';
      readonly atMs: number;
      readonly message: unknown;
    }
  | { readonly type: 'stderr'; readonly atMs: number; readonly text: string }
  | {
      readonly type: 'exit';
      readonly atMs: number;
      readonly code: number | null;
      readonly signal: string | null;
      readonly stdioClosedAtMs: number | null;
    };

const SCENARIOS = ['startup', 'login-cancel', 'login-complete'] as const;
type Scenario = (typeof SCENARIOS)[number];

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures', 'codex');
const CLIENT_INFO = {
  name: 'only-one-chat-recorder',
  title: 'Only One Chat recorder',
  version: '0.0.0',
};

class WireRecorder {
  readonly entries: Entry[] = [];
  private readonly started = Date.now();
  private readonly waiting = new Map<number | string, (message: Json) => void>();
  private readonly notifications: Json[] = [];
  private readonly notificationWaiters = new Set<() => void>();
  private nextId = 0;
  private exited: Promise<{ code: number | null; signal: string | null; atMs: number }>;
  private closed: Promise<number>;

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    child.stderr.setEncoding('utf8');
    createInterface({ input: child.stderr, crlfDelay: Infinity }).on('line', (text) => {
      this.entries.push({ type: 'stderr', atMs: this.now(), text });
    });
    createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', (line) => {
      let message: unknown = line;
      try {
        message = JSON.parse(line);
      } catch {
        // kept verbatim: an invalid line is a finding in itself
      }
      this.entries.push({ type: 'message', dir: 'server', atMs: this.now(), message });
      if (typeof message !== 'object' || message === null) return;
      const json = message as Json;
      const id = json['id'];
      if (typeof json['method'] === 'string') {
        // Server requests are not expected in these scenarios; refuse them visibly.
        if (typeof id === 'number' || typeof id === 'string') {
          this.send({
            id,
            error: { code: -32601, message: 'recorder does not answer server requests' },
          });
        } else {
          this.notifications.push(json);
          for (const wake of this.notificationWaiters) wake();
        }
      } else if ((typeof id === 'number' || typeof id === 'string') && this.waiting.has(id)) {
        this.waiting.get(id)?.(json);
        this.waiting.delete(id);
      }
    });
    this.exited = new Promise((resolve) =>
      child.once('exit', (code, signal) => {
        resolve({ code, signal, atMs: this.now() });
      }),
    );
    this.closed = new Promise((resolve) =>
      child.once('close', () => {
        resolve(this.now());
      }),
    );
  }

  now(): number {
    return Date.now() - this.started;
  }

  send(message: Json): void {
    this.entries.push({ type: 'message', dir: 'client', atMs: this.now(), message });
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  /** Sends a request and resolves with the whole response message. */
  request(method: string, params?: unknown, timeoutMs = 30_000): Promise<Json> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new Error(`${method} got no response in ${String(timeoutMs)} ms`));
      }, timeoutMs);
      this.waiting.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      this.send(params === undefined ? { id, method } : { id, method, params });
    });
  }

  /** Resolves with the first notification `method` received so far or later, or undefined. */
  async waitForNotification(method: string, timeoutMs: number): Promise<Json | undefined> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.notifications.find((message) => message['method'] === method);
      if (found) return found;
      const left = deadline - Date.now();
      if (left <= 0) return undefined;
      await new Promise<void>((resolve) => {
        const wake = () => {
          clearTimeout(timer);
          this.notificationWaiters.delete(wake);
          resolve();
        };
        const timer = setTimeout(wake, left);
        this.notificationWaiters.add(wake);
      });
    }
  }

  async idle(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  /** Ends stdin and records how the process and its stdio ended. */
  async finish(timeoutMs = 20_000): Promise<void> {
    this.child.stdin.end();
    const timeout = new Promise<'timeout'>((resolve) =>
      setTimeout(() => {
        resolve('timeout');
      }, timeoutMs),
    );
    const exit = await Promise.race([this.exited, timeout]);
    if (exit === 'timeout') {
      this.child.kill();
      throw new Error(`codex app-server did not exit within ${String(timeoutMs)} ms of EOF`);
    }
    const closedAt = await Promise.race([this.closed, timeout]);
    this.entries.push({
      type: 'exit',
      atMs: exit.atMs,
      code: exit.code,
      signal: exit.signal,
      stdioClosedAtMs: closedAt === 'timeout' ? null : closedAt,
    });
  }
}

function result(message: Json): Json {
  const value = message['result'];
  if (typeof value !== 'object' || value === null) {
    throw new Error(`Expected a result, got ${JSON.stringify(message).slice(0, 300)}`);
  }
  return value as Json;
}

async function handshake(wire: WireRecorder): Promise<Json> {
  const init = result(await wire.request('initialize', { clientInfo: CLIENT_INFO }));
  wire.send({ method: 'initialized' });
  return init;
}

const scenarios: Record<Scenario, (wire: WireRecorder) => Promise<Json>> = {
  /** Fresh profile: errors around the handshake, account state, no-auth rate limits. */
  async startup(wire) {
    await wire.request('account/read', {}); // before initialize: "Not initialized"
    const init = await handshake(wire);
    await wire.request('initialize', { clientInfo: CLIENT_INFO }); // "Already initialized"
    await wire.request('account/read', {});
    await wire.request('only-one-chat/unknownMethod', {});
    // Without a login Codex answers before any network call (account_processor.rs:1154).
    await wire.request('account/rateLimits/read', {});
    await wire.idle(1_500); // let unsolicited startup notifications arrive
    return init;
  },

  /** Starts both official login flows and cancels them; no account is created. */
  async ['login-cancel'](wire) {
    const init = await handshake(wire);
    await wire.request('account/read', {});
    for (const type of ['chatgptDeviceCode', 'chatgpt']) {
      const start = result(await wire.request('account/login/start', { type }));
      await wire.request('account/login/cancel', { loginId: start['loginId'] });
      await wire.waitForNotification('account/login/completed', 5_000);
      await wire.idle(500);
    }
    await wire.request('account/login/cancel', { loginId: 'only-one-chat-unknown-login' });
    return init;
  },

  /** A person completes a device-code login; then account and rate limits are read. */
  async ['login-complete'](wire) {
    const init = await handshake(wire);
    await wire.request('account/read', {});
    const start = result(await wire.request('account/login/start', { type: 'chatgptDeviceCode' }));
    // Shown on the terminal only; the transcript keeps placeholders.
    console.log(
      `\n  Open ${String(start['verificationUrl'])}\n  and enter the code ${String(start['userCode'])}\n`,
    );
    const done = await wire.waitForNotification('account/login/completed', 15 * 60_000);
    if (!done) throw new Error('No account/login/completed within 15 minutes');
    await wire.idle(1_000); // account/updated usually follows
    await wire.request('account/read', {});
    await wire.request('account/rateLimits/read', {});
    await wire.idle(1_500);
    return init;
  },
};

function localLiterals(codexHome: string): RedactionLiterals {
  const literals = new Map<string, string>();
  const addPath = (path: string, placeholder: string) => {
    for (const form of [path, path.replaceAll('\\', '/')]) literals.set(form, placeholder);
  };
  addPath(codexHome, '<CODEX_HOME>');
  try {
    addPath(realpathSync.native(codexHome), '<CODEX_HOME>');
  } catch {
    // the profile may be gone already
  }
  addPath(tmpdir(), '<TMP>');
  addPath(homedir(), '<HOME>');
  literals.set(userInfo().username, '<user>');
  literals.set(hostname(), '<host>');
  return [...literals];
}

const scenario = process.env['CODEX_RECORD_SCENARIO'] as Scenario | undefined;
const configuredPath = process.env['CODEX_EXECUTABLE'];

describe.runIf(configuredPath && scenario)('record codex app-server transcript', () => {
  it(
    `records ${String(scenario)}`,
    async () => {
      if (!scenario || !SCENARIOS.includes(scenario)) {
        throw new Error(`CODEX_RECORD_SCENARIO must be one of ${SCENARIOS.join(', ')}`);
      }
      const persistentHome = process.env['CODEX_RECORD_HOME'];
      if (scenario === 'login-complete' && !persistentHome) {
        throw new Error('login-complete needs CODEX_RECORD_HOME (a dedicated test profile)');
      }
      const codexHome = persistentHome ?? mkdtempSync(join(tmpdir(), 'codex record '));
      try {
        const executable = await resolveCodexExecutable({ configuredPath: configuredPath ?? '' });
        const launch = await prepareCodexLaunch(codexHome);
        const literals = localLiterals(codexHome); // after the profile exists, for its real path
        const child = spawn(executable, launch.args, {
          env: launch.env,
          stdio: 'pipe',
          windowsHide: true,
        });
        const wire = new WireRecorder(child);
        const init = await scenarios[scenario](wire);
        await wire.finish();

        const userAgent = String(init['userAgent']);
        const version = /\/(\d+\.\d+\.\d+[\w.-]*)/.exec(userAgent)?.[1] ?? 'unknown';
        const meta = {
          type: 'meta',
          scenario,
          codexVersion: version,
          userAgent,
          recordedAt: new Date().toISOString(),
          platform: `${process.platform}-${process.arch}`,
          commands: {
            recorder: `CODEX_RECORD_SCENARIO=${scenario} pnpm record:codex`,
            codex: ['<CODEX_EXECUTABLE>', ...launch.args],
            profile: persistentHome
              ? 'dedicated test profile (CODEX_RECORD_HOME)'
              : 'fresh temporary CODEX_HOME',
          },
        };
        const text = `${redactTranscript([meta, ...wire.entries], literals)
          .map((entry) => JSON.stringify(entry))
          .join('\n')}\n`;
        // Second, independent check: nothing is written if the scanner still finds something.
        const leaks = findLeaks(text, [userInfo().username, hostname()]);
        if (leaks.length > 0) {
          throw new Error(
            `Transcript not written, possible leaks: ${leaks.map((leak) => leak.kind).join(', ')}`,
          );
        }
        const out = join(FIXTURES, version, `${scenario}.jsonl`);
        mkdirSync(dirname(out), { recursive: true });
        writeFileSync(out, text);
        console.log(`wrote ${out}`);
      } finally {
        if (!persistentHome) rmSync(codexHome, { recursive: true, force: true, maxRetries: 10 });
      }
    },
    20 * 60_000,
  );
});
