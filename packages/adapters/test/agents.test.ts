// The Codex and Claude agent sessions the runtime drives, against the fake
// app-server and the fake Claude CLI.

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CLAUDE_SUBAGENT_FORBIDDEN_NAMES,
  CODEX_SUBAGENT_FORBIDDEN_NAMES,
  ClaudeError,
  CodexAuthError,
  createClaudeAgentFactory,
  createCodexAgentFactory,
  approvalResponse,
  declineResponse,
  writableThreadConfig,
  type AgentApprovalRequest,
  type AgentSubagentEvent,
  type AgentSession,
  type AgentTurnHandlers,
  codexAnswers,
  codexInput,
  codexQuestions,
  claudeToolStep,
  diffCounts,
  itemStep,
  StepStream,
  tail,
  type AgentTurnStep,
} from '../src/index.js';
import { testEnv } from './env.js';

const FAKE_CODEX = join(import.meta.dirname, 'fixtures', 'fake-app-server.mjs');
const FAKE_CLAUDE = join(import.meta.dirname, 'fixtures', 'fake-claude.mjs');

let dir: string;
const sessions: AgentSession[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agents '));
});
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.close()));
  rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

function handlers() {
  const text: string[] = [];
  const approvals: AgentApprovalRequest[] = [];
  const activity: string[] = [];
  const subagents: AgentSubagentEvent[] = [];
  const value: AgentTurnHandlers = {
    onText: (chunk) => text.push(chunk),
    onApprovalRequest: (request) => {
      approvals.push(request);
      return Promise.resolve('decline');
    },
    onActivity: ({ kind }) => activity.push(kind),
    onSubagent: (event) => subagents.push(event),
  };
  return { value, text, approvals, activity, subagents };
}

async function codex(account = 'chatgpt', extra: Record<string, unknown> = {}) {
  const session = await createCodexAgentFactory({
    executable: process.execPath,
    baseEnv: testEnv(),
    launcherArgs: [FAKE_CODEX, `--account=${account}`],
    cwd: dir,
    model: 'gpt-6-luna',
    effort: 'low',
    requestTimeoutMs: 5_000,
    interruptTimeoutMs: 2_000,
    ...extra,
  })({ instructions: 'Sei l’orchestratore.' });
  sessions.push(session);
  return session;
}

describe('Codex agent session', () => {
  it('starts a read-only thread with the runtime instructions, the model and no auto-review', async () => {
    const received = join(dir, 'received.jsonl');
    const session = await codex('chatgpt', {
      launcherArgs: [FAKE_CODEX, '--account=chatgpt', `--log=${received}`],
    });
    expect(session.name).toBe('Codex (gpt-6-luna)');
    await session.runTurn('ciao', handlers().value).done;

    const messages = readFileSync(received, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { method?: string; params?: Record<string, unknown> });
    const params = (method: string) => messages.find((m) => m.method === method)?.params;
    expect(params('thread/start')).toEqual({
      cwd: dir,
      sandbox: 'read-only',
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user',
      developerInstructions: 'Sei l’orchestratore.',
      ephemeral: true,
      model: 'gpt-6-luna',
    });
    expect(params('turn/start')).toEqual({
      threadId: 'thread-1',
      input: [{ type: 'text', text: 'ciao' }],
      model: 'gpt-6-luna',
      effort: 'low',
      // The reasoning's summary, a step of the turn (ADR 0019).
      summary: 'auto',
    });
  });

  it('resumes a kept thread with the same rules, and starts a persistent one otherwise', async () => {
    const received = join(dir, 'received.jsonl');
    const factory = createCodexAgentFactory({
      executable: process.execPath,
      baseEnv: testEnv(),
      launcherArgs: [FAKE_CODEX, '--account=chatgpt', `--log=${received}`],
      cwd: dir,
      model: 'gpt-6-luna',
      effort: 'low',
      requestTimeoutMs: 5_000,
      persistent: true,
    });
    const kept = await factory({ instructions: 'Sei il leader.', resume: 'kept-7' });
    sessions.push(kept);
    const first = await kept.runTurn('ciao', handlers().value).done;
    expect(first.identity.sessionId).toBe('kept-7');
    // The thread's totals before this session are unknown: no usage for this turn.
    expect(first.usage).toBeUndefined();
    const lost = await factory({ instructions: 'Sei il leader.', resume: 'gone-1' });
    sessions.push(lost);
    expect((await lost.runTurn('ciao', handlers().value).done).identity.sessionId).toBe('thread-1');
    const sent = readFileSync(received, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { method?: string; params?: Record<string, unknown> });
    expect(sent.find((m) => m.method === 'thread/resume')?.params).toMatchObject({
      threadId: 'kept-7',
      developerInstructions: 'Sei il leader.',
      approvalsReviewer: 'user',
      excludeTurns: true,
    });
    expect(sent.find((m) => m.method === 'thread/start')?.params).toMatchObject({
      ephemeral: false,
    });
  });

  it('sends the effort chosen during the chat with the next turn, in the same thread', async () => {
    const received = join(dir, 'received.jsonl');
    const session = await codex('chatgpt', {
      launcherArgs: [FAKE_CODEX, '--account=chatgpt', `--log=${received}`],
    });
    await session.runTurn('primo', handlers().value).done;
    session.setEffort?.('high');
    const second = await session.runTurn('secondo', handlers().value).done;
    expect(second.identity.effort).toBe('high');
    const starts = readFileSync(received, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { method?: string; params?: Record<string, unknown> })
      .filter((m) => m.method === 'turn/start')
      .map((m) => m.params);
    expect(starts.map((p) => [p?.['threadId'], p?.['effort']])).toEqual([
      ['thread-1', 'low'],
      ['thread-1', 'high'],
    ]);
  });

  it('reports the thread’s context: its latest request and the model’s window', async () => {
    const session = await codex();
    const result = await session.runTurn('ciao', handlers().value).done;
    expect(result.context).toEqual({ used: 1050, window: 258400 });
  });

  it('changes the model of the next turns in the same thread', async () => {
    const received = join(dir, 'received.jsonl');
    const session = await codex('chatgpt', {
      launcherArgs: [FAKE_CODEX, '--account=chatgpt', `--log=${received}`],
    });
    await session.runTurn('primo', handlers().value).done;
    session.setModel?.('gpt-6.1-sol');
    expect(session.name).toBe('Codex (gpt-6.1-sol)');
    await session.runTurn('secondo', handlers().value).done;
    const starts = readFileSync(received, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { method?: string; params?: Record<string, unknown> })
      .filter((m) => m.method === 'turn/start')
      .map((m) => m.params);
    expect(starts.map((p) => [p?.['threadId'], p?.['model']])).toEqual([
      ['thread-1', 'gpt-6-luna'],
      ['thread-1', 'gpt-6.1-sol'],
    ]);
  });

  it('starts a writable thread only when asked, with the unelevated sandbox on Windows', async () => {
    const received = join(dir, 'received.jsonl');
    const session = await codex('chatgpt', {
      launcherArgs: [FAKE_CODEX, '--account=chatgpt', `--log=${received}`],
      writable: true,
    });
    await session.runTurn('ciao', handlers().value).done;
    const start = readFileSync(received, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { method?: string; params?: Record<string, unknown> })
      .find((m) => m.method === 'thread/start')?.params;
    expect(start).toMatchObject({ sandbox: 'workspace-write', approvalPolicy: 'on-request' });
    expect(start?.['config']).toEqual(
      process.platform === 'win32' ? { 'windows.sandbox': 'unelevated' } : undefined,
    );
    expect(writableThreadConfig('win32')).toEqual({ 'windows.sandbox': 'unelevated' });

    const isolated = join(dir, 'isolated.jsonl');
    const quiet = await codex('chatgpt', {
      launcherArgs: [FAKE_CODEX, '--account=chatgpt', `--log=${isolated}`],
      withoutUserHooks: true,
    });
    await quiet.runTurn('ciao', handlers().value).done;
    const quietStart = readFileSync(isolated, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { method?: string; params?: Record<string, unknown> })
      .find((m) => m.method === 'thread/start')?.params;
    expect(quietStart?.['config']).toEqual({ 'features.hooks': false });
    expect(writableThreadConfig('linux')).toEqual({});
  });

  it('streams deltas and resolves with the completed agent message', async () => {
    const session = await codex();
    const h = handlers();
    const { text } = await session.runTurn('analizza', h.value).done;
    expect(text).toBe('Risposta: analizza');
    expect(h.text.join('')).toBe('Risposta: analizza');
  });

  it('reports the identity Codex gave the thread, with the proxy it goes through', async () => {
    const direct = await codex();
    expect(direct.id).toBe('codex');
    expect((await direct.runTurn('ciao', handlers().value).done).identity).toEqual({
      provider: 'Codex',
      model: 'gpt-6-luna',
      effort: 'low',
      sessionId: 'thread-1',
    });
    const proxied = await codex('chatgpt', {
      launcherArgs: [
        FAKE_CODEX,
        '--account=chatgpt',
        '--provider=headroom',
        '--provider-name=Headroom persistent proxy',
      ],
      effort: undefined,
    });
    expect((await proxied.runTurn('ciao', handlers().value).done).identity).toMatchObject({
      provider: 'Codex via Headroom persistent proxy',
      effort: 'high', // the thread default reported by thread/start
    });
  });

  const policy = {
    model: 'gpt-6-luna',
    effort: 'low',
    maxConcurrent: 2,
    forbiddenNames: ['claude'],
    rules: 'REGOLE',
  };

  async function codexWithPolicy(received: string) {
    const session = await createCodexAgentFactory({
      executable: process.execPath,
      baseEnv: testEnv(),
      launcherArgs: [FAKE_CODEX, '--account=chatgpt', `--log=${received}`],
      cwd: dir,
      model: 'gpt-6-luna',
      effort: 'low',
      requestTimeoutMs: 5_000,
      interruptTimeoutMs: 2_000,
    })({ instructions: 'Sei l’orchestratore.', subagents: policy });
    sessions.push(session);
    return session;
  }

  it('reports a native sub-agent with its model, effort, messages and commands', async () => {
    const session = await codexWithPolicy(join(dir, 'received.jsonl'));
    const h = handlers();
    const { text } = await session.runTurn('[subagent] leggi un file', h.value).done;
    expect(text).toBe('Risposta: [subagent] leggi un file');
    expect(h.subagents).toEqual([
      {
        type: 'started',
        id: 'thread-child',
        name: '/root/explorer',
        model: 'gpt-6-luna', // the thread's default_subagent_model override
        effort: 'low',
      },
      { type: 'text', id: 'thread-child', text: 'letto il file' },
      { type: 'activity', id: 'thread-child', kind: 'command', detail: 'Get-Content x.ts' },
      { type: 'finished', id: 'thread-child', status: 'completed' },
    ]);
    expect(h.text.join('')).not.toContain('letto il file'); // not the parent's text
  });

  it('reports what the sub-agent really runs with, and leaves the policy to the runtime', async () => {
    const session = await codexWithPolicy(join(dir, 'received.jsonl'));
    const h = handlers();
    await session.runTurn(
      '[subagent] [subagent-model=gpt-6.1-sol] [subagent-effort=high] [subagent-name=/root/claude]',
      h.value,
    ).done;
    expect(h.subagents[0]).toMatchObject({
      name: '/root/claude',
      model: 'gpt-6.1-sol',
      effort: 'high',
    });
  });

  it('stop interrupts the sub-agent’s turn as well as its parent’s', async () => {
    const received = join(dir, 'received.jsonl');
    const session = await codexWithPolicy(received);
    const h = handlers();
    const turn = session.runTurn('[subagent] [subagent-hang] lungo', h.value);
    await new Promise((resolve) => setTimeout(resolve, 300));
    await turn.stop();
    await expect(turn.done).rejects.toThrow(/interrupted/);
    const interrupts = readFileSync(received, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { method?: string; params?: Record<string, unknown> })
      .filter((m) => m.method === 'turn/interrupt')
      .map((m) => m.params?.['threadId']);
    expect(interrupts.sort()).toEqual(['thread-1', 'thread-child']);
    expect(h.subagents.at(-1)).toEqual({
      type: 'finished',
      id: 'thread-child',
      status: 'interrupted',
    });
  });

  it('holds sub-agents to the policy with per-thread overrides only', async () => {
    const received = join(dir, 'received.jsonl');
    const session = await createCodexAgentFactory({
      executable: process.execPath,
      baseEnv: testEnv(),
      launcherArgs: [FAKE_CODEX, '--account=chatgpt', `--log=${received}`],
      cwd: dir,
      model: 'gpt-6-luna',
      effort: 'low',
      requestTimeoutMs: 5_000,
    })({
      instructions: 'Sei l’orchestratore.',
      subagents: {
        model: 'gpt-6-luna',
        effort: 'low',
        maxConcurrent: 2,
        forbiddenNames: ['claude'],
        rules: 'REGOLE DEL RUNTIME',
      },
    });
    sessions.push(session);
    const start = readFileSync(received, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { method?: string; params?: Record<string, unknown> })
      .find((m) => m.method === 'thread/start');
    const config = start?.params?.['config'] as Record<string, unknown>;
    expect(config).toMatchObject({
      'agents.default_subagent_model': 'gpt-6-luna',
      'agents.default_subagent_reasoning_effort': 'low',
      'agents.max_concurrent_threads_per_session': 2,
      'features.multi_agent_v2.max_concurrent_threads_per_session': 2,
      'features.multi_agent_v2.expose_spawn_agent_model_overrides': false,
    });
    for (const hint of ['root_agent_usage_hint_text', 'subagent_usage_hint_text']) {
      expect(config[`features.multi_agent_v2.${hint}`]).toContain('REGOLE DEL RUNTIME');
    }
    expect(config['features.multi_agent_v2.multi_agent_mode_hint_text']).toMatch(/esplicitamente/);
    // Ephemeral threads have no rollout to fork from (real check, second turn).
    expect(config['features.multi_agent_v2.root_agent_usage_hint_text']).toContain(
      'fork_turns: "none"',
    );
    expect(
      Object.keys(config).every((key) => /^(agents|features\.multi_agent_v2)\./.test(key)),
    ).toBe(true);
  });

  it('passes no thread config when sub-agents follow the user configuration', async () => {
    const received = join(dir, 'received.jsonl');
    const session = await codex('chatgpt', {
      launcherArgs: [FAKE_CODEX, '--account=chatgpt', `--log=${received}`],
    });
    await session.runTurn('ciao', handlers().value).done;
    expect(readFileSync(received, 'utf8')).not.toContain('features.multi_agent');
  });

  it('forbids sub-agent names external to each CLI, never its own', () => {
    expect(CODEX_SUBAGENT_FORBIDDEN_NAMES).toEqual(['claude', 'haiku', 'opus', 'sonnet', 'gemini']);
    expect(CLAUDE_SUBAGENT_FORBIDDEN_NAMES).toEqual(['codex', 'luna', 'sol', 'gpt', 'gemini']);
    expect(CLAUDE_SUBAGENT_FORBIDDEN_NAMES).not.toContain('haiku');
  });

  it('reports the turn’s tokens by model, sub-agents included, and the quota seen', async () => {
    const session = await codexWithPolicy(join(dir, 'received.jsonl'));
    await session.runTurn('ciao', handlers().value).done;
    const second = await session.runTurn('[subagent] leggi', handlers().value).done;
    // The second turn counts its own growth of the thread, not the first turn's tokens.
    expect(second.usage?.byModel['gpt-6-luna']).toEqual({
      input: 600 + 500, // the sub-agent runs on gpt-6-luna too
      cachedInput: 400,
      cacheWrite: 0,
      output: 50 + 20,
      reasoning: 10,
    });
    expect(second.usage?.costUsd).toBeNull();
    expect(second.usage?.durationMs).toBeGreaterThanOrEqual(0);
    expect(second.quota?.windows).toEqual([
      { name: '5h', usedPercent: 15, resetsAt: 1793019278 },
      { name: 'weekly', usedPercent: 2, resetsAt: 1793606078 },
    ]);
  });

  it('reports MCP tool calls as activity', async () => {
    const session = await codex();
    const h = handlers();
    await session.runTurn('[mcp] cerca', h.value).done;
    expect(h.activity).toContain('mcp_tool');
  });

  it('routes an approval request to the runtime and declines it on the wire', async () => {
    const session = await codex();
    const h = handlers();
    const { text } = await session.runTurn('[approval] pubblica', h.value).done;
    expect(h.approvals).toEqual([
      { kind: 'item/commandExecution/requestApproval', summary: 'git push — needs network' },
    ]);
    expect(text).toBe('decision={"decision":"decline"}');
  });

  it('sends the user’s approval of a command, once or for the session, back to Codex', async () => {
    for (const decision of ['accept', 'acceptForSession'] as const) {
      const session = await codex();
      const h = handlers();
      const value: AgentTurnHandlers = {
        ...h.value,
        onApprovalRequest: () => Promise.resolve(decision),
      };
      const { text } = await session.runTurn('[approval] pubblica', value).done;
      expect(text).toBe(`decision=${JSON.stringify({ decision })}`);
    }
    // Requests other than commands and file changes are never granted.
    expect(approvalResponse('item/permissions/requestApproval', 'accept')).toEqual({
      permissions: {},
      scope: 'turn',
    });
  });

  it('asks before any untrusted command when the policy says so', async () => {
    const received = join(dir, 'received.jsonl');
    const session = await codex('chatgpt', {
      launcherArgs: [FAKE_CODEX, '--account=chatgpt', `--log=${received}`],
      writable: true,
      approvalPolicy: 'untrusted',
    });
    await session.runTurn('ciao', handlers().value).done;
    const start = readFileSync(received, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { method?: string; params?: Record<string, unknown> })
      .find((m) => m.method === 'thread/start')?.params;
    expect(start).toMatchObject({ sandbox: 'workspace-write', approvalPolicy: 'untrusted' });
  });

  it('interrupts a running turn with turn/interrupt', async () => {
    const session = await codex();
    const turn = session.runTurn('[hang] lungo', handlers().value);
    await new Promise((resolve) => setTimeout(resolve, 200));
    await turn.stop();
    await expect(turn.done).rejects.toThrow(/interrupted/);
  });

  it('rejects a failed turn with its error', async () => {
    const session = await codex();
    await expect(session.runTurn('[fail]', handlers().value).done).rejects.toThrow(/failed: boom/);
  });

  it('runs one turn at a time', async () => {
    const session = await codex();
    const first = session.runTurn('[hang]', handlers().value);
    expect(() => session.runTurn('altro', handlers().value)).toThrow(/already running/);
    await first.stop();
    await first.done.catch(() => undefined);
  });

  it('refuses to start without a usable account', async () => {
    await expect(codex('apiKey')).rejects.toBeInstanceOf(CodexAuthError);
    await expect(codex('none')).rejects.toThrow(/codex login/);
  });

  it.each([
    ['item/commandExecution/requestApproval', { decision: 'decline' }],
    ['item/fileChange/requestApproval', { decision: 'decline' }],
    ['item/permissions/requestApproval', { permissions: {}, scope: 'turn' }],
    ['mcpServer/elicitation/request', { action: 'decline', content: null }],
  ])('declines %s with the protocol answer', (method, answer) => {
    expect(declineResponse(method)).toEqual(answer);
  });

  it('answers an unknown server request with an error rather than a guess', () => {
    expect(() => declineResponse('item/tool/requestUserInput')).toThrow(/not supported/);
  });
});

describe('Claude agent session', () => {
  const log = () => join(dir, 'claude.jsonl');

  function claude(fakeFlags: string[] = ['--echo']) {
    return createClaudeAgentFactory({
      executable: process.execPath,
      launcherArgs: [FAKE_CLAUDE, `--log=${log()}`, ...fakeFlags],
      cwd: dir,
      model: 'haiku',
      effort: 'low',
      baseEnv: testEnv(),
      shutdownTimeoutMs: 300,
    })({ instructions: 'Sei il worker.' });
  }

  function turnArgs(): string[][] {
    if (!existsSync(log())) return [];
    return readFileSync(log(), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { argv?: string[] })
      .flatMap((entry) => (entry.argv?.includes('-p') ? [entry.argv] : []));
  }

  it('streams the answer, passes the role instructions and resumes its session', async () => {
    const session = await claude();
    sessions.push(session);
    const h = handlers();
    expect((await session.runTurn('prima delega', h.value).done).text).toBe('ECHO: prima delega');
    expect(h.text).toEqual(['ECHO: prima delega']);
    await session.runTurn('seconda delega', handlers().value).done;

    const [first, second] = turnArgs();
    expect(first?.[first.indexOf('--append-system-prompt') + 1]).toBe('Sei il worker.');
    expect(first?.[first.indexOf('--permission-mode') + 1]).toBe('default');
    expect(first).not.toContain('--resume');
    expect(second?.[second.indexOf('--resume') + 1]).toBe('<session-id-1>');
  });

  it('allows the Agent tool only with a sub-agent policy, forcing model, effort and depth', async () => {
    const withPolicy = await createClaudeAgentFactory({
      executable: process.execPath,
      launcherArgs: [FAKE_CLAUDE, `--log=${log()}`, '--echo'],
      cwd: dir,
      model: 'haiku',
      effort: 'low',
      baseEnv: testEnv({ CLAUDE_CODE_SUBAGENT_MODEL: 'claude-opus-from-user' }),
      shutdownTimeoutMs: 300,
    })({
      instructions: 'Sei il worker.',
      subagents: {
        model: 'claude-haiku-5-5',
        effort: 'low',
        maxConcurrent: 2,
        forbiddenNames: ['codex'],
        rules: 'REGOLE DEL RUNTIME',
      },
    });
    sessions.push(withPolicy);
    await withPolicy.runTurn('domanda', handlers().value).done;
    const without = await claude();
    sessions.push(without);
    await without.runTurn('domanda', handlers().value).done;

    const entries = readFileSync(log(), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { argv?: string[]; env?: Record<string, string> })
      .filter((entry) => entry.argv?.includes('-p'));
    const [first, second] = entries;
    const tools = (argv: string[] | undefined) => argv?.[argv.indexOf('--tools') + 1];
    expect(tools(first?.argv)).toBe('Read,Grep,Glob,Agent');
    expect(first?.argv).toContain('--forward-subagent-text');
    const argv = first?.argv ?? [];
    expect(argv[argv.indexOf('--append-system-prompt') + 1]).toContain('REGOLE DEL RUNTIME');
    expect(first?.env).toMatchObject({
      CLAUDE_CODE_SUBAGENT_MODEL: 'claude-haiku-5-5', // the policy wins over the user's value
      CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '1',
      CLAUDE_CODE_EFFORT_LEVEL: 'low',
      CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: '1',
      CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1', // sub-agents report within the turn
    });
    expect(tools(second?.argv)).toBe('Read,Grep,Glob');
    expect(second?.argv).not.toContain('--forward-subagent-text');
    expect(second?.env?.['CLAUDE_CODE_SUBAGENT_MODEL_FORCE']).toBeUndefined();
  });

  it('reports the recorded modelUsage, nominal cost and quota of the turn', async () => {
    const session = await claudeWithPolicy(['--scenario=turn-subagent']);
    const result = await session.runTurn('usa un sotto-agente', handlers().value).done;
    expect(Object.keys(result.usage?.byModel ?? {})).toEqual(['claude-haiku-5-5']);
    expect(result.usage?.costUsd).toBeCloseTo(0.004476445);
    expect(result.quota?.windows[0]).toMatchObject({ name: '5h', usedPercent: 69 });
  });

  it('resumes an earlier session, without counting its earlier usage as this turn’s', async () => {
    const session = await createClaudeAgentFactory({
      executable: process.execPath,
      launcherArgs: [FAKE_CLAUDE, `--log=${log()}`, '--echo'],
      cwd: dir,
      model: 'haiku',
      effort: 'low',
      baseEnv: testEnv(),
      shutdownTimeoutMs: 300,
    })({ instructions: 'Sei il worker.', resume: 'session-earlier' });
    sessions.push(session);
    const first = await session.runTurn('di nuovo', handlers().value).done;
    expect(turnArgs()[0]).toEqual(expect.arrayContaining(['--resume', 'session-earlier']));
    expect(first.usage).toBeUndefined();
    const second = await session.runTurn('ancora', handlers().value).done;
    expect(second.usage).toBeDefined();
  });

  it('changes the effort of the next turns in the same session', async () => {
    const session = await claudeWithPolicy(['--echo']);
    await session.runTurn('primo', handlers().value).done;
    session.setEffort?.('high');
    const second = await session.runTurn('secondo', handlers().value).done;
    expect(second.identity.effort).toBe('high');
    const runs = readFileSync(log(), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { argv?: string[]; env?: Record<string, string> })
      .filter((entry) => entry.argv?.includes('-p'));
    const effortOf = (argv: string[] | undefined) => argv?.[argv.indexOf('--effort') + 1];
    expect(runs.map((run) => effortOf(run.argv))).toEqual(['low', 'high']);
    // The sub-agents' effort variable follows, since it also sets the main session's.
    expect(runs[1]?.env?.['CLAUDE_CODE_EFFORT_LEVEL']).toBe('high');
    // The same session: the second turn resumes the first.
    expect(runs[1]?.argv).toContain('--resume');
  });

  it('reports the context of the main conversation, not of its sub-agents', async () => {
    const session = await claudeWithPolicy([]);
    const result = await session.runTurn('ciao', handlers().value).done;
    // turn-ok.jsonl: the last assistant message's input, cache writes, cache reads and output.
    expect(result.context).toEqual({ used: 2 + 5402 + 649 + 4, window: 1_000_000 });
  });

  it('changes the model of the next turns in the same session', async () => {
    const session = await claudeWithPolicy(['--echo']);
    await session.runTurn('primo', handlers().value).done;
    session.setModel?.('sonnet');
    expect(session.name).toBe('Claude (sonnet)');
    await session.runTurn('secondo', handlers().value).done;
    const runs = readFileSync(log(), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { argv?: string[] })
      .filter((entry) => entry.argv?.includes('-p'));
    const modelOf = (argv: string[] | undefined) => argv?.[argv.indexOf('--model') + 1];
    expect(runs.map((run) => modelOf(run.argv))).toEqual(['haiku', 'sonnet']);
    expect(runs[1]?.argv).toContain('--resume');
  });

  it('reports a resumed turn as the difference from the session so far, not the running total', async () => {
    // A resumed `claude -p` reports the session's cumulative modelUsage and cost
    // (2.1.308, observed on real sessions). The fake reports the same total each
    // turn, so the second turn adds nothing.
    const session = await claudeWithPolicy(['--scenario=turn-subagent']);
    await session.runTurn('primo', handlers().value).done;
    const second = await session.runTurn('secondo', handlers().value).done;
    expect(second.usage?.byModel['claude-haiku-5-5']).toEqual({
      input: 0,
      cachedInput: 0,
      cacheWrite: 0,
      output: 0,
      reasoning: 0,
    });
    expect(second.usage?.costUsd).toBeCloseTo(0);
  });

  it('labels the answer with the model and session reported by init', async () => {
    const session = await claude();
    sessions.push(session);
    expect(session.id).toBe('claude');
    expect((await session.runTurn('domanda', handlers().value).done).identity).toEqual({
      provider: 'Claude Code',
      model: 'claude-haiku-5-5',
      effort: 'low',
      sessionId: '<session-id-1>',
    });
  });

  async function claudeWithPolicy(fakeFlags: string[]) {
    const session = await createClaudeAgentFactory({
      executable: process.execPath,
      launcherArgs: [FAKE_CLAUDE, `--log=${log()}`, ...fakeFlags],
      cwd: dir,
      model: 'haiku',
      effort: 'low',
      baseEnv: testEnv(),
      shutdownTimeoutMs: 300,
    })({
      instructions: 'Sei il worker.',
      subagents: { ...policyForClaude, rules: 'REGOLE' },
    });
    sessions.push(session);
    return session;
  }
  const policyForClaude = {
    model: 'claude-haiku-5-5',
    effort: 'low',
    maxConcurrent: 2,
    forbiddenNames: ['codex'],
  };

  // Real stream (turn-subagent.jsonl): Claude Code 2.1.308, Haiku, one sub-agent.
  const SUB = 'toolu_01S6DpE6xyR9sryLm3G2Zfrp';

  it('reports a sub-agent from the Agent tool call, its messages and the model that ran it', async () => {
    const session = await claudeWithPolicy(['--scenario=turn-subagent']);
    const h = handlers();
    const { text } = await session.runTurn('usa un sotto-agente', h.value).done;
    expect(text).toMatch(/^Il sotto-agente \(haiku-file-reader\) riporta/);
    expect(h.subagents[0]).toEqual({
      type: 'started',
      id: SUB,
      name: 'haiku-file-reader',
      model: null,
      effort: null,
    });
    expect(h.subagents[1]).toEqual({
      type: 'identified',
      id: SUB,
      model: 'claude-haiku-5-5',
      effort: null,
    });
    const tools = h.subagents.flatMap((e) =>
      e.type === 'activity' ? [e.detail.split(' ')[0]] : [],
    );
    expect(tools).toEqual(['Grep', 'Read']);
    expect(h.subagents.some((e) => e.type === 'text' && e.text.includes('withoutApiKeys'))).toBe(
      true,
    );
    expect(h.subagents.at(-1)).toEqual({ type: 'finished', id: SUB, status: 'completed' });
    // The sub-agent's text is not the worker's own.
    expect(h.text.join('')).not.toContain('(F:');
  });

  it('stop ends the process tree and reports the running sub-agent as interrupted', async () => {
    const session = await claudeWithPolicy(['--scenario=turn-subagent', '--subagent-hang']);
    const h = handlers();
    const turn = session.runTurn('usa un sotto-agente', h.value);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(h.subagents[0]).toMatchObject({ type: 'started' });
    await turn.stop();
    await expect(turn.done).rejects.toMatchObject({ kind: 'stopped' });
    expect(h.subagents.at(-1)).toEqual({ type: 'finished', id: SUB, status: 'interrupted' });
  });

  it('stops a turn whose init reports another permission mode', async () => {
    const session = await claude(['--permission-mode-reported=acceptEdits']);
    sessions.push(session);
    const error: unknown = await session
      .runTurn('domanda', handlers().value)
      .done.catch((reason: unknown) => reason);
    expect(error).toMatchObject({ kind: 'permission_mode' });
  });

  it('stops on the recorded usage limit (429) with a clear error and no retry', async () => {
    const session = await claude(['--scenario=turn-usage-limit']);
    sessions.push(session);
    const error: unknown = await session
      .runTurn('delega', handlers().value)
      .done.catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(ClaudeError);
    expect(error).toMatchObject({ kind: 'usage_limit' });
    expect((error as Error).message).toMatch(/usage limit reached: You've hit your session limit/);
    expect(turnArgs()).toHaveLength(1);
  });
});

describe('a Codex turn’s input (ADR 0019)', () => {
  it('puts a named skill first, as Codex’s own skill input', () => {
    expect(codexInput('ciao')).toEqual([{ type: 'text', text: 'ciao' }]);
    expect(codexInput('ciao', { name: 'tdd', path: '/s/tdd/SKILL.md' })).toEqual([
      { type: 'skill', name: 'tdd', path: '/s/tdd/SKILL.md' },
      { type: 'text', text: 'ciao' },
    ]);
    expect(codexInput('ciao', { name: 'tdd' })).toEqual([{ type: 'text', text: '$tdd ciao' }]);
  });
});

describe('a Codex leader’s questions (ADR 0019)', () => {
  it('asks only when the session allows it, and hands the answers back in the same turn', async () => {
    const received = join(dir, 'received.jsonl');
    const session = await codex('chatgpt', {
      questions: true,
      launcherArgs: [FAKE_CODEX, '--account=chatgpt', `--log=${received}`],
    });
    const asked: unknown[] = [];
    const h = handlers();
    const result = await session.runTurn('[question] decidi tu', {
      ...h.value,
      onQuestion: (questions) => {
        asked.push(questions);
        return Promise.resolve({ storage: ['In memoria'], name: ['ooc'] });
      },
    }).done;
    expect(asked).toEqual([
      [
        {
          id: 'storage',
          header: 'Bozze',
          question: 'Dove salviamo le bozze?',
          options: [
            { label: 'Con la chat (Recommended)', description: 'Sopravvive alla riapertura' },
            { label: 'In memoria', description: 'Più semplice' },
          ],
          other: true,
          secret: false,
        },
        {
          id: 'name',
          header: 'Nome',
          question: 'Come chiamiamo il comando?',
          options: null,
          other: false,
          secret: false,
        },
      ],
    ]);
    expect(result.text).toBe(
      'risposte={"answers":{"storage":{"answers":["In memoria"]},"name":{"answers":["ooc"]}}}',
    );
    const start = readFileSync(received, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(
        (line) =>
          JSON.parse(line) as { method?: string; params?: { config?: Record<string, unknown> } },
      )
      .find((m) => m.method === 'thread/start');
    expect(start?.params?.config?.['features.default_mode_request_user_input']).toBe(true);
  });

  it('cannot ask without it, and a question left unanswered fails its request', async () => {
    const plain = await codex();
    expect((await plain.runTurn('[question] x', handlers().value).done).text).toBe(
      'Non posso chiedere: rispondo a parole.',
    );
    const asking = await codex('chatgpt', { questions: true });
    const result = await asking.runTurn('[question] x', {
      ...handlers().value,
      onQuestion: () => Promise.resolve(null),
    }).done;
    expect(result.text).toBe('nessuna risposta: The user did not answer');
  });

  it('reads the questions and writes the answers in Codex’s shapes', () => {
    expect(
      codexQuestions({ questions: [{ id: 'a', question: 'Q?', options: [] }, { nope: 1 }] }),
    ).toEqual([
      { id: 'a', header: '', question: 'Q?', options: null, other: false, secret: false },
    ]);
    expect(codexAnswers({ a: ['x'] })).toEqual({ answers: { a: { answers: ['x'] } } });
  });
});

describe('the steps of a turn (ADR 0019)', () => {
  it('reports a Codex turn as it happens; the answer leaves the intermediate messages out', async () => {
    const steps: AgentTurnStep[] = [];
    const session = await codex();
    const result = await session.runTurn('[steps] prova', {
      ...handlers().value,
      onStep: (step) => steps.push(step),
    }).done;
    expect(result.text).toBe('Fatto.');
    const last = new Map(steps.map((s) => [s.id, s]));
    expect([...last.values()]).toEqual([
      { kind: 'message', id: 'c1', text: 'Guardo i file.' },
      { kind: 'reasoning', id: 'r1', text: 'Serve un test.' },
      {
        kind: 'plan',
        id: 'plan',
        explanation: 'Due passi',
        steps: [
          { step: 'Leggere', status: 'completed' },
          { step: 'Provare', status: 'inProgress' },
        ],
      },
      {
        kind: 'command',
        id: 'x1',
        command: 'pnpm test',
        status: 'done',
        exitCode: 0,
        durationMs: 517,
        output: 'ok 3 tests\n',
      },
      {
        kind: 'file',
        id: 'f1',
        status: 'done',
        changes: [
          {
            path: 'calc.py',
            change: 'update',
            added: 2,
            removed: 1,
            diff: '@@ -1 +1,2 @@\n-a = 1\n+a = 2\n+b = 3',
          },
        ],
      },
    ]);
  });

  it('marks a command that exits with an error as failed, and keeps only an output’s tail', () => {
    expect(
      itemStep(
        {
          type: 'commandExecution',
          id: 'x',
          command: ['git', 'push'],
          exitCode: 1,
          status: 'completed',
        },
        true,
      ),
    ).toMatchObject({ kind: 'command', command: 'git push', status: 'failed', exitCode: 1 });
    expect(itemStep({ type: 'webSearch', id: 'w', query: 'vitest' }, false)).toEqual({
      kind: 'tool',
      id: 'w',
      name: 'web',
      detail: 'vitest',
      status: 'running',
    });
    expect(itemStep({ type: 'userMessage', id: 'u' }, true)).toBeUndefined();
    expect(tail('abcdef', 3)).toBe('…def');
    expect(diffCounts('--- a\n+++ b\n-x\n+y\n+z')).toEqual({ added: 2, removed: 1 });
  });

  it('shows Claude’s tool calls as commands, file changes or tools', () => {
    expect(claudeToolStep('t1', 'Bash', { command: 'ls' })).toMatchObject({
      kind: 'command',
      command: 'ls',
    });
    expect(
      claudeToolStep('t2', 'Edit', { file_path: 'a.py', old_string: 'x', new_string: 'y\nz' }),
    ).toEqual({
      kind: 'file',
      id: 't2',
      status: 'running',
      changes: [{ path: 'a.py', change: 'update', added: 2, removed: 1, diff: '-x\n+y\n+z' }],
    });
    expect(claudeToolStep('t3', 'Read', { file_path: 'a.py' })).toEqual({
      kind: 'tool',
      id: 't3',
      name: 'Read',
      detail: 'a.py',
      status: 'running',
    });
  });

  it('sends a streaming step at most every interval, and at once when asked', () => {
    vi.useFakeTimers();
    try {
      const sent: string[] = [];
      const stream = new StepStream(
        (step) => sent.push(step.kind === 'message' ? step.text : ''),
        250,
      );
      stream.put({ kind: 'message', id: 'a', text: 'a' });
      stream.put({ kind: 'message', id: 'a', text: 'ab' });
      expect(sent).toEqual([]);
      vi.advanceTimersByTime(250);
      expect(sent).toEqual(['ab']);
      stream.put({ kind: 'message', id: 'a', text: 'abc' }, true);
      expect(sent).toEqual(['ab', 'abc']);
    } finally {
      vi.useRealTimers();
    }
  });
});
