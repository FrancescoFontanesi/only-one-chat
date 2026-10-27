// The chats of a workspace, kept on disk so a chat can be reopened (R5, ADR
// 0011): the thread as the webview drew it, and the ids of the CLIs' own
// sessions to resume. One JSON file per chat in the extension's workspace
// storage, written atomically (a temporary file, then a rename). Node only, no
// `vscode`.

import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ThreadUpdate, TurnRole } from '../webview/protocol.js';

export interface ChatRecord {
  readonly version: 1;
  readonly id: string;
  title: string;
  readonly createdAt: number;
  updatedAt: number;
  /** The CLIs' own sessions, to resume: Claude session id, Codex thread id. */
  sessions: Partial<Record<TurnRole, string>>;
  updates: ThreadUpdate[];
}

export interface ChatSummary {
  readonly id: string;
  readonly title: string;
  readonly updatedAt: number;
}

/** At most this many chats are kept; the oldest go first. */
const MAX_CHATS = 50;
/** At most this many thread updates per chat, the latest. */
const MAX_UPDATES = 3000;
const ID = /^[a-z0-9-]{1,64}$/;

export function newChatId(now = Date.now()): string {
  return `chat-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * The updates worth keeping: the streamed chunks of a turn are dropped once the
 * turn is done, since its final text holds them.
 */
export function compact(updates: readonly ThreadUpdate[]): ThreadUpdate[] {
  const done = new Set(
    updates.flatMap((u) => (u.type === 'turn' && u.status !== 'running' ? [u.id] : [])),
  );
  return updates.filter((u) => !(u.type === 'chunk' && done.has(u.turnId))).slice(-MAX_UPDATES);
}

/**
 * The thread as it is redrawn later: what was still running or waiting when
 * the chat was closed is shown as interrupted, never as still pending.
 */
export function forReplay(updates: readonly ThreadUpdate[]): ThreadUpdate[] {
  const out = compact(updates);
  const ended = new Set<string>();
  const closed = new Set<string>();
  for (const u of out) {
    if (u.type === 'turn' && u.status !== 'running') ended.add(u.id);
    if (u.type === 'approval_closed' || u.type === 'permission_closed') closed.add(u.id);
  }
  const tail: ThreadUpdate[] = [];
  for (const u of out) {
    if (u.type === 'turn' && u.status === 'running' && !ended.has(u.id)) {
      ended.add(u.id);
      tail.push({ type: 'turn', id: u.id, role: u.role, agent: u.agent, status: 'failed' });
    } else if (u.type === 'approval' && !closed.has(u.id)) {
      tail.push({ type: 'approval_closed', id: u.id, action: 'interrupted' });
    } else if (u.type === 'permission' && !closed.has(u.id)) {
      tail.push({ type: 'permission_closed', id: u.id, decision: 'interrupted' });
    }
  }
  return [...out, ...tail];
}

export class ChatHistory {
  constructor(private readonly dir: string) {}

  private file(id: string): string {
    if (!ID.test(id)) throw new Error(`invalid chat id ${JSON.stringify(id)}`);
    return join(this.dir, `${id}.json`);
  }

  load(id: string): ChatRecord | undefined {
    try {
      const record = JSON.parse(readFileSync(this.file(id), 'utf8')) as Partial<ChatRecord>;
      return record.version === 1 && record.id === id ? (record as ChatRecord) : undefined;
    } catch {
      return undefined;
    }
  }

  /** The chats, most recent first. */
  list(): ChatSummary[] {
    let names: string[];
    try {
      names = readdirSync(this.dir).filter((name) => name.endsWith('.json'));
    } catch {
      return [];
    }
    return names
      .flatMap((name) => {
        const record = this.load(name.slice(0, -'.json'.length));
        return record ? [{ id: record.id, title: record.title, updatedAt: record.updatedAt }] : [];
      })
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  save(record: ChatRecord): void {
    mkdirSync(this.dir, { recursive: true });
    const path = this.file(record.id);
    const temporary = `${path}.${String(process.pid)}.tmp`;
    writeFileSync(temporary, JSON.stringify({ ...record, updates: compact(record.updates) }));
    renameSync(temporary, path);
    for (const old of this.list().slice(MAX_CHATS)) rmSync(this.file(old.id), { force: true });
  }
}
