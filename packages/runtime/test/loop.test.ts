// The D6 loop with deterministic fake agents: no process, no quota.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  APPROVAL_DENIED_MESSAGE,
  openEventLog,
  runLoop,
  type InterceptDecision,
  type InterceptedMessage,
  type LoggedEvent,
  type LoopOptions,
  type MalformedDecision,
  type ThreadEvent,
} from '../src/index.js';
import { delegationBlock, fakeAgent, type FakeAgent } from './fake-agents.js';

let dir: string;
let logPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'loop '));
  logPath = join(dir, 'logs', 'conversation.jsonl');
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function logged(): LoggedEvent[] {
  return readFileSync(logPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as LoggedEvent);
}

interface Harness {
  readonly intercepted: InterceptedMessage[];
  readonly events: ThreadEvent[];
  readonly malformed: { errors: readonly string[] }[];
}

async function loop(
  orchestrator: FakeAgent,
  worker: FakeAgent,
  decisions: InterceptDecision[] = [],
  malformedDecisions: MalformedDecision[] = [],
  extra: Partial<LoopOptions> = {},
) {
  const harness: Harness = { intercepted: [], events: [], malformed: [] };
  const running = runLoop({
    request: 'Analizza executable.ts e proponi miglioramenti; Claude verifica le proposte',
    orchestrator: orchestrator.factory,
    worker: worker.factory,
    log: await openEventLog(logPath, join(dir, 'workspace')),
    intercept: (message) => {
      harness.intercepted.push(message);
      return Promise.resolve(decisions.shift() ?? { action: 'approve' });
    },
    onMalformedDelegation: (problem) => {
      harness.malformed.push(problem);
      return Promise.resolve(malformedDecisions.shift() ?? { action: 'cancel' });
    },
    onEvent: (event) => harness.events.push(event),
    ...extra,
  });
  return { running, harness };
}

describe('a valid delegation', () => {
  it('goes orchestrator → approved delegation → worker → approved review → conclusion', async () => {
    const codex = fakeAgent('Codex', [
      { answer: delegationBlock() },
      { answer: 'Conclusione finale.' },
    ]);
    const claude = fakeAgent('Claude', [{ answer: 'Proposte 1 e 2 confermate.' }]);
    const { running, harness } = await loop(codex, claude);

    expect(await running.done).toEqual({
      status: 'completed',
      conclusion: 'Conclusione finale.',
      exchanges: 1,
    });
    expect(harness.intercepted.map((m) => [m.kind, m.from, m.to])).toEqual([
      ['delegation', 'Codex', 'Claude'],
      ['review', 'Claude', 'Codex'],
    ]);
    // The worker receives the block body; the orchestrator the review with the result.
    expect(claude.prompts).toEqual([harness.intercepted[0]?.text]);
    expect(claude.prompts[0]).toMatch(/^## Obiettivo/);
    expect(codex.prompts[1]).toContain('Proposte 1 e 2 confermate.');
    expect(codex.prompts[1]).toContain('scambio 1 di 3');
  });

  it('passes role instructions from the runtime, with the delegation format', async () => {
    const codex = fakeAgent('Codex', [{ answer: delegationBlock() }, { answer: 'Fine.' }]);
    const claude = fakeAgent('Claude', [{ answer: 'Ok.' }]);
    await (
      await loop(codex, claude)
    ).running.done;
    expect(codex.instructions[0]).toContain('<<<DELEGA');
    expect(codex.instructions[0]).toContain('## Output atteso');
    expect(claude.instructions[0]).toMatch(/sola lettura/);
  });

  it('streams text and logs every message, decision and the outcome as JSONL', async () => {
    const codex = fakeAgent('Codex', [{ answer: delegationBlock() }, { answer: 'Fine.' }]);
    const claude = fakeAgent('Claude', [{ answer: 'Verificato.' }]);
    const { running, harness } = await loop(codex, claude);
    await running.done;

    expect(harness.events.filter((e) => e.type === 'text' && e.role === 'worker')).toHaveLength(2);
    const types = logged().map((event) => event.type);
    expect(types).toEqual([
      'loop_started',
      'turn_started',
      'message',
      'intercepted',
      'decision',
      'turn_started',
      'message',
      'intercepted',
      'decision',
      'turn_started',
      'message',
      'finished',
    ]);
    expect(logged().map((event) => event.seq)).toEqual(types.map((_t, i) => i + 1));
  });

  it('closes both sessions at the end', async () => {
    const codex = fakeAgent('Codex', [{ answer: delegationBlock() }, { answer: 'Fine.' }]);
    const claude = fakeAgent('Claude', [{ answer: 'Ok.' }]);
    await (
      await loop(codex, claude)
    ).running.done;
    expect([codex.closed, claude.closed]).toEqual([true, true]);
  });
});

describe('the user in the middle', () => {
  it('forwards the edited delegation, not the original, and logs the edit', async () => {
    const codex = fakeAgent('Codex', [{ answer: delegationBlock() }, { answer: 'Fine.' }]);
    const claude = fakeAgent('Claude', [{ answer: 'Ok.' }]);
    const { running } = await loop(codex, claude, [{ action: 'edit', text: 'Delega modificata' }]);
    await running.done;

    expect(claude.prompts).toEqual(['Delega modificata']);
    expect(logged()).toContainEqual(
      expect.objectContaining({
        type: 'decision',
        kind: 'delegation',
        action: 'edit',
        text: 'Delega modificata',
      }),
    );
  });

  it('forwards an edited review message to the orchestrator', async () => {
    const codex = fakeAgent('Codex', [{ answer: delegationBlock() }, { answer: 'Fine.' }]);
    const claude = fakeAgent('Claude', [{ answer: 'Ok.' }]);
    const { running } = await loop(codex, claude, [
      { action: 'approve' },
      { action: 'edit', text: 'Review modificata' },
    ]);
    await running.done;
    expect(codex.prompts[1]).toBe('Review modificata');
  });

  it('cancelling the delegation reaches no agent', async () => {
    const codex = fakeAgent('Codex', [{ answer: delegationBlock() }]);
    const claude = fakeAgent('Claude', []);
    const { running } = await loop(codex, claude, [{ action: 'cancel' }]);
    expect(await running.done).toEqual({ status: 'cancelled', at: 'delegation' });
    expect(claude.prompts).toEqual([]);
    expect(codex.prompts).toHaveLength(1);
  });

  it('cancelling the review sends nothing back to the orchestrator', async () => {
    const codex = fakeAgent('Codex', [{ answer: delegationBlock() }]);
    const claude = fakeAgent('Claude', [{ answer: 'Ok.' }]);
    const { running } = await loop(codex, claude, [{ action: 'approve' }, { action: 'cancel' }]);
    expect(await running.done).toEqual({ status: 'cancelled', at: 'review' });
    expect(codex.prompts).toHaveLength(1);
  });
});

describe('a malformed delegation', () => {
  const malformed = delegationBlock().replace('## Vincoli\nSola lettura.\n', '');

  it('is not forwarded: the error is shown and the user cancels', async () => {
    const codex = fakeAgent('Codex', [{ answer: malformed }]);
    const claude = fakeAgent('Claude', []);
    const { running, harness } = await loop(codex, claude);

    expect(await running.done).toEqual({ status: 'cancelled', at: 'malformed' });
    expect(harness.malformed[0]?.errors.join(' ')).toMatch(/Vincoli/);
    expect(harness.events.some((e) => e.type === 'delegation_invalid')).toBe(true);
    expect(claude.prompts).toEqual([]);
    expect(harness.intercepted).toEqual([]);
  });

  it('can be sent back to the orchestrator to fix, then proceeds', async () => {
    const codex = fakeAgent('Codex', [
      { answer: malformed },
      { answer: delegationBlock() },
      { answer: 'Fine.' },
    ]);
    const claude = fakeAgent('Claude', [{ answer: 'Ok.' }]);
    const { running } = await loop(codex, claude, [], [{ action: 'ask_orchestrator' }]);
    expect(await running.done).toMatchObject({ status: 'completed', exchanges: 1 });
    expect(codex.prompts[1]).toMatch(/non rispetta il formato/);
  });

  it('can be replaced by the user, and the replacement is still intercepted', async () => {
    const codex = fakeAgent('Codex', [{ answer: malformed }, { answer: 'Fine.' }]);
    const claude = fakeAgent('Claude', [{ answer: 'Ok.' }]);
    const { running, harness } = await loop(
      codex,
      claude,
      [],
      [{ action: 'edit', text: 'Delega scritta a mano' }],
    );
    await running.done;
    expect(harness.intercepted[0]?.text).toBe('Delega scritta a mano');
    expect(claude.prompts).toEqual(['Delega scritta a mano']);
  });
});

describe('stop', () => {
  it('interrupts the running worker turn and ends with stopped', async () => {
    const codex = fakeAgent('Codex', [{ answer: delegationBlock() }]);
    const claude = fakeAgent('Claude', [{ hang: true }]);
    const { running } = await loop(codex, claude);
    await claude.turnStarted();

    await running.stop();
    expect(await running.done).toEqual({ status: 'stopped' });
    expect(claude.stops).toBe(1);
    expect([codex.closed, claude.closed]).toEqual([true, true]);
    expect(logged().map((e) => e.type)).toContain('stop_requested');
    await running.stop(); // idempotent
  });

  it('interrupts the orchestrator turn', async () => {
    const codex = fakeAgent('Codex', [{ hang: true }]);
    const claude = fakeAgent('Claude', []);
    const { running } = await loop(codex, claude);
    await codex.turnStarted();
    await running.stop();
    expect(await running.done).toEqual({ status: 'stopped' });
    expect(codex.stops).toBe(1);
  });

  it('ends a loop waiting for the user, even if the prompt ignores the signal', async () => {
    const codex = fakeAgent('Codex', [{ answer: delegationBlock() }]);
    const claude = fakeAgent('Claude', []);
    let shown!: () => void;
    const waiting = new Promise<void>((resolve) => (shown = resolve));
    const { running } = await loop(codex, claude, [], [], {
      intercept: () => {
        shown();
        return new Promise<InterceptDecision>(() => undefined);
      },
    });
    await waiting;
    await running.stop();
    expect(await running.done).toEqual({ status: 'stopped' });
    expect(claude.prompts).toEqual([]);
  });
});

describe('approvals requested by an agent', () => {
  it('are declined and shown in the thread as not supported', async () => {
    const codex = fakeAgent('Codex', [
      { approval: 'git status', answer: delegationBlock() },
      { answer: 'Fine.' },
    ]);
    const claude = fakeAgent('Claude', [{ answer: 'Ok.' }]);
    const { running, harness } = await loop(codex, claude);
    await running.done;

    expect(codex.decisions).toEqual(['decline']);
    expect(harness.events).toContainEqual(
      expect.objectContaining({
        type: 'approval_denied',
        role: 'orchestrator',
        message: APPROVAL_DENIED_MESSAGE,
      }),
    );
    expect(logged().map((e) => e.type)).toContain('approval_denied');
  });
});

describe('limits', () => {
  it('stops after three exchanges even if the orchestrator keeps delegating', async () => {
    const codex = fakeAgent(
      'Codex',
      Array.from({ length: 4 }, () => ({ answer: delegationBlock() })),
    );
    const claude = fakeAgent(
      'Claude',
      Array.from({ length: 3 }, () => ({ answer: 'Ok.' })),
    );
    const { running } = await loop(codex, claude, [], [], { maxExchanges: 10 });
    expect(await running.done).toMatchObject({ status: 'limit_reached', exchanges: 3 });
    expect(claude.prompts).toHaveLength(3);
    expect(codex.prompts[3]).toMatch(/ultimo scambio/);
  });

  it('reports a failing agent turn as failed and logs the error', async () => {
    const codex = fakeAgent('Codex', []);
    const claude = fakeAgent('Claude', []);
    const { running } = await loop(codex, claude);
    expect(await running.done).toMatchObject({ status: 'failed' });
    expect(logged().map((e) => e.type)).toContain('error');
  });
});

describe('event log', () => {
  it('refuses a path inside the workspace, or a relative one', async () => {
    await expect(
      openEventLog(join(dir, 'workspace', 'log.jsonl'), join(dir, 'workspace')),
    ).rejects.toThrow(/outside the workspace/);
    await expect(openEventLog('log.jsonl', join(dir, 'workspace'))).rejects.toThrow(/absolute/);
  });
});
