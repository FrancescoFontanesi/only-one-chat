// The chat thread as the webview keeps it: thread updates from the host,
// applied in order. Pure functions, so the reducer is easy to follow.

import type { ThreadUpdate, TurnRole, TurnUsageSummary } from '../src/webview/protocol.js';

export interface SubagentRow {
  readonly id: string;
  readonly label: string;
  readonly status: string;
}

export type ThreadItem =
  | { readonly kind: 'user'; readonly id: string; readonly text: string }
  | {
      readonly kind: 'turn';
      readonly id: string;
      readonly role: TurnRole;
      readonly agent: string;
      readonly status: 'running' | 'done' | 'failed';
      readonly label?: string;
      readonly text: string;
      readonly usage?: TurnUsageSummary;
      readonly activity: readonly string[];
      readonly subagents: readonly SubagentRow[];
    }
  | {
      readonly kind: 'approval';
      readonly id: string;
      readonly approval: 'delegation' | 'review';
      readonly from: string;
      readonly to: string;
      readonly text: string;
      /** The user's decision, once taken. */
      readonly closed?: string;
    }
  | {
      readonly kind: 'permission';
      readonly id: string;
      readonly role: TurnRole;
      readonly agent: string;
      readonly summary: string;
      /** The user's answer, once given. */
      readonly closed?: string;
    }
  | {
      readonly kind: 'notice';
      readonly id: string;
      readonly level: 'info' | 'warn' | 'error';
      readonly text: string;
    };

/** At most this many activity lines per turn: the latest ones. */
const MAX_ACTIVITY = 200;

let noticeId = 0;

export function applyUpdate(items: readonly ThreadItem[], update: ThreadUpdate): ThreadItem[] {
  const mapTurn = (
    id: string,
    change: (turn: Extract<ThreadItem, { kind: 'turn' }>) => ThreadItem,
  ): ThreadItem[] =>
    items.map((item) => (item.kind === 'turn' && item.id === id ? change(item) : item));

  switch (update.type) {
    case 'user':
      return [...items, { kind: 'user', id: update.id, text: update.text }];
    case 'turn': {
      const known = items.some((item) => item.kind === 'turn' && item.id === update.id);
      if (!known) {
        return [
          ...items,
          {
            kind: 'turn',
            id: update.id,
            role: update.role,
            agent: update.agent,
            status: update.status,
            text: update.text ?? '',
            activity: [],
            subagents: [],
            ...(update.label ? { label: update.label } : {}),
            ...(update.usage ? { usage: update.usage } : {}),
          },
        ];
      }
      return mapTurn(update.id, (turn) => {
        // A closing "failed" from the host does not undo a turn already done.
        if (turn.status === 'done' && update.status === 'failed') return turn;
        return {
          ...turn,
          status: update.status,
          agent: update.agent || turn.agent,
          text: update.text ?? turn.text,
          ...(update.label ? { label: update.label } : {}),
          ...(update.usage ? { usage: update.usage } : {}),
        };
      });
    }
    case 'chunk':
      return mapTurn(update.turnId, (turn) => ({ ...turn, text: turn.text + update.text }));
    case 'activity':
      return mapTurn(update.turnId, (turn) => ({
        ...turn,
        activity: [...turn.activity, update.text].slice(-MAX_ACTIVITY),
      }));
    case 'subagent':
      return mapTurn(update.turnId, (turn) => {
        const row = { id: update.id, label: update.label, status: update.status };
        const exists = turn.subagents.some((s) => s.id === update.id);
        return {
          ...turn,
          subagents: exists
            ? turn.subagents.map((s) => (s.id === update.id ? row : s))
            : [...turn.subagents, row],
        };
      });
    case 'approval':
      return [
        ...items,
        {
          kind: 'approval',
          id: update.id,
          approval: update.kind,
          from: update.from,
          to: update.to,
          text: update.text,
        },
      ];
    case 'approval_closed':
      return items.map((item) =>
        item.kind === 'approval' && item.id === update.id
          ? { ...item, closed: update.action }
          : item,
      );
    case 'permission':
      return [
        ...items,
        {
          kind: 'permission',
          id: update.id,
          role: update.role,
          agent: update.agent,
          summary: update.summary,
        },
      ];
    case 'permission_closed':
      return items.map((item) =>
        item.kind === 'permission' && item.id === update.id
          ? { ...item, closed: update.decision }
          : item,
      );
    case 'notice':
      return [
        ...items,
        { kind: 'notice', id: `n-${String(noticeId++)}`, level: update.level, text: update.text },
      ];
  }
}

export function formatTokens(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(value >= 10_000 ? 0 : 1)}k` : String(value);
}
