import { describe, expect, it } from 'vitest';
import type { TaskProgress } from '@only-one-chat/runtime';
import { recoveredProgress } from '../../src/session/task-state.js';

const base: TaskProgress = {
  brief: 'Add a total',
  direct: false,
  step: 'implementation',
  inFlight: false,
  limit: 2,
  used: 0,
};

const settled = 'Recovery note: the last operation has an uncertain outcome.';
const stale = 'Recovery note: workspace inputs changed.';

describe('recoveredProgress', () => {
  it('leaves a settled task on an unchanged folder as it is', () => {
    expect(recoveredProgress(base, { reviewer: true, changed: false })).toEqual([]);
  });

  it.each([
    ['implementation', false, true, 'review'],
    ['implementation', false, false, 'verification'],
    ['review', false, true, 'review'],
    ['verification', false, true, 'review'],
    ['verification', true, true, 'verification'],
    ['delivery', false, false, 'delivery'],
  ] as const)(
    'settles an interrupted %s (answer %s, reviewer %s) on %s',
    (step, answered, reviewer, expected) => {
      const progress: TaskProgress = {
        ...base,
        step,
        inFlight: true,
        ...(answered
          ? {
              answer: { text: '', review: null, findings: null, restored: '', handoff: undefined },
            }
          : {}),
      };
      const [next, ...rest] = recoveredProgress(progress, { reviewer, changed: false });
      expect(rest).toEqual([]);
      expect(next?.step).toBe(expected);
      expect(next?.inFlight).toBe(false);
      expect(next?.findings).toContain(settled);
    },
  );

  it('says an interrupted implementation was cut short, and keeps a report it had', () => {
    const [cut] = recoveredProgress(
      { ...base, inFlight: true },
      { reviewer: false, changed: false },
    );
    expect(cut?.work).toEqual({
      text: expect.stringContaining('was interrupted') as string,
      data: null,
    });
    const work = { text: 'Done', data: null };
    const [kept] = recoveredProgress(
      { ...base, step: 'review', inFlight: true, work, findings: 'Old' },
      { reviewer: true, changed: false },
    );
    expect(kept?.work).toBe(work);
    expect(kept?.findings?.startsWith('Old\n\n')).toBe(true);
  });

  it('saves the settled state, then marks the results stale when the folder changed', () => {
    const states = recoveredProgress(
      {
        ...base,
        step: 'delivery',
        inFlight: true,
        leaderDelivered: true,
        result: { facts: 'F' },
        work: { text: 'Done', data: null },
      },
      { reviewer: true, changed: true },
    );
    expect(states.map((s) => s.step)).toEqual(['delivery', 'review']);
    const last = states[1];
    expect(last?.result).toBeUndefined();
    expect(last?.answer).toBeUndefined();
    expect(last?.leaderDelivered).toBe(false);
    expect(last?.findings).toContain(settled);
    expect(last?.findings).toContain(stale);
  });

  it('verifies instead of reviewing a blocked report, or with no reviewer', () => {
    const blocked = { text: 'Blocked', data: { outcome: 'blocked' } } as TaskProgress['work'];
    const [a] = recoveredProgress({ ...base, work: blocked }, { reviewer: true, changed: true });
    const [b] = recoveredProgress(base, { reviewer: false, changed: true });
    expect(a?.step).toBe('verification');
    expect(b?.step).toBe('verification');
    expect(b?.work?.text).toBe('Inspect the current files against the approved request.');
  });
});
