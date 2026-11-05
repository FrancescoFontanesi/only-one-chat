import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ChatHistory,
  compact,
  forReplay,
  newChatId,
  type ChatRecord,
} from '../../src/session/history.js';
import type { ThreadUpdate } from '../../src/webview/protocol.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'history '));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function record(id: string, updatedAt: number, updates: ThreadUpdate[] = []): ChatRecord {
  return { version: 1, id, title: id, createdAt: updatedAt, updatedAt, sessions: {}, updates };
}

describe('chat history (R5)', () => {
  it('saves a chat atomically and lists the chats, most recent first', () => {
    const history = new ChatHistory(join(dir, 'chats'));
    history.save({ ...record('chat-a', 1), sessions: { leader: 'thread-9' } });
    history.save(record('chat-b', 2));
    expect(history.list().map((c) => c.id)).toEqual(['chat-b', 'chat-a']);
    expect(history.load('chat-a')?.sessions).toEqual({ leader: 'thread-9' });
    // Nothing temporary is left behind.
    expect(readdirSync(join(dir, 'chats')).every((name) => name.endsWith('.json'))).toBe(true);
  });

  it('keeps the reports the leader has not read, dropping entries of the wrong shape', () => {
    const history = new ChatHistory(dir);
    const report = { source: 'direct', request: 'r', report: 'fatto', facts: 'nessun file' };
    writeFileSync(
      join(dir, 'chat-u.json'),
      JSON.stringify({
        ...record('chat-u', 1),
        unseen: [report, { source: 'other', request: 'x' }, null],
      }),
    );
    expect(history.load('chat-u')?.unseen).toEqual([report]);
    // An older record without the field reads as no reports.
    history.save(record('chat-old', 2));
    expect(history.load('chat-old')?.unseen).toEqual([]);
  });

  it('keeps the roles a chat runs with, dropping a role of the wrong shape', () => {
    const history = new ChatHistory(dir);
    const leader = { cli: 'codex', model: 'gpt-6.1-sol', effort: 'low', permission: 'auto' };
    writeFileSync(
      join(dir, 'chat-r.json'),
      JSON.stringify({
        ...record('chat-r', 1),
        roles: {
          leader,
          implementer: { cli: 'gemini', model: 'x', effort: '', permission: 'auto' },
        },
      }),
    );
    expect(history.load('chat-r')?.roles).toEqual({ leader });
  });

  it('keeps the notes on files put back, per role, dropping what is not text', () => {
    const history = new ChatHistory(dir);
    writeFileSync(
      join(dir, 'chat-n.json'),
      JSON.stringify({
        ...record('chat-n', 1),
        fileNotes: { leader: ['calc.py', 3], implementer: 'x' },
      }),
    );
    expect(history.load('chat-n')?.fileNotes).toEqual({ leader: ['calc.py'], implementer: [] });
  });

  it('keeps at most 50 chats, dropping the oldest', () => {
    const removed: string[] = [];
    const history = new ChatHistory(dir, (id) => removed.push(id));
    for (let i = 0; i < 52; i++) history.save(record(`chat-${String(i)}`, i));
    const ids = history.list().map((c) => c.id);
    expect(ids).toHaveLength(50);
    // What belongs to a dropped chat (its checkpoints) goes with it.
    expect(removed).toEqual(['chat-0', 'chat-1']);
    expect(ids).not.toContain('chat-0');
    expect(existsSync(join(dir, 'chat-1.json'))).toBe(false);
  });

  it('refuses an id that is not a plain chat id', () => {
    const history = new ChatHistory(dir);
    expect(history.load('../../etc/passwd')).toBeUndefined();
    expect(() => {
      history.save(record('../x', 1));
    }).toThrow(/invalid chat id/);
    expect(newChatId(0)).toMatch(/^chat-0-[a-z0-9]+$/);
  });

  it('drops the chunks of a finished turn, and redraws what was pending as interrupted', () => {
    const updates: ThreadUpdate[] = [
      { type: 'turn', id: 't-1', role: 'leader', agent: 'Codex', status: 'running' },
      { type: 'chunk', turnId: 't-1', text: 'Ciao' },
      { type: 'turn', id: 't-1', role: 'leader', agent: 'Codex', status: 'done', text: 'Ciao' },
      { type: 'turn', id: 't-2', role: 'implementer', agent: 'Claude', status: 'running' },
      { type: 'chunk', turnId: 't-2', text: 'met' },
      { type: 'permission', id: 'p-3', role: 'implementer', agent: 'Claude', summary: 'Bash: rm' },
    ];
    expect(compact(updates).filter((u) => u.type === 'chunk')).toEqual([
      { type: 'chunk', turnId: 't-2', text: 'met' },
    ]);
    const replay = forReplay(updates);
    expect(replay.slice(-2)).toEqual([
      { type: 'turn', id: 't-2', role: 'implementer', agent: 'Claude', status: 'failed' },
      { type: 'permission_closed', id: 'p-3', decision: 'interrupted' },
    ]);
  });
});

describe('a delegation kept with the chat (ADR 0018)', () => {
  it('stays waiting when redrawn, while the other cards are interrupted', () => {
    const updates: ThreadUpdate[] = [
      { type: 'approval', id: 'a-1', kind: 'delegation', from: 'L', to: 'I', text: 'vecchia' },
      { type: 'approval', id: 'a-2', kind: 'delegation', from: 'L', to: 'I', text: 'in attesa' },
    ];
    expect(forReplay(updates, 'a-2').slice(2)).toEqual([
      { type: 'approval_closed', id: 'a-1', action: 'interrupted' },
    ]);
  });

  it('is saved and read back; one of the wrong shape is dropped', () => {
    const history = new ChatHistory(join(dir, 'chats'));
    const draft = { id: 'a-2', text: 'brief', from: 'Codex', to: 'Claude' };
    history.save({ ...record('chat-a', 1, [{ type: 'notice', level: 'info', text: 'x' }]), draft });
    expect(history.load('chat-a')?.draft).toEqual(draft);
    history.save({
      ...record('chat-b', 2, [{ type: 'notice', level: 'info', text: 'x' }]),
      draft: { id: 'A B', text: 1 } as unknown as typeof draft,
    });
    expect(history.load('chat-b')?.draft).toBeNull();
  });
});

describe('a question left open (ADR 0019)', () => {
  it('is redrawn as interrupted', () => {
    const updates: ThreadUpdate[] = [
      { type: 'question', id: 'q-1', role: 'leader', agent: 'Codex', questions: [] },
    ];
    expect(forReplay(updates).at(-1)).toEqual({
      type: 'question_closed',
      id: 'q-1',
      outcome: 'interrupted',
    });
  });
});
