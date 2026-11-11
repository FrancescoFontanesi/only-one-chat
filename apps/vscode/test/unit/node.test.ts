// A node of Squad's board (ADR 0023) against the fake Antigravity CLI: its own
// thread, its permissions from the dial, stop and reopening. No quota.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NodeSession, nodeInstructions, nodesOf, type NodeChoice } from '../../src/session/node.js';
import { parseWebviewMessage, type ThreadUpdate } from '../../src/webview/protocol.js';

const FAKE_AGY = join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  '..',
  'packages',
  'adapters',
  'test',
  'fixtures',
  'fake-agy.mjs',
);

let cwd: string;
const open: NodeSession[] = [];

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'node '));
});
afterEach(async () => {
  await Promise.all(open.splice(0).map((n) => n.close()));
  rmSync(cwd, { recursive: true, force: true, maxRetries: 5 });
});

const GEMINI: NodeChoice = {
  id: 'n-1',
  name: 'Gemini',
  cli: 'antigravity',
  model: 'fake-flash-low',
  effort: '',
  permission: 'read-only',
};

function node(choice: Partial<NodeChoice> = {}, resume?: string) {
  const updates: ThreadUpdate[] = [];
  const sessions: string[] = [];
  const session = new NodeSession(
    {
      cwd,
      node: { ...GEMINI, ...choice },
      codexExecutable: '',
      claudeExecutable: '',
      antigravityExecutable: process.execPath,
      antigravityLauncherArgs: [FAKE_AGY],
      allowedCommands: [],
      ...(resume ? { resume } : {}),
    },
    {
      update: (u) => {
        updates.push(u);
        // The user answers a permission as soon as it is asked.
        if (u.type === 'permission') session.permit(u.id, 'accept');
      },
      busy: () => undefined,
      sessionId: (id) => sessions.push(id),
    },
  );
  open.push(session);
  return { session, updates, sessions };
}

const done = (updates: readonly ThreadUpdate[]) =>
  updates.filter(
    (u): u is Extract<ThreadUpdate, { type: 'turn' }> => u.type === 'turn' && u.status === 'done',
  );

describe('a node of the board (ADR 0023)', () => {
  it('answers in its own thread, with its instructions first and its model', async () => {
    const { session, updates, sessions } = node();
    await session.send('ciao');
    expect(updates[0]).toMatchObject({ type: 'user', text: 'ciao' });
    const [turn] = done(updates);
    expect(turn).toMatchObject({ agent: 'Antigravity (fake-flash-low)', role: 'implementer' });
    expect(turn?.text).toBe('[fake-flash-low|default|istruzioni] ECHO: ciao');
    expect(turn?.usage).toMatchObject({ context: 140, output: 7 });
    expect(sessions).toEqual(['fake-1']);
    await session.send('ancora');
    expect(done(updates)[1]?.text).toBe('[fake-flash-low|default] ECHO: ancora');
  });

  it('a read-only node is denied by its role; one that asks gets the user’s answer', async () => {
    const reader = node();
    await reader.session.send('PERMESSO');
    expect(reader.updates.some((u) => u.type === 'permission')).toBe(false);
    expect(done(reader.updates)[0]?.text).toContain('"optionId":"deny"');

    const asker = node({ permission: 'ask' });
    await asker.session.send('PERMESSO');
    expect(asker.updates).toContainEqual(
      expect.objectContaining({ type: 'permission', summary: 'rm -rf build' }),
    );
    expect(asker.updates).toContainEqual(
      expect.objectContaining({ type: 'permission_closed', decision: 'accept' }),
    );
    expect(done(asker.updates)[0]?.text).toContain('"optionId":"allow"');
  });

  it('auto is the agent’s own auto mode', async () => {
    const { session, updates } = node({ permission: 'auto' });
    await session.send('x');
    expect(done(updates)[0]?.text).toContain('[fake-flash-low|auto|istruzioni]');
  });

  it('stops a running turn', async () => {
    const { session, updates } = node();
    const sent = session.send('LENTO');
    await expect.poll(() => updates.some((u) => u.type === 'chunk')).toBe(true);
    expect(session.busy).toBe(true);
    await session.stop();
    await sent;
    expect(session.busy).toBe(false);
    expect(done(updates)[0]?.text).toContain('inizio');
  });

  it('reopens its session, and starts anew when its provider or permission changes', async () => {
    const { session, updates } = node({}, 'fake-7');
    await session.send('dopo');
    // The node's model is set again on the reopened session; no instructions this time.
    expect(done(updates)[0]?.text).toBe('[fake-flash-low|default] ECHO: dopo');
    await session.configure({ ...GEMINI, permission: 'auto' });
    await session.send('nuova');
    expect(done(updates)[1]?.text).toBe('[fake-flash-low|auto|istruzioni] ECHO: nuova');
  });

  it('shows the files it changed', async () => {
    const { session, updates } = node({ permission: 'auto' });
    const sent = session.send('LENTO');
    await expect.poll(() => updates.some((u) => u.type === 'chunk')).toBe(true);
    writeFileSync(join(cwd, 'nuovo.txt'), 'x');
    await session.stop();
    await sent;
    expect(updates.at(-1)).toMatchObject({
      type: 'notice',
      text: expect.stringContaining('nuovo.txt') as unknown,
    });
  });

  it('tells a read-only node to read with its own tools', () => {
    expect(nodeInstructions(GEMINI)).toContain('sola lettura');
    expect(nodeInstructions({ ...GEMINI, permission: 'ask' })).not.toContain('sola lettura');
  });

  it('reads the nodes of the settings, read-only unless they say otherwise', () => {
    expect(
      nodesOf([
        { id: 'n-1', name: ' Gemini ', cli: 'antigravity', model: 'm' },
        { id: 'n-1', name: 'doppio', cli: 'codex', model: 'm' },
        { id: 'N 2', name: 'x', cli: 'codex', model: 'm' },
        { id: 'n-3', name: 'x', cli: 'cursor', model: 'm' },
        { id: 'n-4', name: 'Sol', cli: 'codex', model: 'gpt', effort: 'low', permission: 'auto' },
        'x',
      ]),
    ).toEqual([
      { ...GEMINI, model: 'm' },
      { id: 'n-4', name: 'Sol', cli: 'codex', model: 'gpt', effort: 'low', permission: 'auto' },
    ]);
    expect(nodesOf(undefined)).toEqual([]);
    // Saved with the level in the model id: read as the model and its reasoning.
    expect(
      nodesOf([{ id: 'n-5', name: 'G', cli: 'antigravity', model: 'gemini-3.8-flash-high' }]),
    ).toEqual([
      {
        id: 'n-5',
        name: 'G',
        cli: 'antigravity',
        model: 'gemini-3.8-flash',
        effort: 'high',
        permission: 'read-only',
      },
    ]);
  });

  it('validates the webview’s node messages', () => {
    expect(parseWebviewMessage({ type: 'send', text: 'ciao', node: 'n-1' })).toEqual({
      type: 'send',
      text: 'ciao',
      node: 'n-1',
    });
    expect(parseWebviewMessage({ type: 'send', text: 'x', node: 'n-1', to: 'leader' })).toBe(
      undefined,
    );
    expect(parseWebviewMessage({ type: 'send', text: 'x', node: '../x' })).toBe(undefined);
    expect(parseWebviewMessage({ type: 'stop', node: 'n-1' })).toEqual({
      type: 'stop',
      node: 'n-1',
    });
    expect(parseWebviewMessage({ type: 'addNode', cli: 'antigravity', model: 'g-1' })).toEqual({
      type: 'addNode',
      cli: 'antigravity',
      model: 'g-1',
    });
    expect(parseWebviewMessage({ type: 'addNode', cli: 'cursor', model: 'g' })).toBe(undefined);
    const set = {
      type: 'setNode',
      id: 'n-1',
      name: ' G ',
      cli: 'codex',
      model: 'm',
      effort: 'low',
    };
    expect(parseWebviewMessage({ ...set, permission: 'auto' })).toEqual({
      ...set,
      name: 'G',
      permission: 'auto',
    });
    expect(parseWebviewMessage({ ...set, permission: 'tutto' })).toBe(undefined);
    expect(parseWebviewMessage({ ...set, name: 'x'.repeat(41), permission: 'ask' })).toBe(
      undefined,
    );
    expect(parseWebviewMessage({ type: 'removeNode', id: 'n-1' })).toEqual({
      type: 'removeNode',
      id: 'n-1',
    });
    // The roles stay on Codex or Claude.
    expect(
      parseWebviewMessage({
        type: 'setRole',
        role: 'implementer',
        cli: 'antigravity',
        model: 'm',
        effort: '',
        permission: 'auto',
      }),
    ).toBe(undefined);
  });
});
