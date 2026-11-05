// The chats of a workspace, kept on disk so a chat can be reopened (R5, ADR
// 0011): the thread as the webview drew it, and the ids of the CLIs' own
// sessions to resume. One JSON file per chat in the extension's workspace
// storage, written atomically (a temporary file, then a rename). Node only, no
// `vscode`.

import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PendingReport } from '@only-one-chat/runtime';
import type { AgentChoice, DraftDelegation, FileNotes } from './chat.js';
import type { ContextInfo, ThreadUpdate, TurnRole } from '../webview/protocol.js';

export interface ChatRecord {
  readonly version: 1;
  readonly id: string;
  title: string;
  readonly createdAt: number;
  updatedAt: number;
  /** The CLIs' own sessions, to resume: Claude session id, Codex thread id. */
  sessions: Partial<Record<TurnRole, string>>;
  /** The roles the chat runs with: its providers stay its own (ADR 0012); absent in older records. */
  roles?: Partial<Record<TurnRole, AgentChoice>>;
  /** Notes on files the user put back, not received yet by each role (ADR 0014). */
  fileNotes?: FileNotes;
  /** How full each role's session was after its latest turn. */
  context?: Partial<Record<TurnRole, ContextInfo>>;
  /** Implementer work the leader has not seen yet; absent in older records. */
  unseen?: PendingReport[];
  /** A delegation waiting for the user when the chat was closed (ADR 0018). */
  draft?: DraftDelegation | null;
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

/** The pending reports of a record read from disk; an entry of the wrong shape is dropped. */
function pendingReports(value: unknown): PendingReport[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is PendingReport => {
    const r = entry as Partial<Record<keyof PendingReport, unknown>> | null;
    return (
      typeof r === 'object' &&
      r !== null &&
      (r.source === 'delegation' || r.source === 'direct') &&
      typeof r.request === 'string' &&
      typeof r.report === 'string' &&
      typeof r.facts === 'string'
    );
  });
}

/** The draft of a record read from disk, if it has the right shape. */
function draftOf(value: unknown): DraftDelegation | null {
  const d = value as Partial<Record<keyof DraftDelegation, unknown>> | null;
  return typeof d === 'object' &&
    d !== null &&
    typeof d.id === 'string' &&
    ID.test(d.id) &&
    typeof d.text === 'string' &&
    typeof d.from === 'string' &&
    typeof d.to === 'string'
    ? { id: d.id, text: d.text, from: d.from, to: d.to }
    : null;
}

/** The file notes of a record read from disk; anything but strings is dropped. */
function fileNotesOf(value: unknown): FileNotes {
  const notes = (role: TurnRole): string[] => {
    const list =
      typeof value === 'object' && value !== null
        ? (value as Record<string, unknown>)[role]
        : undefined;
    return Array.isArray(list) ? list.filter((n): n is string => typeof n === 'string') : [];
  };
  return { leader: notes('leader'), implementer: notes('implementer') };
}

/** The contexts of a record read from disk; an entry of the wrong shape is dropped. */
function contextOf(value: unknown): Partial<Record<TurnRole, ContextInfo>> {
  const context: Partial<Record<TurnRole, ContextInfo>> = {};
  if (typeof value !== 'object' || value === null) return context;
  for (const role of ['leader', 'implementer'] as const) {
    const c = (value as Record<string, unknown>)[role] as Record<string, unknown> | null;
    if (
      typeof c === 'object' &&
      c !== null &&
      typeof c['used'] === 'number' &&
      (typeof c['window'] === 'number' || c['window'] === null)
    ) {
      context[role] = { used: c['used'], window: c['window'] };
    }
  }
  return context;
}

/** The roles of a record read from disk; a role of the wrong shape is dropped. */
function chatRoles(value: unknown): Partial<Record<TurnRole, AgentChoice>> {
  const roles: Partial<Record<TurnRole, AgentChoice>> = {};
  if (typeof value !== 'object' || value === null) return roles;
  for (const role of ['leader', 'implementer'] as const) {
    const r = (value as Record<string, unknown>)[role] as Record<string, unknown> | null;
    if (
      typeof r === 'object' &&
      r !== null &&
      (r['cli'] === 'codex' || r['cli'] === 'claude') &&
      typeof r['model'] === 'string' &&
      typeof r['effort'] === 'string' &&
      (r['permission'] === 'read-only' || r['permission'] === 'ask' || r['permission'] === 'auto')
    ) {
      roles[role] = {
        cli: r['cli'],
        model: r['model'],
        effort: r['effort'],
        permission: r['permission'],
      };
    }
  }
  return roles;
}

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
 * the chat was closed is shown as interrupted, never as still pending; except
 * `open`, the card of a delegation kept with the chat, which still waits.
 */
export function forReplay(updates: readonly ThreadUpdate[], open?: string): ThreadUpdate[] {
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
    } else if (u.type === 'approval' && !closed.has(u.id) && u.id !== open) {
      tail.push({ type: 'approval_closed', id: u.id, action: 'interrupted' });
    } else if (u.type === 'permission' && !closed.has(u.id)) {
      tail.push({ type: 'permission_closed', id: u.id, decision: 'interrupted' });
    }
  }
  return [...out, ...tail];
}

export class ChatHistory {
  /** `onRemove`: told of each chat dropped past the limit, to drop what belongs to it. */
  constructor(
    private readonly dir: string,
    private readonly onRemove?: (id: string) => void,
  ) {}

  private file(id: string): string {
    if (!ID.test(id)) throw new Error(`invalid chat id ${JSON.stringify(id)}`);
    return join(this.dir, `${id}.json`);
  }

  load(id: string): ChatRecord | undefined {
    try {
      const record = JSON.parse(readFileSync(this.file(id), 'utf8')) as Partial<ChatRecord>;
      return record.version === 1 && record.id === id
        ? {
            ...(record as ChatRecord),
            unseen: pendingReports(record.unseen),
            roles: chatRoles(record.roles),
            context: contextOf(record.context),
            fileNotes: fileNotesOf(record.fileNotes),
            draft: draftOf(record.draft),
          }
        : undefined;
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
    for (const old of this.list().slice(MAX_CHATS)) {
      rmSync(this.file(old.id), { force: true });
      this.onRemove?.(old.id);
    }
  }
}
