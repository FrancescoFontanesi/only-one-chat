// Headless Claude turns against a fake CLI that replays the output recorded
// from Claude Code 2.1.308 (test/fixtures/claude/). The fake logs its argv,
// cwd, environment and stdin, so the tests can prove what reached it.

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ClaudeError,
  claudeTurnArgs,
  resolveClaudeExecutable,
  startClaudeTurn,
  type ClaudeEvent,
  type ClaudeTurnOptions,
  isOfficialAnthropicUrl,
} from '../src/index.js';
import { testEnv } from './env.js';
import { exited, isRunning } from './processes.js';

const FAKE = join(import.meta.dirname, 'fixtures', 'fake-claude.mjs');

let dir: string;
let log: string;
const strays: number[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'claude turn '));
  log = join(dir, 'fake.jsonl');
});
afterEach(() => {
  for (const pid of strays.splice(0)) {
    try {
      process.kill(pid);
    } catch {
      // already gone
    }
  }
  rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

interface LogEntry {
  argv?: string[];
  cwd?: string;
  env?: Record<string, string>;
  stdin?: string;
  hung?: boolean;
  grandchild?: number;
}

function fakeLog(): LogEntry[] {
  if (!existsSync(log)) return [];
  return readFileSync(log, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as LogEntry);
}

function options(flags: string[] = [], overrides: Partial<ClaudeTurnOptions> = {}) {
  const events: ClaudeEvent[] = [];
  return {
    events,
    options: {
      executable: process.execPath,
      launcherArgs: [FAKE, `--log=${log}`, ...flags],
      cwd: dir,
      prompt: 'Verifica le proposte',
      baseEnv: testEnv(),
      onEvent: (event: ClaudeEvent) => events.push(event),
      shutdownTimeoutMs: 300,
      ...overrides,
    } satisfies ClaudeTurnOptions,
  };
}

async function failure(promise: Promise<unknown>): Promise<ClaudeError> {
  const error: unknown = await promise.then(
    () => {
      throw new Error('expected the promise to reject');
    },
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(ClaudeError);
  return error as ClaudeError;
}

describe('arguments', () => {
  const args = claudeTurnArgs({
    executable: 'claude',
    cwd: '.',
    prompt: 'x',
    model: 'haiku',
    effort: 'low',
    appendSystemPrompt: 'role',
  });

  it('runs headless with stream-json in and out', () => {
    expect(args.slice(0, 6)).toEqual([
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
    ]);
  });

  it('is read-only: only read and search tools, no MCP, no permission prompts', () => {
    expect(args[args.indexOf('--tools') + 1]).toBe('Read,Grep,Glob');
    for (const tool of ['Bash', 'PowerShell', 'Edit', 'Write', 'WebFetch']) {
      expect(args[args.indexOf('--disallowedTools') + 1]?.split(',')).toContain(tool);
    }
    expect(args).toContain('--strict-mcp-config');
    expect(args[args.indexOf('--permission-prompts') + 1]).toBe('none');
  });

  it('never bypasses permissions', () => {
    expect(args.join(' ')).not.toMatch(/dangerously|bypassPermissions|acceptEdits/);
  });

  it('passes model, effort and role instructions as configured', () => {
    expect(args[args.indexOf('--model') + 1]).toBe('haiku');
    expect(args[args.indexOf('--effort') + 1]).toBe('low');
    expect(args[args.indexOf('--append-system-prompt') + 1]).toBe('role');
    expect(claudeTurnArgs({ executable: 'c', cwd: '.', prompt: 'x' })).not.toContain('--model');
  });
});

describe('a turn', () => {
  it('sends the prompt as a stream-json user message and collects the recorded answer', async () => {
    const { options: turn, events } = options();
    const result = await startClaudeTurn(turn).done;

    expect(result).toEqual({
      sessionId: '<session-id-1>',
      model: 'claude-haiku-5-5',
      text: 'OK',
      isError: false,
      apiErrorStatus: null,
      billing: 'subscription',
      permissionDenials: [],
    });
    expect(events.map((event) => event.type)).toEqual(['init', 'rate_limit', 'text']);
    expect(events[0]).toMatchObject({ sessionId: '<session-id-1>', apiKeySource: 'none' });
    const stdin = fakeLog().flatMap((entry) =>
      entry.stdin ? [JSON.parse(entry.stdin) as unknown] : [],
    );
    expect(stdin).toEqual([
      { type: 'user', message: { role: 'user', content: 'Verifica le proposte' } },
    ]);
  });

  it('streams the text of each assistant message as it arrives', async () => {
    const { options: turn, events } = options(['--echo']);
    const result = await startClaudeTurn(turn).done;
    expect(result.text).toBe('ECHO: Verifica le proposte');
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'text',
        text: 'ECHO: Verifica le proposte',
        parentToolUseId: null,
      }),
    );
  });

  it('runs in the workspace directory', async () => {
    await startClaudeTurn(options().options).done;
    const turnRun = fakeLog().find((entry) => entry.argv?.includes('-p'));
    expect(turnRun?.cwd?.toLowerCase()).toBe(dir.toLowerCase());
  });

  it('passes the user environment minus API keys', async () => {
    const baseEnv = testEnv({
      ANTHROPIC_API_KEY: 'should-not-leak',
      anthropic_auth_token: 'should-not-leak',
      OPENAI_API_KEY: 'should-not-leak',
      HTTPS_PROXY: 'http://127.0.0.1:3128',
      RTK_ENABLED: '1',
    });
    await startClaudeTurn(options([], { baseEnv }).options).done;
    for (const entry of fakeLog().filter((e) => e.env)) {
      expect(JSON.stringify(entry.env)).not.toContain('should-not-leak');
      expect(entry.env?.['HTTPS_PROXY']).toBe('http://127.0.0.1:3128');
      expect(entry.env?.['RTK_ENABLED']).toBe('1');
    }
  });
});

describe('billing checks', () => {
  function promptWasSent(): boolean {
    return fakeLog().some((entry) => entry.stdin !== undefined);
  }

  it.each([
    [['--logged-out'], 'not_logged_in', /claude auth login/],
    [['--auth-method=api_key'], 'api_key', /api_key/],
    [['--api-provider=bedrock'], 'unsupported_provider', /bedrock/],
    [['--auth-malformed'], 'auth_check_failed', /status/],
  ])('refuses %j before sending the prompt', async (flags, kind, message) => {
    const error = await failure(startClaudeTurn(options(flags).options).done);
    expect(error.kind).toBe(kind);
    expect(error.message).toMatch(message);
    expect(promptWasSent()).toBe(false);
    expect(fakeLog().some((entry) => entry.argv?.includes('-p'))).toBe(false);
  });

  it('refuses a custom base URL unless allowUnverifiedProvider is on', async () => {
    const baseEnv = testEnv({ ANTHROPIC_BASE_URL: 'http://127.0.0.1:8787' });
    const error = await failure(startClaudeTurn(options([], { baseEnv }).options).done);
    expect(error.kind).toBe('provider_not_verified');
    expect(error.message).toMatch(/127\.0\.0\.1:8787.*allowUnverifiedProvider/s);
    expect(promptWasSent()).toBe(false);

    const allowed = await startClaudeTurn(
      options([], { baseEnv, allowUnverifiedProvider: true }).options,
    ).done;
    expect(allowed.billing).toBe('unverified_provider');
  });

  it.each([
    'https://api.anthropic.com',
    'https://api.anthropic.com/',
    'HTTPS://API.Anthropic.com/',
  ])('accepts the official endpoint %s as the subscription', async (url) => {
    const baseEnv = testEnv({ ANTHROPIC_BASE_URL: url });
    const result = await startClaudeTurn(options([], { baseEnv }).options).done;
    expect(result.billing).toBe('subscription');
  });

  it.each([
    ['plain http', 'http://api.anthropic.com'],
    ['another host', 'https://api.anthropic.com.evil.example'],
    ['a port', 'https://api.anthropic.com:8443'],
    ['a path', 'https://api.anthropic.com/v1/proxy'],
    ['credentials', 'https://user:pass@api.anthropic.com'],
    ['a query', 'https://api.anthropic.com/?via=proxy'],
  ])('treats the official host with %s as a custom base URL', (_case, url) => {
    expect(isOfficialAnthropicUrl(url)).toBe(false);
  });

  it('stops the process as soon as init reports an API key source', async () => {
    const error = await failure(
      startClaudeTurn(options(['--api-key-source=ANTHROPIC_API_KEY']).options).done,
    );
    expect(error.kind).toBe('api_key');
    expect(error.message).toMatch(/ANTHROPIC_API_KEY/);
  });
});

describe('sandbox mode (ADR 0008)', () => {
  const turnArgv = () => fakeLog().find((entry) => entry.argv?.includes('-p'))?.argv ?? [];
  const after = (argv: string[], flag: string) => argv[argv.indexOf(flag) + 1];

  it('lets Claude write and edit in the working directory and run only the listed commands', async () => {
    const result = await startClaudeTurn(
      options(['--permission-mode-reported=acceptEdits'], {
        sandbox: { commands: ['python', 'py'] },
      }).options,
    ).done;
    expect(result.text).toBe('OK');
    const argv = turnArgv();
    expect(after(argv, '--tools')).toBe('Read,Grep,Glob,Write,Edit,Bash');
    expect(after(argv, '--allowedTools')).toBe('Write,Edit,Bash(python *),Bash(py *)');
    expect(after(argv, '--disallowedTools')).toBe(
      'PowerShell,MultiEdit,NotebookEdit,WebFetch,WebSearch',
    );
    expect(after(argv, '--permission-mode')).toBe('acceptEdits');
    expect(after(argv, '--permission-prompts')).toBe('none');
    expect(argv).toContain('--strict-mcp-config');
  });

  it('stays read-only without it', async () => {
    await startClaudeTurn(options().options).done;
    const argv = turnArgv();
    expect(after(argv, '--tools')).toBe('Read,Grep,Glob');
    expect(argv).not.toContain('--allowedTools');
    expect(after(argv, '--permission-mode')).toBe('default');
  });

  it('stops a sandbox turn whose init reports another permission mode', async () => {
    const error = await failure(
      startClaudeTurn(
        options(['--permission-mode-reported=bypassPermissions'], {
          sandbox: { commands: ['python'] },
        }).options,
      ).done,
    );
    expect(error.kind).toBe('permission_mode');
    expect(error.message).toMatch(/instead of "acceptEdits"/);
  });
});

describe('ending a turn', () => {
  it('stops a running turn and terminates its whole process tree', async () => {
    const { options: turn, events } = options(['--hang']);
    const running = startClaudeTurn(turn);
    const outcome = failure(running.done);
    while (!events.some((event) => event.type === 'init')) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    let grandchild: number | undefined;
    while (grandchild === undefined) {
      grandchild = fakeLog().find((entry) => entry.hung)?.grandchild;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    strays.push(grandchild);
    expect(isRunning(grandchild)).toBe(true);

    await running.stop();
    expect((await outcome).kind).toBe('stopped');
    expect(await exited(grandchild)).toBe(true);
    await running.stop(); // idempotent
  });

  it('reports a process that exits before the result', async () => {
    const error = await failure(startClaudeTurn(options(['--exit-early']).options).done);
    expect(error.kind).toBe('exited');
    expect(error.message).toMatch(/code 4/);
  });

  it('stop() before the turn starts sends nothing', async () => {
    const running = startClaudeTurn(options().options);
    const stopping = running.stop();
    const error = await failure(running.done);
    await stopping;
    expect(error.kind).toBe('stopped');
    expect(fakeLog().some((entry) => entry.stdin !== undefined)).toBe(false);
  });
});

describe('executable', () => {
  it.runIf(process.platform === 'win32')(
    'finds claude.exe on PATH and refuses a .cmd shim',
    async () => {
      const shimDir = join(dir, 'npm');
      const nativeDir = join(dir, 'native');
      for (const [folder, name] of [
        [shimDir, 'claude.cmd'],
        [nativeDir, 'claude.exe'],
      ] as const) {
        rmSync(folder, { recursive: true, force: true });
        await import('node:fs/promises').then((fs) => fs.mkdir(folder, { recursive: true }));
        writeFileSync(join(folder, name), '');
      }
      await expect(resolveClaudeExecutable({ env: { PATH: shimDir } })).rejects.toThrow(
        /script launcher/,
      );
      expect(await resolveClaudeExecutable({ env: { PATH: `${shimDir};${nativeDir}` } })).toBe(
        join(nativeDir, 'claude.exe'),
      );
    },
  );

  it('requires an absolute configured path', async () => {
    await expect(resolveClaudeExecutable({ configuredPath: 'claude.exe' })).rejects.toThrow(
      /absolute/,
    );
  });
});
