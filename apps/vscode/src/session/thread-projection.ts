// The runtime's events as thread updates for the webview: the card of each
// role's running turn, and the events that need nothing else of the chat. The
// events that change the chat's state stay with ChatSession. Node only, no
// `vscode`.

import { GATE_SENT_BACK_HEADER, type ThreadEvent } from '@only-one-chat/runtime';
import type { ThreadUpdate, TurnRole } from '../shared/protocol.js';
import { roleOf } from './chat-types.js';

export class TurnTracker {
  /** The card id of each role's running turn. */
  private readonly current = new Map<TurnRole, string>();

  constructor(private readonly update: (update: ThreadUpdate) => void) {}

  /** A role's turn started: its card shows it running. */
  start(role: TurnRole, id: string, agent: string): void {
    this.current.set(role, id);
    this.update({ type: 'turn', id, role, agent, status: 'running' });
  }

  /** A role's turn ended: its card id, if one was running, for the caller to close. */
  end(role: TurnRole): string | undefined {
    const id = this.current.get(role);
    this.current.delete(role);
    return id;
  }

  /** Closes the cards of the turns still running. */
  closeRunning(status: 'done' | 'failed'): void {
    for (const [role, id] of this.current) {
      this.update({ type: 'turn', id, role, agent: '', status });
    }
    this.current.clear();
  }

  clear(): void {
    this.current.clear();
  }

  /** An event that changes nothing of the chat, as its thread update; the others are ignored. */
  project(event: ThreadEvent): void {
    const update = this.update;
    switch (event.type) {
      case 'text': {
        const turnId = this.current.get(roleOf(event.role));
        if (turnId) update({ type: 'chunk', turnId, text: event.text });
        break;
      }
      case 'step': {
        const turnId = this.current.get(roleOf(event.role));
        if (turnId) update({ type: 'step', turnId, step: event.step });
        break;
      }
      case 'activity':
      case 'subagent_activity': {
        const turnId = this.current.get(roleOf(event.role));
        const prefix = event.type === 'subagent_activity' ? '↳ ' : '';
        if (turnId) {
          update({
            type: 'activity',
            turnId,
            text: `${prefix}${event.kind}: ${event.detail.slice(0, 240)}`,
          });
        }
        break;
      }
      case 'subagent': {
        const turnId = this.current.get(roleOf(event.role));
        if (turnId) {
          update({
            type: 'subagent',
            turnId,
            id: event.subagent.id,
            label: event.label,
            status: event.subagent.status,
          });
        }
        break;
      }
      case 'approval_denied':
        update({
          type: 'notice',
          level: 'warn',
          text: `Request from ${event.agent} denied: ${event.request.summary}`,
        });
        break;
      case 'gate_sent_back':
        update({
          type: 'notice',
          level: 'warn',
          text: `${GATE_SENT_BACK_HEADER}\n${event.status} — ${event.summary}`,
        });
        break;
      case 'reviewed': {
        const verdict = event.verdict
          ? event.verdict.replace('_', ' ').toUpperCase()
          : 'NO VERDICT';
        const rounds =
          event.rounds === 1 ? '1 correction round' : `${String(event.rounds)} correction rounds`;
        update({
          type: 'notice',
          level: event.verdict === 'rejected' || event.verdict === null ? 'warn' : 'info',
          text: `Review by ${event.reviewer}: ${verdict} · ${rounds}${event.verification ? ` · Runtime ${event.verification}` : ''}`,
        });
        break;
      }
      case 'contract':
        update({ type: 'notice', level: 'warn', text: event.message });
        break;
      case 'delegation_invalid':
        update({
          type: 'notice',
          level: 'warn',
          text: `Invalid delegation call: ${event.errors.join('; ')}`,
        });
        break;
      case 'subagent_violation':
      case 'error':
        update({ type: 'notice', level: 'error', text: event.message });
        break;
      default:
        break;
    }
  }
}
