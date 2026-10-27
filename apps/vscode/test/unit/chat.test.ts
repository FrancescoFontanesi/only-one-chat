// The chat session against the adapters' fake CLIs: no model turn, no quota.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChatSession, type ChatConfig } from '../../src/session/chat.js';
import type { ThreadUpdate } from '../../src/webview/protocol.js';

const FIXTURES = join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  '..',
  'packages',
  'adapters',
  'test',
  'fixtures',
);

let root: string;
let cwd: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'chat '));
  cwd = join(root, 'workspace');
  mkdirSync(cwd);
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 5 });
});

function session(mode: 'auto' | 'manual', review: 'always' | 'deferred' = 'always') {
  const updates: ThreadUpdate[] = [];
  const busy: boolean[] = [];
  const config: ChatConfig = {
    cwd,
    leader: { cli: 'codex', model: 'gpt-6.1-sol', effort: 'low' },
    implementer: { cli: 'claude', model: 'sonnet', effort: 'low' },
    subagents: {
      codex: { model: 'gpt-6-luna', effort: 'low' },
      claude: { model: 'claude-haiku-5-5', effort: 'low' },
    },
    codexExecutable: process.execPath,
    claudeExecutable: process.execPath,
    codexLauncherArgs: [join(FIXTURES, 'fake-app-server.mjs'), '--account=chatgpt'],
    claudeLauncherArgs: [join(FIXTURES, 'fake-claude.mjs'), '--echo'],
    allowedCommands: ['python'],
    verifyCommand: [],
    mode,
    review,
    logPath: join(root, 'logs', 'chat.jsonl'),
  };
  const chat = new ChatSession(config, {
    update: (update) => updates.push(update),
    busy: (value) => busy.push(value),
  });
  return { chat, updates, busy };
}

describe('chat session', () => {
  it('lets the leader answer by itself, and keeps its session for the next message', async () => {
    const { chat, updates, busy } = session('auto');
    try {
      await chat.send('ciao');
      await chat.send('di nuovo');
    } finally {
      await chat.dispose();
    }
    const turns = updates.filter((u) => u.type === 'turn' && u.status === 'done');
    expect(turns).toMatchObject([
      { role: 'leader', text: 'Risposta: ciao' },
      { role: 'leader', text: 'Risposta: di nuovo' },
    ]);
    expect(updates[0]).toMatchObject({ type: 'user', text: 'ciao' });
    expect(busy).toEqual([true, false, true, false]);
  });

  it('delegates, runs the implementer and shows the runtime facts', async () => {
    const { chat, updates } = session('auto');
    writeFileSync(join(cwd, 'main.py'), 'print(1)\n');
    try {
      // The fake leader answers [spec] with a delegation block to @claude.
      await chat.send('[spec] aggiungi una funzione');
    } finally {
      await chat.dispose();
    }
    const done = updates.filter((u) => u.type === 'turn' && u.status === 'done');
    expect(done.map((u) => (u.type === 'turn' ? u.role : ''))).toEqual([
      'leader',
      'implementer',
      'leader',
    ]);
    const notices = updates.flatMap((u) => (u.type === 'notice' ? [u.text] : []));
    expect(notices.some((text) => text.startsWith('File cambiati'))).toBe(true);
  });

  it('sends @impl to the implementer alone; the leader reads its report next time', async () => {
    const { chat, updates } = session('auto');
    try {
      await chat.send('@impl aggiungi round');
      await chat.send('com’è andata?');
    } finally {
      await chat.dispose();
    }
    const done = updates.flatMap((u) => (u.type === 'turn' && u.status === 'done' ? [u] : []));
    expect(done.map((u) => u.role)).toEqual(['implementer', 'leader']);
    // The fake implementer echoes the message without @impl.
    expect(done[0]?.text).toContain('aggiungi round');
    expect(done[0]?.text).not.toContain('@impl');
    // The fake leader echoes its prompt: the report came before the user's message.
    expect(done[1]?.text).toMatch(/Nel frattempo l’implementatore ha lavorato/);
    expect(done[1]?.text?.endsWith('com’è andata?')).toBe(true);
  });

  it('with deferred review, keeps the report for the next message instead of a review turn', async () => {
    const { chat, updates } = session('auto', 'deferred');
    try {
      await chat.send('[spec] aggiungi una funzione');
      await chat.send('e ora?');
    } finally {
      await chat.dispose();
    }
    const done = updates.flatMap((u) => (u.type === 'turn' && u.status === 'done' ? [u] : []));
    expect(done.map((u) => u.role)).toEqual(['leader', 'implementer', 'leader']);
    expect(done[2]?.text).toMatch(/Nel frattempo/);
  });

  it('waits for the user before a delegation in manual mode', async () => {
    const { chat, updates } = session('manual');
    try {
      const sent = chat.send('[spec] aggiungi una funzione');
      // The delegation waits until the user decides.
      await expect.poll(() => updates.find((u) => u.type === 'approval')).toBeTruthy();
      const approval = updates.find((u) => u.type === 'approval');
      if (approval?.type !== 'approval') throw new Error('no approval');
      expect(approval.kind).toBe('delegation');
      chat.decide(approval.id, 'cancel');
      await sent;
    } finally {
      await chat.dispose();
    }
    expect(updates).toContainEqual({
      type: 'approval_closed',
      id: expect.any(String) as string,
      action: 'cancel',
    });
    expect(updates.some((u) => u.type === 'turn' && u.role === 'implementer')).toBe(false);
  });

  it('refuses a second message while one is running', async () => {
    const { chat, updates } = session('manual');
    try {
      const first = chat.send('[spec] uno');
      await expect.poll(() => updates.find((u) => u.type === 'approval')).toBeTruthy();
      await chat.send('due');
      expect(updates).toContainEqual(expect.objectContaining({ type: 'notice', level: 'warn' }));
      await chat.stop();
      await first;
    } finally {
      await chat.dispose();
    }
  });
});
