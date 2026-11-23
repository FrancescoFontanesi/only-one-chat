import { describe, expect, it } from 'vitest';
import type { AgentQuestion } from '@only-one-chat/runtime';
import { UserRequests } from '../../src/session/user-requests.js';
import type { ThreadUpdate } from '../../src/webview/protocol.js';

const question = (id: string, secret: boolean): AgentQuestion => ({
  id,
  header: id,
  question: `${id}?`,
  options: null,
  other: true,
  secret,
});

function requests() {
  const updates: ThreadUpdate[] = [];
  let next = 0;
  const box = new UserRequests(
    (prefix) => `${prefix}${String(++next)}`,
    (update) => {
      updates.push(update);
    },
  );
  return { box, updates };
}

describe('UserRequests', () => {
  it('hands the agent every answer and shows the secret ones masked', async () => {
    const { box, updates } = requests();
    const answers = box.ask('leader', 'Codex', [question('name', false), question('token', true)]);
    box.answer('q1', { name: ['Ada'], token: ['s3cret', 'again'] });
    expect(await answers).toEqual({ name: ['Ada'], token: ['s3cret', 'again'] });
    expect(updates.at(-1)).toEqual({
      type: 'question_closed',
      id: 'q1',
      outcome: 'answered',
      answers: { name: ['Ada'], token: ['••••', '••••'] },
    });
    expect(JSON.stringify(updates)).not.toContain('s3cret');
  });

  it('declines every permission and question still open, once', async () => {
    const { box, updates } = requests();
    const permission = box.askPermission('implementer', 'Claude', 'run pnpm test');
    const answers = box.ask('leader', 'Codex', [question('why', false)]);
    box.declineAll();
    expect(await permission).toBe('decline');
    expect(await answers).toBeNull();
    expect(updates.slice(2)).toEqual([
      { type: 'permission_closed', id: 'p1', decision: 'decline' },
      { type: 'question_closed', id: 'q2', outcome: 'declined' },
    ]);
    box.declineAll();
    box.permit('p1', 'accept');
    box.answer('q2', { why: ['late'] });
    expect(updates).toHaveLength(4);
  });

  it('declines a request when its turn stops', async () => {
    const { box, updates } = requests();
    const stop = new AbortController();
    const permission = box.askPermission('implementer', 'Claude', 'write', stop.signal);
    stop.abort();
    expect(await permission).toBe('decline');
    expect(updates.at(-1)).toEqual({ type: 'permission_closed', id: 'p1', decision: 'decline' });
  });
});
