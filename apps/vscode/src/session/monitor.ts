// What the activity view shows (ADR 0012): each role with its model, what it
// is doing now, and a log of what passed between the user and the agents,
// latest first. Built from the chat's thread updates as they happen; a chat
// reopened from the history starts an empty log. Node only, no `vscode`.

import type {
  MonitorAgent,
  MonitorEvent,
  MonitorState,
  RoleInfo,
  ThreadUpdate,
  TurnRole,
} from '../webview/protocol.js';

/** At most this many log entries, the latest. */
const MAX_EVENTS = 200;

const ROLE: Record<TurnRole, string> = { leader: 'Leader', implementer: 'Implementatore' };

const PERMIT: Record<string, string> = {
  accept: 'consentito',
  acceptForSession: 'consentito per la sessione',
  decline: 'negato',
};

const APPROVAL: Record<string, string> = {
  approve: 'approvato',
  edit: 'approvato con modifiche',
  cancel: 'annullato',
};

function oneLine(value: string, max = 90): string {
  const line = value.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

function kilo(value: number): string {
  return value >= 1000 ? `${String(Math.round(value / 1000))}k` : String(value);
}

interface AgentState {
  turns: Set<string>;
  activity: string | null;
  subagents: Map<string, string>;
}

export class MonitorStore {
  private roles: Record<TurnRole, RoleInfo> | undefined;
  private readonly agents: Record<TurnRole, AgentState> = {
    leader: { turns: new Set(), activity: null, subagents: new Map() },
    implementer: { turns: new Set(), activity: null, subagents: new Map() },
  };
  /** Turn id → role, for the updates that name only the turn. */
  private readonly turnRole = new Map<string, TurnRole>();
  /** Requests waiting for the user: id → the role that waits. */
  private readonly waiting = new Map<string, TurnRole>();
  private events: MonitorEvent[] = [];
  private readonly listeners = new Set<() => void>();

  constructor(private readonly now: () => number = Date.now) {}

  setRoles(roles: Record<TurnRole, RoleInfo>): void {
    this.roles = roles;
    this.changed();
  }

  /** Another chat is shown: nothing of the previous one is running any more. */
  reset(): void {
    for (const agent of Object.values(this.agents)) {
      agent.turns.clear();
      agent.activity = null;
      agent.subagents.clear();
    }
    this.turnRole.clear();
    this.waiting.clear();
    this.events = [];
    this.changed();
  }

  apply(update: ThreadUpdate): void {
    switch (update.type) {
      case 'user': {
        const direct = /^@impl\b/i.test(update.text);
        const to = direct ? 'Implementatore' : 'Leader';
        this.log('info', `Tu → ${to}: ${oneLine(update.text.replace(/^@impl\b\s*/i, ''))}`);
        break;
      }
      case 'turn': {
        const agent = this.agents[update.role];
        this.turnRole.set(update.id, update.role);
        if (update.status === 'running') {
          if (agent.turns.has(update.id)) break;
          agent.turns.add(update.id);
          agent.activity = null;
          this.log('info', `${ROLE[update.role]} lavora · ${update.agent}`);
        } else {
          if (!agent.turns.delete(update.id)) break;
          agent.activity = null;
          agent.subagents.clear();
          if (update.status === 'done') {
            const usage = update.usage;
            const detail = usage
              ? ` · contesto ${kilo(usage.context)} · ${(usage.durationMs / 1000).toFixed(1)} s`
              : '';
            this.log('info', `${ROLE[update.role]} ha finito${detail}`);
          } else {
            this.log('warn', `${ROLE[update.role]}: turno interrotto o non riuscito`);
          }
        }
        break;
      }
      case 'activity': {
        const role = this.turnRole.get(update.turnId);
        if (role) this.agents[role].activity = oneLine(update.text, 120);
        break;
      }
      case 'subagent': {
        const role = this.turnRole.get(update.turnId);
        if (!role) break;
        const subagents = this.agents[role].subagents;
        const known = subagents.has(update.id);
        if (update.status === 'running') {
          subagents.set(update.id, update.label);
          if (!known) this.log('info', `${ROLE[role]} ↳ sotto-agente ${oneLine(update.label, 60)}`);
        } else if (known) {
          subagents.delete(update.id);
        }
        break;
      }
      case 'approval': {
        const role: TurnRole = update.kind === 'delegation' ? 'leader' : 'implementer';
        this.waiting.set(update.id, role);
        this.log(
          'warn',
          `In attesa di te: ${update.kind === 'delegation' ? 'delega' : 'rapporto'} ${update.from} → ${update.to}`,
        );
        break;
      }
      case 'approval_closed':
        if (this.waiting.delete(update.id)) {
          this.log('info', `Messaggio fra agenti ${APPROVAL[update.action] ?? update.action}`);
        }
        break;
      case 'permission':
        this.waiting.set(update.id, update.role);
        this.log('warn', `${ROLE[update.role]} chiede il permesso: ${oneLine(update.summary)}`);
        break;
      case 'permission_closed':
        if (this.waiting.delete(update.id)) {
          this.log('info', `Permesso ${PERMIT[update.decision] ?? update.decision}`);
        }
        break;
      case 'notice':
        this.log(update.level, oneLine(update.text.split('\n')[0] ?? ''));
        break;
      case 'chunk':
        break;
    }
    this.changed();
  }

  snapshot(): MonitorState {
    const waitingRoles = new Set(this.waiting.values());
    const agents: MonitorAgent[] = this.roles
      ? (['leader', 'implementer'] as const).map((role) => {
          const agent = this.agents[role];
          return {
            role,
            info: this.roles?.[role] as RoleInfo,
            status: waitingRoles.has(role) ? 'waiting' : agent.turns.size > 0 ? 'working' : 'idle',
            activity: agent.activity,
            subagents: [...agent.subagents.values()],
          };
        })
      : [];
    return { agents, events: [...this.events] };
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private log(level: MonitorEvent['level'], text: string): void {
    this.events = [{ at: this.now(), level, text }, ...this.events].slice(0, MAX_EVENTS);
  }

  private changed(): void {
    for (const listener of this.listeners) listener();
  }
}
