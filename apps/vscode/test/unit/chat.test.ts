// The chat session against the adapters' fake CLIs: no model turn, no quota.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PendingReport } from '@only-one-chat/runtime';
import {
  ChatSession,
  type ChatConfig,
  type DraftDelegation,
  type FileNotes,
} from '../../src/session/chat.js';
import { CheckpointStore } from '../../src/session/checkpoints.js';
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

function session(
  mode: 'auto' | 'manual',
  review: 'always' | 'deferred' = 'always',
  resume?: ChatConfig['resume'],
  unseen?: PendingReport[],
  instructions?: ChatConfig['instructions'],
  checkpoints?: CheckpointStore,
  fileNotes?: ChatConfig['fileNotes'],
  extra: Partial<ChatConfig> = {},
) {
  const updates: ThreadUpdate[] = [];
  const busy: boolean[] = [];
  const sessionIds: [string, string][] = [];
  const kept: (readonly PendingReport[])[] = [];
  const contexts: [string, { used: number; window: number | null }][] = [];
  const notes: FileNotes[] = [];
  const drafts: (DraftDelegation | null)[] = [];
  const config: ChatConfig = {
    cwd,
    leader: { cli: 'codex', model: 'gpt-6.1-sol', effort: 'low', permission: 'auto' },
    implementer: { cli: 'claude', model: 'sonnet', effort: 'low', permission: 'auto' },
    subagents: {
      codex: { model: 'gpt-6-luna', effort: 'low' },
      claude: { model: 'claude-haiku-5-5', effort: 'low' },
    },
    codexExecutable: process.execPath,
    claudeExecutable: process.execPath,
    codexLauncherArgs: [join(FIXTURES, 'fake-app-server.mjs'), '--account=chatgpt'],
    claudeLauncherArgs: [
      join(FIXTURES, 'fake-claude.mjs'),
      '--echo',
      `--log=${join(root, 'claude.jsonl')}`,
    ],
    allowedCommands: ['python'],
    verifyCommand: [],
    mode,
    review,
    ...(resume ? { resume } : {}),
    ...(unseen ? { unseen } : {}),
    ...(instructions ? { instructions } : {}),
    ...(checkpoints ? { checkpoints } : {}),
    ...(fileNotes ? { fileNotes } : {}),
    logPath: join(root, 'logs', 'chat.jsonl'),
    ...extra,
  };
  const chat = new ChatSession(config, {
    update: (update) => updates.push(update),
    busy: (value) => busy.push(value),
    sessionId: (role, id) => sessionIds.push([role, id]),
    unseen: (reports) => kept.push([...reports]),
    context: (role, context) => contexts.push([role, context]),
    fileNotes: (pending) => notes.push(pending),
    draft: (draft) => drafts.push(draft),
  });
  return { chat, updates, busy, sessionIds, kept, contexts, notes, drafts };
}

describe('chat session: files named with @ (ADR 0015)', () => {
  it('shows the user’s text and hands the agent the attachments after it', async () => {
    const { chat, updates } = session('auto');
    try {
      await chat.send('@impl rivedi @calc.py', {
        text: 'Allegati indicati dall’utente:\n- calc.py',
        paths: ['calc.py'],
      });
    } finally {
      await chat.dispose();
    }
    expect(updates[0]).toMatchObject({
      type: 'user',
      text: 'rivedi @calc.py',
      to: 'implementer',
      attachments: ['calc.py'],
    });
    // The fake implementer echoes its prompt.
    expect(doneTurns(updates)[0]?.text).toContain('rivedi @calc.py\n\nAllegati indicati');
  });
});

describe('chat session: context of each session', () => {
  it('reports how full the leader’s and the implementer’s sessions are after their turns', async () => {
    const { chat, contexts } = session('auto');
    try {
      await chat.send('@impl primo');
      await chat.send('ciao');
    } finally {
      await chat.dispose();
    }
    expect(contexts).toEqual([
      ['implementer', { used: 6057, window: 1_000_000 }],
      ['leader', { used: 1050, window: 258_400 }],
    ]);
  });
});

describe('chat session: checkpoints and review (ADR 0014)', () => {
  it('records the folder before a message and lists what the message changed', async () => {
    writeFileSync(join(cwd, 'calc.py'), 'x = 1\n');
    const store = new CheckpointStore(join(root, 'checkpoints'), cwd);
    const { chat, updates } = session('manual', 'always', undefined, undefined, undefined, store);
    try {
      const sent = chat.send('[spec] aggiungi una funzione');
      // While the delegation waits, the folder changes, as an agent would change it.
      await expect.poll(() => updates.find((u) => u.type === 'approval')).toBeTruthy();
      writeFileSync(join(cwd, 'calc.py'), 'x = 1\ny = 2\n');
      const approval = updates.find((u) => u.type === 'approval');
      if (approval?.type === 'approval') chat.decide(approval.id, 'cancel');
      await sent;
    } finally {
      await chat.dispose();
    }
    const user = updates.find((u) => u.type === 'user');
    const card = updates.find((u) => u.type === 'changes');
    expect(user?.type === 'user' && user.checkpoint).toMatch(/^ckpt-/);
    expect(card).toMatchObject({
      type: 'changes',
      checkpoint: user?.type === 'user' ? user.checkpoint : '',
      files: [{ path: 'calc.py', kind: 'modified', added: 1, removed: 0 }],
      uncovered: [],
    });
    // The card replaces the plain list of changed files.
    expect(updates.some((u) => u.type === 'notice' && u.text.startsWith('File cambiati'))).toBe(
      false,
    );
  });

  it('keeps the notes a role has not received with the chat, and resumes from them', async () => {
    // A reopened chat: the implementer already had the note, the leader not yet.
    const { chat, updates, notes } = session(
      'auto',
      'always',
      undefined,
      undefined,
      undefined,
      undefined,
      {
        leader: ['calc.py: rimesso com’era prima del messaggio'],
      },
    );
    try {
      await chat.send('@impl primo');
      await chat.send('ciao');
    } finally {
      await chat.dispose();
    }
    const done = doneTurns(updates);
    expect(done[0]?.text).not.toContain('calc.py: rimesso');
    expect(done[1]?.text).toContain('calc.py: rimesso');
    // Saved when the leader received it: nothing left to tell.
    expect(notes.at(-1)).toEqual({ leader: [], implementer: [] });
  });

  it('tells the leader and the implementer, each once, which files the user put back', async () => {
    const { chat, updates } = session('auto');
    try {
      chat.noteFiles('calc.py: rimesso com’era prima del messaggio');
      await chat.send('@impl primo');
      await chat.send('ciao');
      await chat.send('di nuovo');
    } finally {
      await chat.dispose();
    }
    const done = doneTurns(updates);
    // The fake CLIs echo their prompt.
    expect(done[0]?.text).toContain('calc.py: rimesso com’era');
    expect(done[1]?.text).toContain('calc.py: rimesso com’era');
    expect(done[2]?.text).not.toContain('calc.py: rimesso com’era');
  });
});

describe('chat session: the user’s instructions per role (ADR 0013)', () => {
  it('adds them to the role’s own instructions', async () => {
    const { chat } = session('auto', 'always', undefined, undefined, {
      implementer: 'Rispondi sempre in inglese.',
    });
    try {
      await chat.send('@impl primo');
    } finally {
      await chat.dispose();
    }
    const run = claudeRuns()[0] ?? [];
    const prompt = run[run.indexOf('--append-system-prompt') + 1] ?? '';
    expect(prompt).toContain(
      'Istruzioni dell’utente per questo ruolo:\nRispondi sempre in inglese.',
    );
  });
});

describe('chat session: a reopened chat (R5)', () => {
  it('continues the leader’s own thread and reports the session ids to keep', async () => {
    const { chat, sessionIds } = session('auto', 'always', { leader: 'kept-42' });
    try {
      await chat.send('dove eravamo?');
    } finally {
      await chat.dispose();
    }
    expect(sessionIds).toContainEqual(['leader', 'kept-42']);
  });

  it('hands the leader the reports it had not read when the chat was closed', async () => {
    const report: PendingReport = {
      source: 'direct',
      request: 'aggiungi round',
      report: 'fatto: round in calc.py',
      facts: 'File cambiati: calc.py',
    };
    const { chat, updates, kept } = session('auto', 'always', undefined, [report]);
    try {
      await chat.send('com’è andata?');
    } finally {
      await chat.dispose();
    }
    const leader = updates.find((u) => u.type === 'turn' && u.status === 'done');
    // The fake leader echoes its prompt.
    expect(leader?.type === 'turn' && leader.text).toContain('fatto: round in calc.py');
    // Read: nothing is left to keep, and closing the chat does not clear what was kept.
    expect(kept).toEqual([[]]);
  });
});

/** The fake Claude's runs, in order: their arguments. */
function claudeRuns(): string[][] {
  return readFileSync(join(root, 'claude.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { argv?: string[] })
    .flatMap((entry) => (entry.argv?.includes('-p') ? [entry.argv] : []));
}

const doneTurns = (updates: readonly ThreadUpdate[]) =>
  updates.flatMap((u) => (u.type === 'turn' && u.status === 'done' ? [u] : []));

describe('chat session: roles changed during the chat (ADR 0012)', () => {
  it('gives a role another model from its next turn, in the same session', async () => {
    const { chat, updates } = session('auto');
    try {
      await chat.send('@impl primo');
      chat.setRole('implementer', { ...chat.currentRoles.implementer, model: 'haiku' });
      await chat.send('@impl secondo');
    } finally {
      await chat.dispose();
    }
    expect(doneTurns(updates).map((u) => u.agent)).toEqual(['Claude (sonnet)', 'Claude (haiku)']);
    const runs = claudeRuns();
    expect(runs[1]?.[runs[1].indexOf('--model') + 1]).toBe('haiku');
    expect(runs[1]).toContain('--resume');
  });

  it('reopens the same session with the new rules for another permission level', async () => {
    const { chat } = session('auto');
    try {
      await chat.send('@impl primo');
      chat.setRole('implementer', { ...chat.currentRoles.implementer, permission: 'read-only' });
      await chat.send('@impl secondo');
    } finally {
      await chat.dispose();
    }
    const runs = claudeRuns();
    // Read-only: no writing tools any more, in the same session.
    expect(runs[0]).toContain('--allowedTools');
    expect(runs[1]).not.toContain('--allowedTools');
    expect(runs[1]).toContain('--resume');
  });

  it('keeps the leader’s model for the chat, and still takes its reasoning', async () => {
    const { chat, updates } = session('auto');
    try {
      await chat.send('ciao');
      const applied = chat.setRole('leader', {
        ...chat.currentRoles.leader,
        model: 'gpt-6-luna',
        effort: 'high',
      });
      expect(applied).toBe(false);
      await chat.send('di nuovo');
    } finally {
      await chat.dispose();
    }
    expect(chat.currentRoles.leader).toMatchObject({ model: 'gpt-6.1-sol', effort: 'high' });
    expect(doneTurns(updates).map((u) => u.agent)).toEqual([
      'Codex (gpt-6.1-sol)',
      'Codex (gpt-6.1-sol)',
    ]);
  });

  it('keeps the chat’s provider: another CLI is not a change for this chat', async () => {
    const { chat, updates } = session('auto');
    try {
      await chat.send('@impl primo');
      const applied = chat.setRole('implementer', {
        cli: 'codex',
        model: 'gpt-6-luna',
        effort: 'low',
        permission: 'auto',
      });
      expect(applied).toBe(false);
      await chat.send('@impl secondo');
    } finally {
      await chat.dispose();
    }
    expect(doneTurns(updates).map((u) => u.agent)).toEqual(['Claude (sonnet)', 'Claude (sonnet)']);
    expect(chat.currentRoles.implementer.cli).toBe('claude');
  });
});

describe('chat session: handoff of the implementer (ADR 0017)', () => {
  it('asks for a handoff, then opens a new session of the same model that starts from it', async () => {
    const { chat, updates, sessionIds } = session('auto');
    try {
      await chat.send('@impl primo');
      await chat.handoff();
      await chat.send('@impl secondo');
    } finally {
      await chat.dispose();
    }
    const runs = claudeRuns();
    // The handoff turn runs in the old session; the next message in a new one.
    expect(runs[1]).toContain('--resume');
    expect(runs[2]).not.toContain('--resume');
    expect(runs[2]?.[runs[2].indexOf('--model') + 1]).toBe('sonnet');
    const prompt = runs[2]?.[runs[2].indexOf('--append-system-prompt') + 1] ?? '';
    // The fake echoes its prompt: the handoff it wrote is the request it got.
    expect(prompt).toContain('Il suo passaggio di consegne:\nECHO: Passaggio di consegne.');
    expect(sessionIds).toContainEqual(['implementer', '']);
    expect(doneTurns(updates)).toHaveLength(3);
  });

  it('does nothing before the implementer has a session', async () => {
    const { chat, updates } = session('auto');
    try {
      await chat.handoff();
    } finally {
      await chat.dispose();
    }
    expect(updates).toEqual([expect.objectContaining({ type: 'notice', level: 'info' })]);
    expect(doneTurns(updates)).toHaveLength(0);
  });
});

describe('chat session: permissions (R9)', () => {
  it('shows an agent’s request and sends the user’s answer back to the CLI', async () => {
    const { chat, updates } = session('auto');
    try {
      // The fake Codex leader asks to run `git push` and answers with the decision it got.
      const sent = chat.send('[approval] pubblica');
      await expect.poll(() => updates.find((u) => u.type === 'permission')).toBeTruthy();
      const request = updates.find((u) => u.type === 'permission');
      if (request?.type !== 'permission') throw new Error('no permission request');
      expect(request).toMatchObject({ role: 'leader', summary: 'git push — needs network' });
      chat.permit(request.id, 'accept');
      await sent;
    } finally {
      await chat.dispose();
    }
    const leader = updates.find((u) => u.type === 'turn' && u.status === 'done');
    expect(leader).toMatchObject({ text: 'decision={"decision":"accept"}' });
    expect(updates).toContainEqual({
      type: 'permission_closed',
      id: expect.any(String) as string,
      decision: 'accept',
    });
  });

  it('declines what is still waiting when the user stops', async () => {
    const { chat, updates } = session('auto');
    try {
      const sent = chat.send('[approval] pubblica');
      await expect.poll(() => updates.find((u) => u.type === 'permission')).toBeTruthy();
      await chat.stop();
      await sent;
    } finally {
      await chat.dispose();
    }
    expect(updates.some((u) => u.type === 'permission_closed' && u.decision === 'decline')).toBe(
      true,
    );
  });
});

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

  it('takes the recipient the panel gives: a typed @impl then is text for the leader', async () => {
    const { chat, updates } = session('auto');
    try {
      await chat.send('@impl aggiungi round', undefined, 'leader');
    } finally {
      await chat.dispose();
    }
    expect(updates[0]).toMatchObject({ type: 'user', text: '@impl aggiungi round', to: 'leader' });
    const done = updates.flatMap((u) => (u.type === 'turn' && u.status === 'done' ? [u] : []));
    expect(done.map((u) => u.role)).toEqual(['leader']);
  });

  it('reports the unseen work as it changes, to keep it with the chat', async () => {
    const { chat, kept } = session('auto');
    try {
      await chat.send('@impl aggiungi round');
    } finally {
      await chat.dispose();
    }
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatchObject([{ source: 'direct', request: 'aggiungi round' }]);
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

describe('chat session: the delegation cycle (ADR 0018)', () => {
  it('runs the leader read-only whatever the settings say: Codex never asks to leave its sandbox', async () => {
    const log = join(root, 'codex.jsonl');
    const { chat } = session(
      'auto',
      'always',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        codexLauncherArgs: [
          join(FIXTURES, 'fake-app-server.mjs'),
          '--account=chatgpt',
          `--log=${log}`,
        ],
      },
    );
    try {
      await chat.send('ciao');
    } finally {
      await chat.dispose();
    }
    const start = readFileSync(log, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { method?: string; params?: Record<string, unknown> })
      .find((m) => m.method === 'thread/start');
    expect(start?.params).toMatchObject({ sandbox: 'read-only', approvalPolicy: 'never' });
    expect(chat.currentRoles.leader.permission).toBe('read-only');
    expect(chat.setRole('leader', { ...chat.currentRoles.leader, permission: 'auto' })).toBe(true);
    expect(chat.currentRoles.leader.permission).toBe('read-only');
  });

  it('with automatic delivery still shows the delegation as a card, closed as sent', async () => {
    const { chat, updates, drafts } = session('auto');
    try {
      await chat.send('[spec] aggiungi una funzione');
    } finally {
      await chat.dispose();
    }
    const card = updates.find((u) => u.type === 'approval');
    expect(card).toMatchObject({ type: 'approval', kind: 'delegation' });
    expect(updates).toContainEqual({ type: 'approval_closed', id: card?.id, action: 'sent' });
    expect(drafts).toEqual([]);
  });

  it('keeps a delegation held for the user with the chat until it is decided', async () => {
    const { chat, updates, drafts } = session('manual');
    try {
      const sent = chat.send('[spec] aggiungi una funzione');
      await expect.poll(() => updates.find((u) => u.type === 'approval')).toBeTruthy();
      const card = updates.find((u) => u.type === 'approval');
      if (card?.type !== 'approval') throw new Error('no card');
      expect(drafts).toEqual([{ id: card.id, text: card.text, from: card.from, to: card.to }]);
      chat.decide(card.id, 'approve');
      await sent;
    } finally {
      await chat.dispose();
    }
    expect(drafts.at(-1)).toBeNull();
    // The report reached the leader without being held: one card only.
    expect(updates.filter((u) => u.type === 'approval')).toHaveLength(1);
    expect(doneTurns(updates).map((t) => t.role)).toEqual(['leader', 'implementer', 'leader']);
  });

  it('closing the chat keeps a waiting delegation; reopened, it is sent with no leader turn first', async () => {
    const first = session('manual');
    let draft: DraftDelegation | null | undefined;
    try {
      void first.chat.send('[spec] aggiungi una funzione');
      await expect.poll(() => first.drafts.length).toBe(1);
      draft = first.drafts[0];
    } finally {
      await first.chat.dispose();
    }
    // Closing is not stopping: the draft stays.
    expect(first.drafts).toHaveLength(1);
    if (!draft) throw new Error('no draft');

    const second = session(
      'manual',
      'always',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        draft,
      },
    );
    try {
      await second.chat.send('altro');
      expect(second.updates).toContainEqual(
        expect.objectContaining({ type: 'notice', level: 'warn' }),
      );
      expect(second.updates.some((u) => u.type === 'user')).toBe(false);
      second.chat.decide(draft.id, 'edit', 'Brief modificato.');
      await expect.poll(() => doneTurns(second.updates).length).toBe(2);
      await expect.poll(() => second.chat.busy).toBe(false);
    } finally {
      await second.chat.dispose();
    }
    expect(second.updates).toContainEqual({
      type: 'approval_closed',
      id: draft.id,
      action: 'edit',
    });
    expect(second.drafts).toEqual([null]);
    const done = doneTurns(second.updates);
    expect(done.map((t) => t.role)).toEqual(['implementer', 'leader']);
    // The fake implementer echoes what it received: the edited brief.
    expect(done[0]?.text).toContain('Brief modificato.');
  });

  it('stopping a waiting delegation drops it', async () => {
    const { chat, updates, drafts } = session('manual');
    try {
      const sent = chat.send('[spec] uno');
      await expect.poll(() => updates.find((u) => u.type === 'approval')).toBeTruthy();
      await chat.stop();
      await sent;
    } finally {
      await chat.dispose();
    }
    expect(drafts.at(-1)).toBeNull();
  });
});

describe('chat session: skills (ADR 0019)', () => {
  it('invokes a skill on the implementer as /name; Claude may load skills by itself', async () => {
    const { chat, updates } = session('auto');
    try {
      await chat.send('aggiungi i test', undefined, 'implementer', { name: 'tdd' });
    } finally {
      await chat.dispose();
    }
    expect(updates[0]).toMatchObject({ type: 'user', skill: 'tdd', to: 'implementer' });
    const log = readFileSync(join(root, 'claude.jsonl'), 'utf8');
    expect(log).toContain('/tdd aggiungi i test');
    // The first process may be the billing check (`auth status`): the turn is the one with --tools.
    const argv =
      log
        .split('\n')
        .filter(Boolean)
        .map((line) => (JSON.parse(line) as { argv?: string[] }).argv ?? [])
        .find((a) => a.includes('--tools')) ?? [];
    expect(argv[argv.indexOf('--tools') + 1]?.split(',')).toContain('Skill');
  });

  it('sends a text that starts with / to Claude as text, never as one of its commands', async () => {
    const { chat } = session('auto');
    try {
      await chat.send('/clear', undefined, 'implementer');
    } finally {
      await chat.dispose();
    }
    const log = readFileSync(join(root, 'claude.jsonl'), 'utf8');
    // The stdin line is logged as JSON inside JSON: the quote before the text is escaped.
    expect(log).toContain('\\" /clear');
    expect(log).not.toContain('\\"/clear');
  });

  it('invokes a skill on the Codex leader as Codex’s own skill input', async () => {
    const codexLog = join(root, 'codex.jsonl');
    const { chat } = session(
      'auto',
      'always',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        codexLauncherArgs: [
          join(FIXTURES, 'fake-app-server.mjs'),
          '--account=chatgpt',
          `--log=${codexLog}`,
        ],
      },
    );
    try {
      await chat.send('ciao', undefined, 'leader', { name: 'tdd', path: '/s/tdd/SKILL.md' });
    } finally {
      await chat.dispose();
    }
    const start = readFileSync(codexLog, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { method?: string; params?: { input?: unknown[] } })
      .find((m) => m.method === 'turn/start');
    expect(start?.params?.input?.[0]).toEqual({
      type: 'skill',
      name: 'tdd',
      path: '/s/tdd/SKILL.md',
    });
  });
});

describe('chat session: the leader’s questions (ADR 0019)', () => {
  it('shows the Codex leader’s questions and hands the answers back in the same turn', async () => {
    const { chat, updates } = session('auto');
    try {
      const sent = chat.send('[question] decidi tu');
      await expect.poll(() => updates.find((u) => u.type === 'question')).toBeTruthy();
      const asked = updates.find((u) => u.type === 'question');
      if (asked?.type !== 'question') throw new Error('no question');
      expect(asked.role).toBe('leader');
      expect(asked.questions.map((q) => q.id)).toEqual(['storage', 'name']);
      chat.answer(asked.id, { storage: ['Con la chat (Recommended)'], name: ['ooc'] });
      await sent;
      expect(updates).toContainEqual({
        type: 'question_closed',
        id: asked.id,
        outcome: 'answered',
        answers: { storage: ['Con la chat (Recommended)'], name: ['ooc'] },
      });
    } finally {
      await chat.dispose();
    }
    const leader = doneTurns(updates).find((t) => t.role === 'leader');
    expect(leader?.text).toContain('"storage":{"answers":["Con la chat (Recommended)"]}');
  });

  it('stopping leaves the questions unanswered', async () => {
    const { chat, updates } = session('auto');
    try {
      const sent = chat.send('[question] decidi tu');
      await expect.poll(() => updates.find((u) => u.type === 'question')).toBeTruthy();
      await chat.stop();
      await sent;
    } finally {
      await chat.dispose();
    }
    expect(updates).toContainEqual(
      expect.objectContaining({ type: 'question_closed', outcome: 'declined' }),
    );
  });
});
