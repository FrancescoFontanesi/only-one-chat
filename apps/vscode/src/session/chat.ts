// One chat with the leader (ADR 0010, 0011), as the panel drives it. The
// leader's and the implementer's sessions live as long as the chat. A user
// message is one leader-mode loop of the runtime (answer, ask, delegate), or,
// with `@impl`, a turn of the implementer alone. Work the leader has not seen
// yet (a deferred review, a direct message) reaches it with the user's next
// message. Runtime events become thread updates for the webview. Node only,
// no `vscode`: the panel passes the configuration in, so the session can be
// tested against the fake CLIs.

import {
  CLAUDE_SUBAGENT_FORBIDDEN_NAMES,
  CODEX_SUBAGENT_FORBIDDEN_NAMES,
  createClaudeAgentFactory,
  createCodexAgentFactory,
} from '@only-one-chat/adapters';
import {
  LIGHT_IMPLEMENTER_INSTRUCTIONS,
  agentLabel,
  agentSessionOptions,
  leaderInstructions,
  openEventLog,
  pendingReportsPreface,
  runLoop,
  type AgentFactory,
  type AgentSession,
  type EventLog,
  type InterceptDecision,
  type PendingReport,
  type QuotaSnapshot,
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
  /**
   * After a delegation: `always`, the leader reviews the report at once;
   * `deferred`, it reads it with the user's next message (one leader turn less).
   */
  readonly review: 'always' | 'deferred';
  /** JSONL event log, outside the workspace. */
  readonly logPath: string;
}

/** A message for the implementer alone: `@impl` and the text. */
const DIRECT = /^@impl\b\s*/i;

export interface ChatEvents {
  update(update: ThreadUpdate): void;
  busy(busy: boolean): void;
  /** A turn ended: its CLI, what it used, and the usage windows it reported, if any. */
  turnUsage?(
    provider: string,
    usage: TurnUsageSummary | undefined,
    quota: QuotaSnapshot | null,
  ): void;
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
  /** Kept across delegations and direct messages: a follow-up costs it little (calc-small). */
  private implementerSession: AgentSession | undefined;
  /** Stops what is running now: a leader loop or a direct implementer turn. */
  private stopRunning: (() => Promise<void>) | undefined;
  private running = false;
  private nextId = 1;
  private readonly currentTurn = new Map<TurnRole, string>();
  private readonly pending = new Map<string, (decision: InterceptDecision) => void>();
  /** Implementer work the leader has not seen yet. */
  private unseen: PendingReport[] = [];
  /** The roles as configured, with the effort the user chose during the chat. */
  private readonly roles: { leader: AgentChoice; implementer: AgentChoice };

  constructor(
    private readonly config: ChatConfig,
    private readonly events: ChatEvents,
  ) {
    this.mode = config.mode;
    this.roles = { leader: config.leader, implementer: config.implementer };
  }

  /** Reasoning effort of a role from its next turn on, in the same session. */
  setEffort(role: TurnRole, effort: string): void {
    this.roles[role] = { ...this.roles[role], effort };
    const session = role === 'leader' ? this.leaderSession : this.implementerSession;
    session?.setEffort?.(effort);
  }

  get busy(): boolean {
    return this.running;
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

  /** The implementer's session, opened once and continued (ADR 0011). */
  private async implementer(): Promise<AgentSession> {
    this.implementerSession ??= await this.factory(
      this.roles.implementer,
      true,
    )(agentSessionOptions(LIGHT_IMPLEMENTER_INSTRUCTIONS, this.policy(this.roles.implementer)));
    return this.implementerSession;
  }

  /** Sends the user's message: to the leader, or with `@impl` to the implementer; one at a time. */
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
    this.running = true;
    this.events.busy(true);
    const baseline = snapshot(this.config.cwd);
    /** Set once the facts are shown, by the facts callback or the direct turn. */
    const shown = { facts: false };
    try {
      this.log ??= await openEventLog(this.config.logPath, this.config.cwd);
      if (DIRECT.test(text)) await this.toImplementer(text.replace(DIRECT, ''), baseline, shown);
      else await this.toLeader(text, baseline, shown);
    } catch (error) {
      this.events.update({
        type: 'notice',
        level: 'error',
        text: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.running = false;
      this.stopRunning = undefined;
      this.closeRunningTurns('failed');
      if (!shown.facts) {
        // Changes made with no delegation: shown, not judged.
        const changed = changes(baseline, snapshot(this.config.cwd));
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

  /** A turn of the implementer alone; its report waits for the leader. */
  private async toImplementer(
    text: string,
    baseline: ReturnType<typeof snapshot>,
    shown: { facts: boolean },
  ): Promise<void> {
    const { config } = this;
    const session = await this.implementer();
    const id = this.id('t');
    this.currentTurn.set('implementer', id);
    this.events.update({
      type: 'turn',
      id,
      role: 'implementer',
      agent: session.name,
      status: 'running',
    });
    const turn = session.runTurn(text, {
      onText: (chunk) => {
        this.events.update({ type: 'chunk', turnId: id, text: chunk });
      },
      onApprovalRequest: (request) => {
        this.events.update({
          type: 'notice',
          level: 'warn',
          text: `Richiesta di ${session.name} rifiutata: ${request.summary}`,
        });
        return Promise.resolve('decline');
      },
      onActivity: ({ kind, detail }) => {
        this.events.update({
          type: 'activity',
          turnId: id,
          text: `${kind}: ${detail.slice(0, 240)}`,
        });
      },
    });
    this.stopRunning = () => turn.stop();
    const result = await turn.done;
    this.currentTurn.delete('implementer');
    const usage = summarize(result.usage);
    this.events.update({
      type: 'turn',
      id,
      role: 'implementer',
      agent: session.name,
      status: 'done',
      label: agentLabel(result.identity),
      text: result.text,
      ...(usage ? { usage } : {}),
    });
    this.events.turnUsage?.(result.identity.provider, usage, result.quota ?? null);
    const facts = await verifiedFacts(config.cwd, baseline, config.verifyCommand);
    shown.facts = true;
    this.events.update({ type: 'notice', level: 'info', text: facts });
    this.unseen.push({ source: 'direct', request: text, report: result.text, facts });
    this.events.update({
      type: 'notice',
      level: 'info',
      text: 'Il leader leggerà questo rapporto con il tuo prossimo messaggio.',
    });
  }

  private async toLeader(
    text: string,
    baseline: ReturnType<typeof snapshot>,
    shown: { facts: boolean },
  ): Promise<void> {
    const { config } = this;
    const leaderPolicy = { ...this.policy(this.roles.leader), proactive: true };
    // Writable: on /fai, or with no implementer, it makes the change itself.
    this.leaderSession ??= await this.factory(
      this.roles.leader,
      true,
    )(agentSessionOptions(leaderInstructions(this.roles.implementer.cli), leaderPolicy));
    const unseen = this.unseen;
    this.unseen = [];
    const manual = this.mode === 'manual';
    const loop = runLoop({
      request: text,
      ...(unseen.length > 0 ? { preface: pendingReportsPreface(unseen) } : {}),
      log: this.log ?? (await openEventLog(config.logPath, config.cwd)),
      onEvent: (event) => {
        this.onEvent(event);
      },
      mode: 'leader',
      leaderSession: this.leaderSession,
      workerSession: await this.implementer(),
      review: config.review,
      autoApprove: !manual,
      orchestrator: () => Promise.reject(new Error('the leader session is given')),
      worker: () => Promise.reject(new Error('the implementer session is given')),
      subagents: { orchestrator: leaderPolicy, worker: this.policy(this.roles.implementer) },
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
    this.stopRunning = () => loop.stop();
    const outcome = await loop.done;
    if (outcome.status === 'delegated') {
      this.unseen.push({
        source: 'delegation',
        request: outcome.spec,
        report: outcome.report,
        facts: outcome.facts,
      });
      this.events.update({
        type: 'notice',
        level: 'info',
        text: 'Il leader leggerà il rapporto con il tuo prossimo messaggio.',
      });
    } else if (outcome.status !== 'completed' && outcome.status !== 'result') {
      // Something else ended the loop: what was unseen is still unseen.
      this.unseen = [...unseen, ...this.unseen];
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
    await this.stopRunning?.();
  }

  /** Ends the leader's and the implementer's sessions: the next message starts new ones. */
  async reset(): Promise<void> {
    await this.stop();
    await this.leaderSession?.close();
    await this.implementerSession?.close();
    this.leaderSession = undefined;
    this.implementerSession = undefined;
    this.unseen = [];
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
        this.events.turnUsage?.(event.identity.provider, usage, event.quota ?? null);
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
