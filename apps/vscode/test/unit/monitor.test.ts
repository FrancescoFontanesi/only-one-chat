import { describe, expect, it } from 'vitest';
import { MonitorStore } from '../../src/session/monitor.js';
import type { RoleInfo } from '../../src/webview/protocol.js';

const ROLES: Record<'leader' | 'implementer', RoleInfo> = {
  leader: {
    cli: 'codex',
    model: 'gpt-6.1-sol',
    modelName: 'GPT-6.1-Sol',
    effort: 'low',
    permission: 'auto',
  },
  implementer: {
    cli: 'claude',
    model: 'sonnet',
    modelName: 'Sonnet 5.5',
    effort: 'low',
    permission: 'auto',
  },
};

describe('activity view (ADR 0012)', () => {
  it('shows who works, who waits for the user, and the log latest first', () => {
    let clock = 0;
    const store = new MonitorStore(() => ++clock);
    store.setRoles(ROLES);
    store.apply({ type: 'user', id: 'u-1', text: 'aggiungi round' });
    store.apply({
      type: 'turn',
      id: 't-1',
      role: 'leader',
      agent: 'Codex (gpt-6.1-sol)',
      status: 'running',
    });
    store.apply({ type: 'activity', turnId: 't-1', text: 'command: rg round' });
    store.apply({
      type: 'subagent',
      turnId: 't-1',
      id: 's-1',
      label: 'explorer',
      status: 'running',
    });
    let state = store.snapshot();
    expect(state.agents.map((a) => [a.role, a.status])).toEqual([
      ['leader', 'working'],
      ['implementer', 'idle'],
    ]);
    expect(state.agents[0]).toMatchObject({
      activity: 'command: rg round',
      subagents: ['explorer'],
    });

    store.apply({
      type: 'permission',
      id: 'p-1',
      role: 'leader',
      agent: 'Codex',
      summary: 'git push',
    });
    expect(store.snapshot().agents[0]?.status).toBe('waiting');
    store.apply({ type: 'permission_closed', id: 'p-1', decision: 'decline' });
    store.apply({
      type: 'turn',
      id: 't-1',
      role: 'leader',
      agent: 'Codex (gpt-6.1-sol)',
      status: 'done',
      usage: { context: 25_400, output: 300, costUsd: null, durationMs: 4200 },
    });
    state = store.snapshot();
    expect(state.agents[0]).toMatchObject({ status: 'idle', activity: null, subagents: [] });
    expect(state.events.map((e) => e.text)).toEqual([
      'Leader ha finito · contesto 25k · 4.2 s',
      'Permesso negato',
      'Leader chiede il permesso: git push',
      'Leader ↳ sotto-agente explorer',
      'Leader lavora · Codex (gpt-6.1-sol)',
      'Tu → Leader: aggiungi round',
    ]);
  });

  it('names a direct message to the implementer, and starts empty for another chat', () => {
    const store = new MonitorStore();
    store.setRoles(ROLES);
    store.apply({ type: 'user', id: 'u-1', text: '@impl aggiungi round' });
    expect(store.snapshot().events[0]?.text).toBe('Tu → Implementatore: aggiungi round');
    store.reset();
    expect(store.snapshot().events).toEqual([]);
  });

  it('closes nothing it did not open: a replayed end is not logged', () => {
    const store = new MonitorStore();
    store.setRoles(ROLES);
    store.apply({ type: 'turn', id: 't-9', role: 'implementer', agent: '', status: 'failed' });
    store.apply({ type: 'permission_closed', id: 'p-9', decision: 'interrupted' });
    expect(store.snapshot().events).toEqual([]);
  });
});
