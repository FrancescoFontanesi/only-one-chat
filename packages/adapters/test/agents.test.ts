// The Codex and Claude agent sessions the runtime drives, against the fake
// app-server and the fake Claude CLI.

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ClaudeError,
  CodexAuthError,
  CodexSubagentError,
  NO_SUBAGENTS_CONFIG,
  createClaudeAgentFactory,
  createCodexAgentFactory,
  declineResponse,
  type AgentApprovalRequest,
  type AgentSession,
  type AgentTurnHandlers,
} from '../src/index.js';

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
  const value: AgentTurnHandlers = {
    onText: (chunk) => text.push(chunk),
    onApprovalRequest: (request) => {
      approvals.push(request);
      return Promise.resolve('decline');
    },
    onActivity: ({ kind }) => activity.push(kind),
  };
  return { value, text, approvals, activity };
}

async function codex(account = 'chatgpt', extra: Record<string, unknown> = {}) {
  const session = await createCodexAgentFactory({
    executable: process.execPath,
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
    });
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

  it('switches native sub-agents off for the thread only, and stops a turn that starts one', async () => {
    const received = join(dir, 'received.jsonl');
    const session = await codex('chatgpt', {
      launcherArgs: [FAKE_CODEX, '--account=chatgpt', `--log=${received}`],
      nativeSubagents: false,
    });
    const h = handlers();
    const error: unknown = await session
      .runTurn('[subagent] chiedi a Claude', h.value)
      .done.catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(CodexSubagentError);
    expect((error as Error).message).toMatch(/subAgentActivity/);
    expect(h.activity).toContain('subagent');
    const messages = readFileSync(received, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { method?: string; params?: Record<string, unknown> });
    expect(messages.find((m) => m.method === 'thread/start')?.params?.['config']).toEqual(
      NO_SUBAGENTS_CONFIG,
    );
    expect(messages.map((m) => m.method)).toContain('turn/interrupt');
    expect(messages.find((m) => m.method === 'thread/start')?.params).not.toHaveProperty(
      'model_reasoning_effort',
    );
  });

  it('holds sub-agents to the policy with per-thread overrides only', async () => {
    const received = join(dir, 'received.jsonl');
    const session = await createCodexAgentFactory({
      executable: process.execPath,
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
      baseEnv: { ...process.env },
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
      baseEnv: { ...process.env, CLAUDE_CODE_SUBAGENT_MODEL: 'claude-opus-from-user' },
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
    });
    expect(tools(second?.argv)).toBe('Read,Grep,Glob');
    expect(second?.argv).not.toContain('--forward-subagent-text');
    expect(second?.env?.['CLAUDE_CODE_SUBAGENT_MODEL_FORCE']).toBeUndefined();
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
