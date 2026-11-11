// An agent over the Agent Client Protocol (ADR 0023), against the fake
// Antigravity CLI: no account, no quota.

import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  acpOption,
  answersQuota,
  antigravityModelId,
  antigravityModels,
  createAcpAgentFactory,
  listAntigravityModels,
  readAntigravityQuota,
  type AcpAgentConfig,
  type AgentApprovalRequest,
  type AgentSession,
  type AgentTurnStep,
} from '../src/index.js';

const FAKE_AGY = join(import.meta.dirname, 'fixtures', 'fake-agy.mjs');
const sessions: AgentSession[] = [];

afterEach(async () => {
  await Promise.all(sessions.splice(0).map((s) => s.close()));
});

async function open(config: Partial<AcpAgentConfig> = {}, resume?: string) {
  const session = await createAcpAgentFactory({
    executable: process.execPath,
    args: [FAKE_AGY, 'acp'],
    provider: 'Antigravity',
    cwd: import.meta.dirname,
    ...config,
  })({ instructions: '[istruzioni]', ...(resume ? { resume } : {}) });
  sessions.push(session);
  return session;
}

function handlers(decision: 'accept' | 'acceptForSession' | 'decline' = 'decline') {
  const seen = {
    text: '',
    steps: new Map<string, AgentTurnStep>(),
    asked: [] as AgentApprovalRequest[],
  };
  return {
    seen,
    handlers: {
      onText: (chunk: string) => {
        seen.text += chunk;
      },
      onStep: (step: AgentTurnStep) => {
        seen.steps.set(step.id, step);
      },
      onApprovalRequest: (request: AgentApprovalRequest) => {
        seen.asked.push(request);
        return Promise.resolve(decision);
      },
    },
  };
}

describe('ACP agent (ADR 0023)', () => {
  it('opens a session with the model and mode, instructions in the first prompt only', async () => {
    const session = await open({ model: 'fake-flash-low', mode: 'auto' });
    expect(session.name).toBe('Antigravity (fake-flash-low)');
    const one = handlers();
    const first = await session.runTurn('ciao', one.handlers).done;
    expect(first.text).toBe('[fake-flash-low|auto|istruzioni] ECHO: ciao');
    expect(one.seen.text).toBe(first.text);
    expect(first.identity).toMatchObject({ provider: 'Antigravity', model: 'fake-flash-low' });
    expect(first.usage?.byModel['fake-flash-low']).toEqual({
      input: 100,
      cachedInput: 40,
      cacheWrite: 0,
      output: 7,
      reasoning: 3,
    });
    expect([...one.seen.steps.values()]).toEqual([
      { kind: 'reasoning', id: 'r-1', text: 'Penso ancora' },
      {
        kind: 'command',
        id: 't1',
        command: 'dir',
        status: 'done',
        exitCode: null,
        durationMs: null,
        output: 'a.txt',
      },
      {
        kind: 'plan',
        id: 'plan',
        explanation: '',
        steps: [{ step: 'Leggere', status: 'completed' }],
      },
    ]);
    const second = await session.runTurn('di nuovo', handlers().handlers).done;
    expect(second.text).toBe('[fake-flash-low|auto] ECHO: di nuovo');
  });

  it('keeps the agent’s own model when none is chosen, and switches before the next turn', async () => {
    const session = await open();
    expect(session.name).toBe('Antigravity (fake-flash-high)');
    session.setModel?.('fake-pro');
    const result = await session.runTurn('x', handlers().handlers).done;
    expect(result.text).toContain('[fake-pro|default');
    expect(result.identity.model).toBe('fake-pro');
  });

  it('asks the user for a permission and answers with the chosen option', async () => {
    const session = await open();
    const always = handlers('acceptForSession');
    const result = await session.runTurn('PERMESSO', always.handlers).done;
    expect(always.seen.asked).toEqual([{ kind: 'execute', summary: 'rm -rf build' }]);
    expect(result.text).toContain('{"outcome":"selected","optionId":"always"}');
    const no = await session.runTurn('PERMESSO', handlers('decline').handlers).done;
    expect(no.text).toContain('"optionId":"deny"');
  });

  it('declines every permission of a read-only role, nobody asked', async () => {
    const session = await open({ readOnly: true });
    const seen = handlers('accept');
    const result = await session.runTurn('PERMESSO', seen.handlers).done;
    expect(seen.seen.asked).toEqual([]);
    expect(result.text).toContain('"optionId":"deny"');
  });

  it('stops a turn with session/cancel', async () => {
    const session = await open();
    const seen = handlers();
    const turn = session.runTurn('LENTO', seen.handlers);
    await expect.poll(() => seen.seen.text).toContain('inizio');
    await turn.stop();
    expect((await turn.done).text).toContain('inizio');
  });

  it('reopens a session with session/load, without its history or the instructions', async () => {
    const session = await open({}, 'fake-9');
    const seen = handlers();
    const result = await session.runTurn('dopo', seen.handlers).done;
    expect(result.text).toBe('[fake-flash-high|default] ECHO: dopo');
    expect(result.identity.sessionId).toBe('fake-9');
    await expect(open({}, 'other')).rejects.toThrow('Resource not found');
  });

  it('reads the models from `agy models`, and picks permission options by kind', async () => {
    expect(
      await listAntigravityModels({ executable: process.execPath, launcherArgs: [FAKE_AGY] }),
    ).toEqual([
      {
        id: 'fake-flash',
        name: 'Fake Flash',
        efforts: ['low'],
        defaultEffort: 'low',
        isDefault: false,
      },
      { id: 'fake-pro', name: 'Fake Pro', efforts: [], defaultEffort: null, isDefault: false },
    ]);
    expect(antigravityModels('Fetching available models...\nx\tX\n')).toHaveLength(1);
    // The levels of one model, as the real `agy models` lists them, become its reasoning.
    expect(
      antigravityModels(
        [
          'gemini-3.8-flash-high\tGemini 3.8 Flash (High)',
          'gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)',
          'gemini-3.8-flash-low\tGemini 3.8 Flash (Low)',
          'claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)',
          'gpt-oss-120b-medium\tGPT-OSS 120B (Medium)',
        ].join('\n'),
      ),
    ).toEqual([
      {
        id: 'gemini-3.8-flash',
        name: 'Gemini 3.8 Flash',
        efforts: ['low', 'medium', 'high'],
        defaultEffort: 'medium',
        isDefault: false,
      },
      {
        id: 'claude-sonnet-4-6',
        name: 'Claude Sonnet 4.6 (Thinking)',
        efforts: [],
        defaultEffort: null,
        isDefault: false,
      },
      {
        id: 'gpt-oss-120b',
        name: 'GPT-OSS 120B',
        efforts: ['medium'],
        defaultEffort: 'medium',
        isDefault: false,
      },
    ]);
    expect(antigravityModelId('gemini-3.8-flash', 'low')).toBe('gemini-3.8-flash-low');
    expect(antigravityModelId('claude-sonnet-4-6', '')).toBe('claude-sonnet-4-6');
    const options = [{ optionId: 'ok', kind: 'allow_once' }];
    expect(acpOption(options, 'acceptForSession')).toBe('ok');
    expect(acpOption(options, 'decline')).toBeNull();
  });

  it('reads the usage with `agy -p /quota`, no turn, only from an agy that answers it', async () => {
    const options = { executable: process.execPath, launcherArgs: [FAKE_AGY] };
    expect(await readAntigravityQuota(options)).toEqual([
      {
        name: 'Gemini Models',
        windows: [
          { name: 'weekly', usedPercent: 25, resetsAt: Date.parse('2026-11-14T10:00:00Z') / 1000 },
          {
            name: '5h',
            usedPercent: expect.closeTo(10, 6) as unknown,
            resetsAt: Date.parse('2026-11-11T20:00:00Z') / 1000,
          },
        ],
      },
      { name: 'Claude and GPT models', windows: [{ name: '5h', usedPercent: 0, resetsAt: null }] },
    ]);
    // Older than 1.1.11, `/quota` would be a prompt: a turn, and quota spent. Never asked.
    await expect(
      readAntigravityQuota({ ...options, baseEnv: { ...process.env, FAKE_AGY_VERSION: '1.1.10' } }),
    ).rejects.toThrow('non riporta la quota');
    expect(answersQuota('1.5.5\n')).toBe(true);
    expect(answersQuota('1.1.11')).toBe(true);
    expect(answersQuota('1.0.99')).toBe(false);
    expect(answersQuota('dev')).toBe(false);
  });
});
