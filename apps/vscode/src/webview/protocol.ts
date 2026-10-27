// Messages exchanged between the extension host and the webview.
// Imported by both sides: it must not import `vscode` or DOM-only APIs.

export interface ExtensionStatus {
  readonly extensionVersion: string;
  readonly vscodeVersion: string;
  readonly runtime: { readonly name: string; readonly version: string };
  readonly workspaceTrusted: boolean;
}

export type ApprovalMode = 'auto' | 'manual';

/** Reasoning levels the user can choose for a role, the same for Codex and Claude. */
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof EFFORTS)[number];

export type RoleName = 'leader' | 'implementer';

/** A role as the header shows it; the effort is the user's choice (ADR 0010). */
export interface RoleInfo {
  readonly cli: 'codex' | 'claude';
  readonly model: string;
  readonly effort: string;
  readonly permission: PermissionLevel;
}

/** The chat session as the panel shows it in its header. */
export interface SessionInfo {
  /** Folder the agents work in; null without an open folder. */
  readonly workspace: string | null;
  readonly trusted: boolean;
  readonly leader: RoleInfo;
  readonly implementer: RoleInfo;
  readonly mode: ApprovalMode;
  /** Fake CLIs: no model turn, no quota (development only). */
  readonly fake: boolean;
  readonly busy: boolean;
  /** The chats kept for this folder, most recent first, and the one shown. */
  readonly chats: readonly {
    readonly id: string;
    readonly title: string;
    readonly updatedAt: number;
  }[];
  readonly chatId: string | null;
}

export type TurnRole = 'leader' | 'implementer';

export interface TurnUsageSummary {
  /** Context read in the turn: input, cached input and cache writes. */
  readonly context: number;
  readonly output: number;
  readonly costUsd: number | null;
  readonly durationMs: number;
}

/** One entry of the chat thread, or a change to one. */
export type ThreadUpdate =
  | { readonly type: 'user'; readonly id: string; readonly text: string }
  | {
      readonly type: 'turn';
      readonly id: string;
      readonly role: TurnRole;
      readonly agent: string;
      readonly status: 'running' | 'done' | 'failed';
      /** Written by the runtime from what the CLI reported, once the turn is done. */
      readonly label?: string;
      readonly text?: string;
      readonly usage?: TurnUsageSummary;
    }
  | { readonly type: 'chunk'; readonly turnId: string; readonly text: string }
  | { readonly type: 'activity'; readonly turnId: string; readonly text: string }
  | {
      readonly type: 'subagent';
      readonly turnId: string;
      readonly id: string;
      readonly label: string;
      readonly status: string;
    }
  | {
      /** A message between agents waiting for the user (manual mode). */
      readonly type: 'approval';
      readonly id: string;
      readonly kind: 'delegation' | 'review';
      readonly from: string;
      readonly to: string;
      readonly text: string;
    }
  | { readonly type: 'approval_closed'; readonly id: string; readonly action: string }
  | {
      /** An agent asks before acting (a command, a file change): the user answers (R9). */
      readonly type: 'permission';
      readonly id: string;
      readonly role: TurnRole;
      readonly agent: string;
      readonly summary: string;
    }
  | { readonly type: 'permission_closed'; readonly id: string; readonly decision: string }
  | { readonly type: 'notice'; readonly level: 'info' | 'warn' | 'error'; readonly text: string };

/** One usage window of a subscription, as its CLI reported it. */
export interface UsageWindow {
  /** "5h" or "weekly". */
  readonly name: string;
  readonly usedPercent: number;
  /** Unix seconds; null when not reported. */
  readonly resetsAt: number | null;
}

/** A subscription in use, for the usage view. */
export interface ProviderUsage {
  readonly provider: 'codex' | 'claude';
  readonly windows: readonly UsageWindow[];
  /** When the windows were read (ms since epoch); null before the first reading. */
  readonly updatedAt: number | null;
  /** How the windows are read, or why they are missing. */
  readonly note: string;
  /** What this chat has used so far, summed over its turns. */
  readonly chat: { readonly context: number; readonly output: number; readonly costUsd: number };
}

export type HostToWebviewMessage =
  | { readonly type: 'status'; readonly status: ExtensionStatus }
  | { readonly type: 'pong'; readonly id: number; readonly receivedAt: string }
  | { readonly type: 'session'; readonly session: SessionInfo }
  | { readonly type: 'thread'; readonly update: ThreadUpdate }
  | { readonly type: 'reset' }
  | { readonly type: 'usage'; readonly providers: readonly ProviderUsage[] };

export type ApprovalAction = 'approve' | 'edit' | 'cancel';

/** The answer to an agent's permission request; "for the session" as the CLI scopes it. */
export type PermitDecision = 'accept' | 'acceptForSession' | 'decline';

/** What a role may do without asking: nothing, ask first, or act inside the folder. */
export type PermissionLevel = 'read-only' | 'ask' | 'auto';

export type WebviewToHostMessage =
  | { readonly type: 'ready' }
  | { readonly type: 'ping'; readonly id: number }
  | { readonly type: 'send'; readonly text: string }
  | {
      readonly type: 'decide';
      readonly id: string;
      readonly action: ApprovalAction;
      readonly text?: string;
    }
  | { readonly type: 'stop' }
  | { readonly type: 'permit'; readonly id: string; readonly decision: PermitDecision }
  | { readonly type: 'setMode'; readonly mode: ApprovalMode }
  | { readonly type: 'setEffort'; readonly role: RoleName; readonly effort: Effort }
  | { readonly type: 'newChat' }
  | { readonly type: 'openChat'; readonly id: string }
  | { readonly type: 'refreshUsage' };

/** Longest text the webview may send: a large brief fits, a pasted log does not. */
export const MAX_TEXT_LENGTH = 50_000;
const ID_PATTERN = /^[a-z0-9-]{1,64}$/;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length <= MAX_TEXT_LENGTH ? value : undefined;
}

/** Validates a message received from the webview; anything unexpected is dropped. */
export function parseWebviewMessage(value: unknown): WebviewToHostMessage | undefined {
  const msg = asRecord(value);
  switch (msg?.['type']) {
    case 'ready':
      return { type: 'ready' };
    case 'ping': {
      const id = msg['id'];
      return typeof id === 'number' && Number.isSafeInteger(id) ? { type: 'ping', id } : undefined;
    }
    case 'send': {
      const body = text(msg['text']);
      return body !== undefined && body.trim() !== '' ? { type: 'send', text: body } : undefined;
    }
    case 'decide': {
      const id = msg['id'];
      const action = msg['action'];
      if (typeof id !== 'string' || !ID_PATTERN.test(id)) return undefined;
      if (action === 'approve' || action === 'cancel') return { type: 'decide', id, action };
      const edited = text(msg['text']);
      return action === 'edit' && edited !== undefined && edited.trim() !== ''
        ? { type: 'decide', id, action, text: edited }
        : undefined;
    }
    case 'stop':
      return { type: 'stop' };
    case 'permit': {
      const id = msg['id'];
      const decision = msg['decision'];
      return typeof id === 'string' &&
        ID_PATTERN.test(id) &&
        (decision === 'accept' || decision === 'acceptForSession' || decision === 'decline')
        ? { type: 'permit', id, decision }
        : undefined;
    }
    case 'setMode': {
      const mode = msg['mode'];
      return mode === 'auto' || mode === 'manual' ? { type: 'setMode', mode } : undefined;
    }
    case 'setEffort': {
      const role = msg['role'];
      const effort = (EFFORTS as readonly unknown[]).includes(msg['effort'])
        ? (msg['effort'] as Effort)
        : undefined;
      return (role === 'leader' || role === 'implementer') && effort
        ? { type: 'setEffort', role, effort }
        : undefined;
    }
    case 'newChat':
      return { type: 'newChat' };
    case 'openChat': {
      const id = msg['id'];
      return typeof id === 'string' && ID_PATTERN.test(id) ? { type: 'openChat', id } : undefined;
    }
    case 'refreshUsage':
      return { type: 'refreshUsage' };
    default:
      return undefined;
  }
}

/**
 * Validates a message received from the extension host. The host is trusted:
 * this guards against shape mistakes, not against an attacker.
 */
export function parseHostMessage(value: unknown): HostToWebviewMessage | undefined {
  const msg = asRecord(value);
  switch (msg?.['type']) {
    case 'status': {
      const status = asRecord(msg['status']);
      return status ? { type: 'status', status: status as unknown as ExtensionStatus } : undefined;
    }
    case 'pong': {
      const id = msg['id'];
      const receivedAt = msg['receivedAt'];
      return typeof id === 'number' && typeof receivedAt === 'string'
        ? { type: 'pong', id, receivedAt }
        : undefined;
    }
    case 'session': {
      const session = asRecord(msg['session']);
      return session ? { type: 'session', session: session as unknown as SessionInfo } : undefined;
    }
    case 'thread': {
      const update = asRecord(msg['update']);
      return typeof update?.['type'] === 'string'
        ? { type: 'thread', update: update as unknown as ThreadUpdate }
        : undefined;
    }
    case 'reset':
      return { type: 'reset' };
    case 'usage':
      return Array.isArray(msg['providers'])
        ? { type: 'usage', providers: msg['providers'] as ProviderUsage[] }
        : undefined;
    default:
      return undefined;
  }
}
