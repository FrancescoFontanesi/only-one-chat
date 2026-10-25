// One headless Claude Code turn: `claude -p` with stream-json input and output,
// in the user's own profile, read-only. Contract and flags:
// docs/claude-code-cli.md.
//
// Billing is checked twice, fail-closed:
// 1. before the turn, `claude auth status --json` (no quota) must report a
//    claude.ai login on the first-party API, or the prompt is never sent;
// 2. the `system/init` event must report `apiKeySource: "none"`, or the
//    process tree is terminated at once.
// A custom base URL (ANTHROPIC_BASE_URL, e.g. a local proxy) cannot be verified
// and needs `allowUnverifiedProvider`, as for Codex.

import { execFile, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { getEnv, withoutApiKeys } from '../environment.js';
import { OWN_PROCESS_GROUP, terminateTree } from '../process-tree.js';

export type ClaudeErrorKind =
  | 'api_key'
  | 'not_logged_in'
  | 'unsupported_provider'
  | 'provider_not_verified'
  | 'auth_check_failed'
  | 'spawn'
  | 'exited'
  | 'stopped';

export class ClaudeError extends Error {
  override readonly name = 'ClaudeError';

  constructor(
    readonly kind: ClaudeErrorKind,
    message: string,
  ) {
    super(message);
  }
}

/** Read-only for this iteration: no writing, editing, shell or network tools. */
export const READ_ONLY_TOOLS = ['Read', 'Grep', 'Glob'] as const;
const DENIED_TOOLS = [
  'Bash',
  'PowerShell',
  'Edit',
  'MultiEdit',
  'Write',
  'NotebookEdit',
  'WebFetch',
  'WebSearch',
];

export type ClaudeBilling = 'subscription' | 'unverified_provider';

export type ClaudeEvent =
  | {
      readonly type: 'init';
      readonly sessionId: string;
      readonly model: string;
      readonly apiKeySource: string;
      readonly tools: readonly string[];
    }
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'tool_use'; readonly name: string; readonly input: unknown }
  | { readonly type: 'rate_limit'; readonly info: unknown }
  | { readonly type: 'other'; readonly message: Readonly<Record<string, unknown>> };

export interface ClaudeTurnResult {
  readonly sessionId: string;
  /** Final answer (`result` of the stream). */
  readonly text: string;
  readonly isError: boolean;
  readonly billing: ClaudeBilling;
  readonly permissionDenials: readonly unknown[];
}

export interface ClaudeTurnOptions {
  readonly executable: string;
  /** Working directory: the workspace. */
  readonly cwd: string;
  readonly prompt: string;
  /** Alias or full name accepted by `--model` (e.g. `haiku`). */
  readonly model?: string;
  /** `--effort` level (low, medium, high, xhigh, max). */
  readonly effort?: string;
  /** Role instructions added to Claude's own system prompt. */
  readonly appendSystemPrompt?: string;
  /** Continue an earlier session (`--resume`). */
  readonly resumeSessionId?: string;
  /** Accept a custom base URL (proxy) whose billing cannot be verified. */
  readonly allowUnverifiedProvider?: boolean;
  /** Environment for the child, minus API keys; defaults to `process.env`. */
  readonly baseEnv?: NodeJS.ProcessEnv;
  /** Arguments placed before Claude's own, for script-based executables (tests). */
  readonly launcherArgs?: readonly string[];
  readonly onEvent?: (event: ClaudeEvent) => void;
  /** Time allowed for a clean exit after the result or stop(), default 5 s. */
  readonly shutdownTimeoutMs?: number;
}

export interface ClaudeTurn {
  readonly done: Promise<ClaudeTurnResult>;
  /** Terminates the process tree; `done` rejects with kind `stopped`. Idempotent. */
  stop(): Promise<void>;
}

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function run(file: string, args: readonly string[], env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { env, windowsHide: true, timeout: 30_000, encoding: 'utf8' },
      (error, stdout) => {
        if (error) reject(new Error(error.message));
        else resolve(stdout);
      },
    );
  });
}

/** Command-line arguments of a turn; exported for tests and documentation. */
export function claudeTurnArgs(options: ClaudeTurnOptions): string[] {
  return [
    ...(options.launcherArgs ?? []),
    '-p',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    '--tools',
    READ_ONLY_TOOLS.join(','),
    '--disallowedTools',
    DENIED_TOOLS.join(','),
    // No MCP servers: the claude.ai connectors include tools that write elsewhere.
    '--strict-mcp-config',
    // Anything that would ask for permission is denied: nobody answers in -p mode.
    '--permission-prompts',
    'none',
    ...(options.model ? ['--model', options.model] : []),
    ...(options.effort ? ['--effort', options.effort] : []),
    ...(options.appendSystemPrompt ? ['--append-system-prompt', options.appendSystemPrompt] : []),
    ...(options.resumeSessionId ? ['--resume', options.resumeSessionId] : []),
  ];
}

/**
 * Decides billing before anything is sent: API key or third-party providers
 * are refused, a custom base URL needs the opt-in. Throws ClaudeError.
 */
export async function checkClaudeBilling(options: ClaudeTurnOptions): Promise<ClaudeBilling> {
  const env = withoutApiKeys(options.baseEnv ?? process.env);
  let status: unknown;
  try {
    status = JSON.parse(
      await run(
        options.executable,
        [...(options.launcherArgs ?? []), 'auth', 'status', '--json'],
        env,
      ),
    );
  } catch (error) {
    throw new ClaudeError(
      'auth_check_failed',
      `claude auth status failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isRecord(status)) throw new ClaudeError('auth_check_failed', 'Malformed claude auth status');
  if (status['loggedIn'] !== true) {
    throw new ClaudeError(
      'not_logged_in',
      'Claude is not signed in: run `claude auth login` in a terminal, then try again',
    );
  }
  if (status['apiProvider'] !== 'firstParty') {
    throw new ClaudeError(
      'unsupported_provider',
      `Claude uses the provider ${JSON.stringify(status['apiProvider'])}, which is billed outside the subscription`,
    );
  }
  if (status['authMethod'] !== 'claude.ai') {
    throw new ClaudeError(
      'api_key',
      `Claude authenticates with ${JSON.stringify(status['authMethod'])}, not a claude.ai subscription`,
    );
  }
  const baseUrl = getEnv(env, 'ANTHROPIC_BASE_URL');
  if (baseUrl) {
    if (!options.allowUnverifiedProvider) {
      throw new ClaudeError(
        'provider_not_verified',
        `Claude sends requests to ${baseUrl} (ANTHROPIC_BASE_URL), so the subscription cannot ` +
          'be verified. Enable allowUnverifiedProvider to use it anyway.',
      );
    }
    return 'unverified_provider';
  }
  return 'subscription';
}

/** Starts a turn once billing has been checked; see the module comment. */
export function startClaudeTurn(options: ClaudeTurnOptions): ClaudeTurn {
  const shutdownTimeoutMs = options.shutdownTimeoutMs ?? 5_000;
  let child: ReturnType<typeof spawn> | undefined;
  let stopped = false;
  const stopRequested = () => stopped;
  let closed: Promise<void> = Promise.resolve();

  async function terminate(): Promise<void> {
    const pid = child?.pid;
    if (!child || pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
    try {
      await terminateTree(pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL'); // last resort, the direct process only
    }
    await closed;
  }

  const done = (async (): Promise<ClaudeTurnResult> => {
    const billing = await checkClaudeBilling(options);
    // stop() may have been called while the billing check ran.
    if (stopRequested()) throw new ClaudeError('stopped', 'The Claude turn was stopped');

    const spawned = spawn(options.executable, claudeTurnArgs(options), {
      cwd: options.cwd,
      env: withoutApiKeys(options.baseEnv ?? process.env),
      stdio: 'pipe',
      windowsHide: true,
      detached: OWN_PROCESS_GROUP,
    });
    child = spawned;
    closed = new Promise((resolve) => {
      spawned.once('close', () => {
        resolve();
      });
    });
    let stderrTail = '';
    spawned.stderr.setEncoding('utf8');
    spawned.stderr.on('data', (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-4_000);
    });
    spawned.stdin.on('error', () => undefined);

    return new Promise<ClaudeTurnResult>((resolve, reject) => {
      let sessionId = '';
      let settled = false;
      const settle = (outcome: () => void) => {
        if (settled) return;
        settled = true;
        outcome();
      };
      spawned.once('error', (error) => {
        settle(() => {
          reject(new ClaudeError('spawn', `Cannot run Claude: ${error.message}`));
        });
      });

      createInterface({ input: spawned.stdout, crlfDelay: Infinity }).on('line', (line) => {
        let message: unknown;
        try {
          message = JSON.parse(line);
        } catch {
          return; // not part of the stream-json protocol
        }
        if (!isRecord(message)) return;
        const type = message['type'];
        if (type === 'system' && message['subtype'] === 'init') {
          sessionId = typeof message['session_id'] === 'string' ? message['session_id'] : '';
          const apiKeySource = String(message['apiKeySource']);
          options.onEvent?.({
            type: 'init',
            sessionId,
            model: String(message['model']),
            apiKeySource,
            tools: Array.isArray(message['tools']) ? message['tools'].map(String) : [],
          });
          if (apiKeySource !== 'none') {
            const error = new ClaudeError(
              'api_key',
              `Claude reported the API key source ${JSON.stringify(apiKeySource)}; the turn was stopped`,
            );
            settled = true;
            void terminate().then(() => {
              reject(error);
            });
          }
        } else if (type === 'assistant' && isRecord(message['message'])) {
          const content = message['message']['content'];
          for (const block of Array.isArray(content) ? content : []) {
            if (!isRecord(block)) continue;
            if (block['type'] === 'text' && typeof block['text'] === 'string') {
              options.onEvent?.({ type: 'text', text: block['text'] });
            } else if (block['type'] === 'tool_use') {
              options.onEvent?.({
                type: 'tool_use',
                name: String(block['name']),
                input: block['input'],
              });
            }
          }
        } else if (type === 'rate_limit_event') {
          options.onEvent?.({ type: 'rate_limit', info: message['rate_limit_info'] });
        } else if (type === 'result') {
          if (settled) return;
          settled = true;
          const result: ClaudeTurnResult = {
            sessionId:
              typeof message['session_id'] === 'string' ? message['session_id'] : sessionId,
            text: typeof message['result'] === 'string' ? message['result'] : '',
            isError: message['is_error'] === true,
            billing,
            permissionDenials: Array.isArray(message['permission_denials'])
              ? message['permission_denials']
              : [],
          };
          // One turn only: end the input so Claude exits, force it if it lingers, and
          // resolve only once nothing of the turn is left running.
          spawned.stdin.end();
          const timer = setTimeout(() => void terminate(), shutdownTimeoutMs);
          void closed.then(() => {
            clearTimeout(timer);
            resolve(result);
          });
        } else {
          options.onEvent?.({ type: 'other', message });
        }
      });

      spawned.once('close', (code, signal) => {
        const status = signal ? `signal ${signal}` : `code ${String(code)}`;
        const detail = stderrTail.trim() ? `:\n${stderrTail.trim()}` : '';
        settle(() => {
          reject(
            stopRequested()
              ? new ClaudeError('stopped', 'The Claude turn was stopped')
              : new ClaudeError('exited', `Claude exited with ${status} before a result${detail}`),
          );
        });
      });

      spawned.stdin.write(
        `${JSON.stringify({ type: 'user', message: { role: 'user', content: options.prompt } })}\n`,
      );
    });
  })();

  let stopping: Promise<void> | undefined;
  return {
    done,
    stop() {
      stopped = true;
      stopping ??= terminate();
      return stopping;
    },
  };
}
