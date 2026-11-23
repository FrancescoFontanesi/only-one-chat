import { describe, expect, it } from 'vitest';
import { GATE_SENT_BACK_HEADER, type ThreadEvent } from '@only-one-chat/runtime';
import { TurnTracker } from '../../src/session/thread-projection.js';
import type { ThreadUpdate } from '../../src/webview/protocol.js';

function tracker() {
  const updates: ThreadUpdate[] = [];
  const turns = new TurnTracker((update) => {
    updates.push(update);
  });
  return { turns, updates };
}

const event = (e: object) => e as ThreadEvent;

describe('TurnTracker', () => {
  it("puts a role's text and activity on its running turn, and drops them with none", () => {
    const { turns, updates } = tracker();
    turns.project(event({ type: 'text', role: 'worker', text: 'lost' }));
    expect(updates).toEqual([]);
    turns.start('implementer', 't1', 'Claude');
    turns.project(event({ type: 'text', role: 'worker', text: 'hi' }));
    turns.project(
      event({
        type: 'subagent_activity',
        role: 'worker',
        kind: 'command',
        detail: 'x'.repeat(300),
      }),
    );
    turns.project(event({ type: 'text', role: 'orchestrator', text: 'not this turn' }));
    expect(updates).toEqual([
      { type: 'turn', id: 't1', role: 'implementer', agent: 'Claude', status: 'running' },
      { type: 'chunk', turnId: 't1', text: 'hi' },
      { type: 'activity', turnId: 't1', text: `↳ command: ${'x'.repeat(240)}` },
    ]);
  });

  it('shows notices that need no turn', () => {
    const { turns, updates } = tracker();
    turns.project(event({ type: 'gate_sent_back', status: 'failed', summary: '2 tests' }));
    turns.project(
      event({ type: 'reviewed', reviewer: 'Codex', verdict: null, rounds: 1, verification: '' }),
    );
    turns.project(event({ type: 'delegation_invalid', errors: ['a', 'b'] }));
    turns.project(event({ type: 'intercepted', message: {} }));
    expect(updates).toEqual([
      { type: 'notice', level: 'warn', text: `${GATE_SENT_BACK_HEADER}\nfailed — 2 tests` },
      { type: 'notice', level: 'warn', text: 'Review by Codex: NO VERDICT · 1 correction round' },
      { type: 'notice', level: 'warn', text: 'Invalid delegation call: a; b' },
    ]);
  });

  it('closes the turns still running, once, and forgets an ended one', () => {
    const { turns, updates } = tracker();
    turns.start('leader', 't1', 'Codex');
    turns.start('implementer', 't2', 'Claude');
    expect(turns.end('leader')).toBe('t1');
    expect(turns.end('leader')).toBeUndefined();
    turns.closeRunning('failed');
    turns.closeRunning('failed');
    expect(updates.slice(2)).toEqual([
      { type: 'turn', id: 't2', role: 'implementer', agent: '', status: 'failed' },
    ]);
  });
});
