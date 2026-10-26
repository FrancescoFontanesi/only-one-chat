// One headless Claude Code turn: `claude -p` with stream-json input and output,
// in the user's own profile, read-only. Contract and flags:
// docs/claude-code-cli.md.
//
// Billing is checked twice, fail-closed:
// 1. before the turn, `claude auth status --json` (no quota) must report a
//    claude.ai login on the first-party API, or the prompt is never sent;
// 2. the `system/init` event must report `apiKeySource: "none"`, or the
//    process tree is terminated at once.
// The permission mode is passed explicitly (`default`, whatever the user's
// settings say) and the turn is stopped the same way if init reports another.
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
  | 'stopped'
  /** init reported a permission mode other than the one passed. */
  | 'permission_mode'
  /** The subscription's usage limit is exhausted (HTTP 429); never retried here. */
  | 'usage_limit';

export class ClaudeError extends Error {
  override readonly name = 'ClaudeError';

  readonly kind: ClaudeErrorKind;

  // A plain field rather than a parameter property: runnable with Node's type stripping.
  constructor(kind: ClaudeErrorKind, message: string) {
    super(message);
    this.kind = kind;
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

/** Accepted by Claude Code 2.1.308 although --help lists only the other modes. */
export const PERMISSION_MODE = 'default';

export type ClaudeBilling = 'subscription' | 'unverified_provider';

export type ClaudeEvent =
  | {
      readonly type: 'init';
      readonly sessionId: string;
      readonly model: string;
      readonly apiKeySource: string;
      readonly permissionMode: string;
      readonly tools: readonly string[];
    }
  /**
   * `parentToolUseId` is null in the main conversation and the id of the Agent
   * tool call for a sub-agent's messages; `model` is the assistant message's.
   */
  | {
      readonly type: 'text';
      readonly text: string;
      readonly parentToolUseId: string | null;
      readonly model: string | null;
    }
  | {
      readonly type: 'tool_use';
      readonly id: string;
      readonly name: string;
      readonly input: unknown;
      readonly parentToolUseId: string | null;
      readonly model: string | null;
    }
  /** A tool's result, in a `user` message: ends an Agent tool call (a sub-agent). */
  | {
      readonly type: 'tool_result';
      readonly toolUseId: string;
      readonly isError: boolean;
      readonly parentToolUseId: string | null;
    }
  | { readonly type: 'rate_limit'; readonly info: unknown }
  | { readonly type: 'other'; readonly message: Readonly<Record<string, unknown>> };

export interface ClaudeTurnResult {
  readonly sessionId: string;
  /** Model reported by the init event (e.g. `claude-haiku-5-5`). */
  readonly model: string;
  /** Final answer (`result` of the stream). */
  readonly text: string;
  readonly isError: boolean;
  /** HTTP status of the API error that ended the turn (`api_error_status`), if any. */
  readonly apiErrorStatus: number | null;
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
  /**
   * Every stream-json object, in order: the prompt sent and each line received.
   * For diagnostics and transcripts; nothing here is redacted.
   */
  readonly onWire?: (
    direction: 'client' | 'server',
    message: Readonly<Record<string, unknown>>,
  ) => void;
  /** Time allowed for a clean exit after the result or stop(), default 5 s. */
  readonly shutdownTimeoutMs?: number;
  /**
   * Allow Claude's own sub-agents (the Agent tool), held to this model and
   * effort; without it the Agent tool is not offered. See subagentEnv.
   */
  readonly subagents?: { readonly model: string; readonly effort: string };
}

/**
 * Environment that holds Claude's sub-agents to a model and effort (Claude Code
 * docs, sub-agents; names checked in the 2.1.308 binary). Set on the child
 * process only, never in the user's settings:
 * - CLAUDE_CODE_SUBAGENT_MODEL with _FORCE: the model wins over a per-call
 *   choice and over agent definitions;
 * - CLAUDE_CODE_EFFORT_LEVEL: wins over a sub-agent's own effort; it also
 *   sets the main session's effort, so the policy effort should match it;
 * - CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH=1: sub-agents cannot nest.
 * Sub-agents inherit the parent's tools, so they stay read-only.
 */
export function subagentEnv(subagents: {
  readonly model: string;
  readonly effort: string;
}): NodeJS.ProcessEnv {
  return {
    CLAUDE_CODE_SUBAGENT_MODEL: subagents.model,
    CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '1',
    CLAUDE_CODE_EFFORT_LEVEL: subagents.effort,
    CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: '1',
  };
}

/**
 * Names a Claude sub-agent must never take: agents and models external to
 * Claude. Claude's own names are allowed (a custom agent "haiku-file-reader").
 */
export const CLAUDE_SUBAGENT_FORBIDDEN_NAMES = ['codex', 'luna', 'sol', 'gpt', 'gemini'];

/** The Agent tool, offered only with a sub-agent policy. */
export const SUBAGENT_TOOL = 'Agent';

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
    [...READ_ONLY_TOOLS, ...(options.subagents ? [SUBAGENT_TOOL] : [])].join(','),
    '--disallowedTools',
    DENIED_TOOLS.join(','),
    // No MCP servers: the claude.ai connectors include tools that write elsewhere.
    '--strict-mcp-config',
    // Anything that would ask for permission is denied: nobody answers in -p mode.
    '--permission-prompts',
    'none',
    // Explicit, so the user's defaultMode (acceptEdits, bypassPermissions, …) never applies.
    '--permission-mode',
    PERMISSION_MODE,
    // Without it the text of a foreground sub-agent is left out of the stream.
    ...(options.subagents ? ['--forward-subagent-text'] : []),
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
      env: {
        ...withoutApiKeys(options.baseEnv ?? process.env),
        ...(options.subagents ? subagentEnv(options.subagents) : {}),
      },
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
      let model = '';
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
        options.onWire?.('server', message);
        const type = message['type'];
        if (type === 'system' && message['subtype'] === 'init') {
          sessionId = typeof message['session_id'] === 'string' ? message['session_id'] : '';
          const apiKeySource = String(message['apiKeySource']);
          const permissionMode = String(message['permissionMode']);
          model = String(message['model']);
          options.onEvent?.({
            type: 'init',
            sessionId,
            model,
            apiKeySource,
            permissionMode,
            tools: Array.isArray(message['tools']) ? message['tools'].map(String) : [],
          });
          const refusal =
            apiKeySource !== 'none'
              ? new ClaudeError(
                  'api_key',
                  `Claude reported the API key source ${JSON.stringify(apiKeySource)}; the turn was stopped`,
                )
              : permissionMode !== PERMISSION_MODE
                ? new ClaudeError(
                    'permission_mode',
                    `Claude reported the permission mode ${JSON.stringify(permissionMode)} instead of "${PERMISSION_MODE}"; the turn was stopped`,
                  )
                : undefined;
          if (refusal) {
            settled = true;
            void terminate().then(() => {
              reject(refusal);
            });
          }
        } else if (type === 'assistant' && isRecord(message['message'])) {
          const parent = message['parent_tool_use_id'];
          const parentToolUseId = typeof parent === 'string' ? parent : null;
          const messageModel = message['message']['model'];
          const blockModel = typeof messageModel === 'string' ? messageModel : null;
          const content = message['message']['content'];
          for (const block of Array.isArray(content) ? content : []) {
            if (!isRecord(block)) continue;
            if (block['type'] === 'text' && typeof block['text'] === 'string') {
              options.onEvent?.({
                type: 'text',
                text: block['text'],
                parentToolUseId,
                model: blockModel,
              });
            } else if (block['type'] === 'tool_use') {
              options.onEvent?.({
                type: 'tool_use',
                id: String(block['id']),
                name: String(block['name']),
                input: block['input'],
                parentToolUseId,
                model: blockModel,
              });
            }
          }
        } else if (type === 'user' && isRecord(message['message'])) {
          const parent = message['parent_tool_use_id'];
          const content = message['message']['content'];
          for (const block of Array.isArray(content) ? content : []) {
            if (!isRecord(block) || block['type'] !== 'tool_result') continue;
            options.onEvent?.({
              type: 'tool_result',
              toolUseId: String(block['tool_use_id']),
              isError: block['is_error'] === true,
              parentToolUseId: typeof parent === 'string' ? parent : null,
            });
          }
        } else if (type === 'rate_limit_event') {
          options.onEvent?.({ type: 'rate_limit', info: message['rate_limit_info'] });
        } else if (type === 'result') {
          if (settled) return;
          settled = true;
          const result: ClaudeTurnResult = {
            sessionId:
              typeof message['session_id'] === 'string' ? message['session_id'] : sessionId,
            model,
            text: typeof message['result'] === 'string' ? message['result'] : '',
            isError: message['is_error'] === true,
            apiErrorStatus:
              typeof message['api_error_status'] === 'number' ? message['api_error_status'] : null,
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

      const prompt = { type: 'user', message: { role: 'user', content: options.prompt } };
      options.onWire?.('client', prompt);
      spawned.stdin.write(`${JSON.stringify(prompt)}\n`);
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
