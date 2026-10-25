// The Codex and Claude agent sessions the runtime drives, against the fake
// app-server and the fake Claude CLI.

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ClaudeError,
  CodexAuthError,
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
