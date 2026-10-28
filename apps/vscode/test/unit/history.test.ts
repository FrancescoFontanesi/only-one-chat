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

  it('keeps at most 50 chats, dropping the oldest', () => {
    const history = new ChatHistory(dir);
    for (let i = 0; i < 52; i++) history.save(record(`chat-${String(i)}`, i));
    const ids = history.list().map((c) => c.id);
    expect(ids).toHaveLength(50);
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
