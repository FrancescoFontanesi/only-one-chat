// One chat with the leader (ADR 0010), as the panel drives it. The leader's
// session lives as long as the chat; each user message is one leader-mode loop
// of the runtime, which answers, changes the code or delegates to the
// implementer. Runtime events become thread updates for the webview. Node
// only, no `vscode`: the panel passes the configuration in, so the session
// can be tested against the fake CLIs.

import {
  CLAUDE_SUBAGENT_FORBIDDEN_NAMES,
  CODEX_SUBAGENT_FORBIDDEN_NAMES,
  createClaudeAgentFactory,
  createCodexAgentFactory,
} from '@only-one-chat/adapters';
import {
  agentSessionOptions,
  leaderInstructions,
  openEventLog,
  runLoop,
  type AgentFactory,
  type AgentSession,
  type EventLog,
  type InterceptDecision,
  type Loop,
  type SubagentPolicy,
  type ThreadEvent,
  type TurnUsage,
} from '@only-one-chat/runtime';
import type {
  ApprovalAction,
  ApprovalMode,
  ThreadUpdate,
  TurnRole,
  TurnUsageSummary,
} from '../webview/protocol.js';
import { changes, snapshot, verifiedFacts } from './facts.js';

export interface AgentChoice {
  readonly cli: 'codex' | 'claude';
  readonly model: string;
  readonly effort: string;
}

export interface ChatConfig {
  /** The folder the agents work in, and the only one they may change. */
  readonly cwd: string;
  readonly leader: AgentChoice;
  readonly implementer: AgentChoice;
  /** Sub-agent model and effort per CLI (D13). */
  readonly subagents: {
    readonly codex: { readonly model: string; readonly effort: string };
    readonly claude: { readonly model: string; readonly effort: string };
  };
  readonly codexExecutable: string;
  readonly claudeExecutable: string;
  /** Arguments before each CLI's own: the fake CLIs' scripts in fake mode. */
  readonly codexLauncherArgs?: readonly string[];
  readonly claudeLauncherArgs?: readonly string[];
  /** Commands Claude may run without asking (ADR 0008). */
  readonly allowedCommands: readonly string[];
  /** Run again by the runtime after each delegation; empty: none. */
  readonly verifyCommand: readonly string[];
  readonly mode: ApprovalMode;
  /** JSONL event log, outside the workspace. */
  readonly logPath: string;
}

export interface ChatEvents {
  update(update: ThreadUpdate): void;
  busy(busy: boolean): void;
}

function summarize(usage: TurnUsage | undefined): TurnUsageSummary | undefined {
  if (!usage) return undefined;
  const models = Object.values(usage.byModel);
  return {
    context: models.reduce((sum, m) => sum + m.input + m.cachedInput + m.cacheWrite, 0),
    output: models.reduce((sum, m) => sum + m.output, 0),
    costUsd: usage.costUsd,
    durationMs: usage.durationMs,
  };
}

const roleOf = (role: 'orchestrator' | 'worker'): TurnRole =>
  role === 'orchestrator' ? 'leader' : 'implementer';

export class ChatSession {
  private mode: ApprovalMode;
  private log: EventLog | undefined;
  private leaderSession: AgentSession | undefined;
  private running: Loop | undefined;
  private nextId = 1;
  private readonly currentTurn = new Map<TurnRole, string>();
  private readonly pending = new Map<string, (decision: InterceptDecision) => void>();

  constructor(
    private readonly config: ChatConfig,
    private readonly events: ChatEvents,
  ) {
    this.mode = config.mode;
  }

  get busy(): boolean {
    return this.running !== undefined;
  }

  setMode(mode: ApprovalMode): void {
    this.mode = mode;
  }

  private id(prefix: string): string {
    return `${prefix}-${String(this.nextId++)}`;
  }

  private factory(choice: AgentChoice, writable: boolean): AgentFactory {
    const { config } = this;
    return choice.cli === 'codex'
      ? createCodexAgentFactory({
          executable: config.codexExecutable,
          ...(config.codexLauncherArgs ? { launcherArgs: config.codexLauncherArgs } : {}),
          cwd: config.cwd,
          model: choice.model,
          effort: choice.effort,
          requestTimeoutMs: 120_000,
          writable,
        })
      : createClaudeAgentFactory({
          executable: config.claudeExecutable,
          ...(config.claudeLauncherArgs ? { launcherArgs: config.claudeLauncherArgs } : {}),
          cwd: config.cwd,
          model: choice.model,
          effort: choice.effort,
          ...(writable ? { sandbox: { commands: config.allowedCommands } } : {}),
        });
  }

  private policy(choice: AgentChoice): SubagentPolicy {
    const sub = this.config.subagents[choice.cli];
    return {
      ...sub,
      maxConcurrent: 2,
      forbiddenNames:
        choice.cli === 'codex' ? CODEX_SUBAGENT_FORBIDDEN_NAMES : CLAUDE_SUBAGENT_FORBIDDEN_NAMES,
    };
  }

  /** Sends the user's message to the leader; one at a time. */
  async send(text: string): Promise<void> {
    if (this.running) {
      this.events.update({
        type: 'notice',
        level: 'warn',
        text: 'Un messaggio è già in corso: aspetta o fermalo.',
      });
      return;
    }
    this.events.update({ type: 'user', id: this.id('u'), text });
    this.events.busy(true);
    const { config } = this;
    const baseline = snapshot(config.cwd);
    /** Set by the facts callback, which runs inside the loop. */
    const shown = { facts: false };
    try {
      this.log ??= await openEventLog(config.logPath, config.cwd);
      const leaderPolicy = { ...this.policy(config.leader), proactive: true };
      // The leader writes too: it makes the small, focused changes itself.
      this.leaderSession ??= await this.factory(
        config.leader,
        true,
      )(agentSessionOptions(leaderInstructions(config.implementer.cli), leaderPolicy));
      const manual = this.mode === 'manual';
      const loop = runLoop({
        request: text,
        log: this.log,
        onEvent: (event) => {
          this.onEvent(event);
        },
        mode: 'leader',
        leaderSession: this.leaderSession,
        autoApprove: !manual,
        orchestrator: () => Promise.reject(new Error('the leader session is given')),
        worker: this.factory(config.implementer, true),
        subagents: { orchestrator: leaderPolicy, worker: this.policy(config.implementer) },
        facts: async () => {
          const facts = await verifiedFacts(config.cwd, baseline, config.verifyCommand);
          shown.facts = true;
          this.events.update({ type: 'notice', level: 'info', text: facts });
          return facts;
        },
        intercept: (message, signal) =>
          new Promise<InterceptDecision>((resolve, reject) => {
            const id = this.id('a');
            this.pending.set(id, resolve);
            signal.addEventListener('abort', () => {
              this.pending.delete(id);
              reject(new Error('stopped'));
            });
            this.events.update({
              type: 'approval',
              id,
              kind: message.kind,
              from: message.from,
              to: message.to,
              text: message.text,
            });
          }),
        // A malformed block: the leader rewrites it once, then the loop stops.
        onMalformedDelegation: (problem) =>
          Promise.resolve(
            problem.canAskOrchestrator ? { action: 'ask_orchestrator' } : { action: 'cancel' },
          ),
      });
      this.running = loop;
      await loop.done;
    } catch (error) {
      this.events.update({
        type: 'notice',
        level: 'error',
        text: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.running = undefined;
      this.closeRunningTurns('failed');
      if (!shown.facts) {
        // Changes the leader made itself, with no delegation: shown, not judged.
        const changed = changes(baseline, snapshot(config.cwd));
        if (changed !== 'unknown' && changed.length > 0) {
          this.events.update({
            type: 'notice',
            level: 'info',
            text: ['File cambiati:', ...changed.map((c) => `- ${c}`)].join('\n'),
          });
        }
      }
      this.events.busy(false);
    }
  }

  /** The user's decision on a message between agents (manual mode). */
  decide(id: string, action: ApprovalAction, text?: string): void {
    const resolve = this.pending.get(id);
    if (!resolve) return;
    this.pending.delete(id);
    resolve(
      action === 'edit' && text !== undefined
        ? { action: 'edit', text }
        : { action: action === 'cancel' ? 'cancel' : 'approve' },
    );
    this.events.update({ type: 'approval_closed', id, action });
  }

  async stop(): Promise<void> {
    await this.running?.stop();
  }

  /** Ends the leader's session: the next message starts a new one. */
  async reset(): Promise<void> {
    await this.stop();
    await this.leaderSession?.close();
    this.leaderSession = undefined;
    this.currentTurn.clear();
  }

  async dispose(): Promise<void> {
    await this.reset();
  }

  private closeRunningTurns(status: 'done' | 'failed'): void {
    for (const [role, id] of this.currentTurn) {
      this.events.update({ type: 'turn', id, role, agent: '', status });
    }
    this.currentTurn.clear();
  }

  private onEvent(event: ThreadEvent): void {
    const update = (u: ThreadUpdate) => {
      this.events.update(u);
    };
    switch (event.type) {
      case 'turn_started': {
        const id = this.id('t');
        const role = roleOf(event.role);
        this.currentTurn.set(role, id);
        update({ type: 'turn', id, role, agent: event.agent, status: 'running' });
        break;
      }
      case 'text': {
        const turnId = this.currentTurn.get(roleOf(event.role));
        if (turnId) update({ type: 'chunk', turnId, text: event.text });
        break;
      }
      case 'message': {
        const role = roleOf(event.role);
        const id = this.currentTurn.get(role);
        if (!id) break;
        this.currentTurn.delete(role);
        const usage = summarize(event.usage);
        update({
          type: 'turn',
          id,
          role,
          agent: event.agent,
          status: 'done',
          label: event.label,
          text: event.text,
          ...(usage ? { usage } : {}),
        });
        break;
      }
      case 'activity':
      case 'subagent_activity': {
        const turnId = this.currentTurn.get(roleOf(event.role));
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
        const turnId = this.currentTurn.get(roleOf(event.role));
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
          text: `Richiesta di ${event.agent} rifiutata: ${event.request.summary}`,
        });
        break;
      case 'delegation_invalid':
        update({
          type: 'notice',
          level: 'warn',
          text: `Blocco di delega non valido: ${event.errors.join('; ')}`,
        });
        break;
      case 'subagent_violation':
      case 'attribution_warning':
      case 'error':
        update({ type: 'notice', level: 'error', text: event.message });
        break;
      default:
        break;
    }
  }
}
