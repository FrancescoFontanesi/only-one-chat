// Client for `codex app-server` over stdio. Wire format and behaviour are
// described in docs/codex-app-server.md: one JSON object per line, JSON-RPC 2.0
// shapes without the "jsonrpc" field, `initialize` then `initialized`.
//
// Guarantees: every request settles (result, rpc error, timeout, cancellation,
// process exit or close); close() never leaves the child running.

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

export type AppServerErrorKind =
  'not-found' | 'spawn' | 'exited' | 'closed' | 'timeout' | 'cancelled' | 'rpc' | 'protocol';

export class AppServerError extends Error {
  override readonly name = 'AppServerError';

  constructor(
    readonly kind: AppServerErrorKind,
    message: string,
    /** JSON-RPC error code, for kind `rpc`. */
    readonly code?: number,
    /** JSON-RPC error data, for kind `rpc`. */
    readonly data?: unknown,
  ) {
    super(message);
  }
}

export interface ClientInfo {
  readonly name: string;
  readonly title?: string;
  readonly version: string;
}

export interface InitializeResponse {
  readonly userAgent: string;
  readonly codexHome: string;
  readonly platformFamily: string;
  readonly platformOs: string;
}

export interface ExitInfo {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

export interface RequestOptions {
  /** Defaults to `AppServerOptions.requestTimeoutMs`. */
  readonly timeoutMs?: number;
  /** Aborting rejects the request locally; the protocol has no generic cancel. */
  readonly signal?: AbortSignal;
}

export interface AppServerOptions {
  /** Absolute path of the Codex executable, see `resolveCodexExecutable`. */
  readonly executable: string;
  /** Defaults to `['app-server']`. */
  readonly args?: readonly string[];
  readonly cwd?: string;
  /** Child environment; defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
  readonly clientInfo: ClientInfo;
  readonly capabilities?: Readonly<Record<string, unknown>>;
  /** Default 60 s. */
  readonly requestTimeoutMs?: number;
  /** Time allowed for a clean exit after stdin is closed, default 5 s. */
  readonly shutdownTimeoutMs?: number;
  readonly onNotification?: (method: string, params: unknown) => void;
  /** Answers server-initiated requests. Without it they get "method not found". */
  readonly onServerRequest?: (method: string, params: unknown) => Promise<unknown>;
  /** Lines that are not valid protocol messages; they are skipped. */
  readonly onProtocolError?: (error: AppServerError) => void;
  readonly onExit?: (info: ExitInfo) => void;
}

export interface AppServerClient {
  readonly pid: number;
  readonly initializeResponse: InitializeResponse;
  request(method: string, params?: unknown, options?: RequestOptions): Promise<unknown>;
  notify(method: string, params?: unknown): void;
  close(): Promise<void>;
}

type Id = number | string;

interface Pending {
  resolve(value: unknown): void;
  reject(error: AppServerError): void;
}

const MAX_TIMEOUT_MS = 2_147_483_647; // setTimeout limit
const STDERR_TAIL_CHARS = 4_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isId(value: unknown): value is Id {
  return typeof value === 'number' || typeof value === 'string';
}

function checkTimeout(name: string, ms: number): number {
  if (!(ms > 0 && ms <= MAX_TIMEOUT_MS)) {
    throw new RangeError(`${name} must be in (0, ${String(MAX_TIMEOUT_MS)}]`);
  }
  return ms;
}

export async function startAppServer(options: AppServerOptions): Promise<AppServerClient> {
  const requestTimeoutMs = checkTimeout('requestTimeoutMs', options.requestTimeoutMs ?? 60_000);
  const shutdownTimeoutMs = checkTimeout('shutdownTimeoutMs', options.shutdownTimeoutMs ?? 5_000);

  const child = spawn(options.executable, options.args ?? ['app-server'], {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: 'pipe',
    windowsHide: true,
  });

  const pending = new Map<Id, Pending>();
  let nextId = 0;
  let stderrTail = '';
  let running = false;
  /** Set once the connection can no longer be used; every later call fails with it. */
  let ended: AppServerError | undefined;

  const exited = new Promise<void>((resolve) => {
    child.once('exit', (code, signal) => {
      running = false;
      options.onExit?.({ code, signal });
      resolve();
    });
  });

  function fail(error: AppServerError): void {
    if (ended) return;
    ended = error;
    for (const entry of pending.values()) entry.reject(error);
    pending.clear();
  }

  function protocolError(message: string): void {
    options.onProtocolError?.(new AppServerError('protocol', message));
  }

  function write(message: object): void {
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  child.on('error', (error) => {
    fail(new AppServerError('spawn', `Cannot run ${options.executable}: ${error.message}`));
  });
  // Writes after the server died surface here (EPIPE); the 'close' handler reports the exit.
  child.stdin.on('error', () => undefined);
  // Always drain stderr: a server blocked on a full stderr pipe stops serving stdout.
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_CHARS);
  });
  // 'close' follows the end of stdout, so responses written before exiting are delivered first.
  child.once('close', (code, signal) => {
    const status = signal ? `signal ${signal}` : `code ${String(code)}`;
    const detail = stderrTail.trim();
    fail(
      new AppServerError(
        'exited',
        `codex app-server exited with ${status}${detail ? `:\n${detail}` : ''}`,
      ),
    );
  });

  createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', (line) => {
    if (line.trim() === '') return;
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      protocolError(`Invalid JSON from app-server: ${line.slice(0, 200)}`);
      return;
    }
    if (!isRecord(message)) {
      protocolError(`Expected a JSON object from app-server: ${line.slice(0, 200)}`);
      return;
    }

    const { id, method } = message;
    if (typeof method === 'string') {
      if (isId(id)) void answerServerRequest(id, method, message['params']);
      else if (id === undefined) options.onNotification?.(method, message['params']);
      else protocolError(`Invalid request id from app-server: ${JSON.stringify(id)}`);
      return;
    }
    if (!isId(id)) {
      protocolError(`Message with neither method nor id: ${line.slice(0, 200)}`);
      return;
    }

    const entry = pending.get(id);
    if (!entry) {
      protocolError(`Response for unknown request id ${JSON.stringify(id)}`);
      return;
    }
    pending.delete(id);
    const error = message['error'];
    if (
      isRecord(error) &&
      typeof error['code'] === 'number' &&
      typeof error['message'] === 'string'
    ) {
      entry.reject(new AppServerError('rpc', error['message'], error['code'], error['data']));
    } else if ('result' in message && error === undefined) {
      entry.resolve(message['result']);
    } else {
      entry.reject(new AppServerError('protocol', `Invalid response for request ${String(id)}`));
    }
  });

  async function answerServerRequest(id: Id, method: string, params: unknown): Promise<void> {
    let reply: object;
    if (!options.onServerRequest) {
      reply = { id, error: { code: -32601, message: `Method not found: ${method}` } };
    } else {
      try {
        reply = { id, result: (await options.onServerRequest(method, params)) ?? null };
      } catch (error) {
        reply = {
          id,
          error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
        };
      }
    }
    if (!ended) write(reply);
  }

  function request(method: string, params?: unknown, requestOptions: RequestOptions = {}) {
    const { signal } = requestOptions;
    return new Promise<unknown>((resolve, reject) => {
      const timeoutMs = checkTimeout('timeoutMs', requestOptions.timeoutMs ?? requestTimeoutMs);
      if (ended) throw ended;
      if (signal?.aborted) throw new AppServerError('cancelled', `${method} was cancelled`);

      const id = nextId++;
      // Serialize first: unserializable params reject here, before anything is registered.
      const line = JSON.stringify(params === undefined ? { id, method } : { id, method, params });
      const settleLocally = (error: AppServerError) => {
        pending.get(id)?.reject(error);
        pending.delete(id);
      };
      const timer = setTimeout(() => {
        settleLocally(
          new AppServerError('timeout', `${method} timed out after ${String(timeoutMs)} ms`),
        );
      }, timeoutMs);
      const onAbort = () => {
        settleLocally(new AppServerError('cancelled', `${method} was cancelled`));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      const done = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      };

      pending.set(id, {
        resolve: (value) => {
          done();
          resolve(value);
        },
        reject: (error) => {
          done();
          reject(error);
        },
      });
      child.stdin.write(`${line}\n`);
    });
  }

  let closing: Promise<void> | undefined;
  function close(): Promise<void> {
    closing ??= (async () => {
      fail(new AppServerError('closed', 'The app-server client was closed'));
      if (!running) return;
      child.stdin.end(); // the server shuts down on end of input
      const term = setTimeout(() => child.kill('SIGTERM'), shutdownTimeoutMs);
      const forced = setTimeout(() => child.kill('SIGKILL'), 2 * shutdownTimeoutMs);
      await exited;
      clearTimeout(term);
      clearTimeout(forced);
    })();
    return closing;
  }

  await new Promise<void>((resolve, reject) => {
    child.once('spawn', () => {
      running = true;
      resolve();
    });
    child.once('error', () => {
      reject(ended ?? new AppServerError('spawn', `Cannot run ${options.executable}`));
    });
  });

  try {
    const params = {
      clientInfo: options.clientInfo,
      ...(options.capabilities ? { capabilities: options.capabilities } : {}),
    };
    const result = await request('initialize', params);
    if (!isRecord(result) || typeof result['userAgent'] !== 'string') {
      throw new AppServerError('protocol', 'Invalid initialize response from app-server');
    }
    write({ method: 'initialized' });
    return {
      pid: child.pid ?? -1,
      initializeResponse: result as unknown as InitializeResponse,
      request,
      notify(method, params) {
        if (ended) throw ended;
        write(params === undefined ? { method } : { method, params });
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
