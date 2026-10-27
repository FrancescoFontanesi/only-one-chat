import { describe, expect, it } from 'vitest';
import type { ThreadUpdate } from '../../src/webview/protocol.js';
import { applyUpdate, formatTokens, type ThreadItem } from '../../webview/state.js';

function apply(updates: ThreadUpdate[]): ThreadItem[] {
  return updates.reduce<ThreadItem[]>(applyUpdate, []);
}

describe('the webview thread', () => {
  it('streams a turn, then completes it with label and usage', () => {
    const items = apply([
      { type: 'user', id: 'u-1', text: 'ciao' },
      { type: 'turn', id: 't-2', role: 'leader', agent: 'Codex', status: 'running' },
      { type: 'chunk', turnId: 't-2', text: 'Ris' },
      { type: 'chunk', turnId: 't-2', text: 'posta' },
      { type: 'activity', turnId: 't-2', text: 'command: python -m unittest' },
      {
        type: 'turn',
        id: 't-2',
        role: 'leader',
        agent: 'Codex',
        status: 'done',
        label: 'Codex · gpt-6.1-sol',
        text: 'Risposta finale',
        usage: { context: 25_160, output: 175, costUsd: null, durationMs: 9_000 },
      },
    ]);
    expect(items).toHaveLength(2);
    expect(items[1]).toMatchObject({
      kind: 'turn',
      status: 'done',
      label: 'Codex · gpt-6.1-sol',
      text: 'Risposta finale',
      activity: ['command: python -m unittest'],
    });
  });

  it('keeps a turn done when the host closes the running ones as failed', () => {
    const items = apply([
      { type: 'turn', id: 't-1', role: 'implementer', agent: 'Claude', status: 'running' },
      { type: 'turn', id: 't-1', role: 'implementer', agent: 'Claude', status: 'done', text: 'ok' },
      { type: 'turn', id: 't-1', role: 'implementer', agent: '', status: 'failed' },
    ]);
    expect(items[0]).toMatchObject({ status: 'done', agent: 'Claude', text: 'ok' });
  });

  it('updates a sub-agent row in place, and closes an approval', () => {
    const items = apply([
      { type: 'turn', id: 't-1', role: 'leader', agent: 'Codex', status: 'running' },
      { type: 'subagent', turnId: 't-1', id: 's1', label: 'Luna · in corso', status: 'running' },
      {
        type: 'subagent',
        turnId: 't-1',
        id: 's1',
        label: 'Luna · completato',
        status: 'completed',
      },
      {
        type: 'approval',
        id: 'a-2',
        kind: 'delegation',
        from: 'Codex',
        to: 'Claude',
        text: 'brief',
      },
      { type: 'approval_closed', id: 'a-2', action: 'approve' },
    ]);
    expect(items[0]).toMatchObject({ subagents: [{ id: 's1', label: 'Luna · completato' }] });
    expect(items[1]).toMatchObject({ kind: 'approval', closed: 'approve' });
  });

  it('formats token counts compactly', () => {
    expect(formatTokens(950)).toBe('950');
    expect(formatTokens(2_663)).toBe('2.7k');
    expect(formatTokens(348_000)).toBe('348k');
  });
});
