// Messages exchanged between the extension host and the webview.
// Imported by both sides: it must not import `vscode` or DOM-only APIs.

export interface ExtensionStatus {
  readonly extensionVersion: string;
  readonly vscodeVersion: string;
  readonly runtime: { readonly name: string; readonly version: string };
  readonly workspaceTrusted: boolean;
}

export type ApprovalMode = 'auto' | 'manual';

/** The chat session as the panel shows it in its header. */
export interface SessionInfo {
  /** Folder the agents work in; null without an open folder. */
  readonly workspace: string | null;
  readonly trusted: boolean;
  readonly leader: string;
  readonly implementer: string;
  readonly mode: ApprovalMode;
  /** Fake CLIs: no model turn, no quota (development only). */
  readonly fake: boolean;
  readonly busy: boolean;
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
  | { readonly type: 'notice'; readonly level: 'info' | 'warn' | 'error'; readonly text: string };

export type HostToWebviewMessage =
  | { readonly type: 'status'; readonly status: ExtensionStatus }
  | { readonly type: 'pong'; readonly id: number; readonly receivedAt: string }
  | { readonly type: 'session'; readonly session: SessionInfo }
  | { readonly type: 'thread'; readonly update: ThreadUpdate }
  | { readonly type: 'reset' };

export type ApprovalAction = 'approve' | 'edit' | 'cancel';

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
  | { readonly type: 'setMode'; readonly mode: ApprovalMode }
  | { readonly type: 'newChat' };

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
    case 'setMode': {
      const mode = msg['mode'];
      return mode === 'auto' || mode === 'manual' ? { type: 'setMode', mode } : undefined;
    }
    case 'newChat':
      return { type: 'newChat' };
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
    default:
      return undefined;
  }
}
