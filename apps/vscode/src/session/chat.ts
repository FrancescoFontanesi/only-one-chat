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
  startPermissionBridge,
  type PermissionBridge,
  type PermissionBridgeOptions,
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
  PermissionLevel,
  PermitDecision,
  ThreadUpdate,
  TurnRole,
  TurnUsageSummary,
} from '../webview/protocol.js';
import { changes, snapshot, verifiedFacts } from './facts.js';

export interface AgentChoice {
  readonly cli: 'codex' | 'claude';
  readonly model: string;
  readonly effort: string;
  readonly permission: PermissionLevel;
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
  /**
   * The PermissionRequest hook for Claude roles that may write (R9): the
   * script and the Node that runs it. Absent: their requests are denied.
   */
  readonly permissionHook?: PermissionBridgeOptions;
  /** The CLIs' own sessions of a reopened chat, to continue (R5). */
  readonly resume?: Partial<Record<TurnRole, string>>;
  /** Codex threads kept in Codex's history, so the chat can be reopened (R5). */
  readonly persistent?: boolean;
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
  /** A role's CLI reported its own session id: to resume the chat later. */
  sessionId?(role: TurnRole, id: string): void;
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
  /** The permission bridges of the Claude roles, for the chat. */
  private readonly bridges = new Map<TurnRole, PermissionBridge>();
  /** Agents' permission requests waiting for the user (R9). */
  private readonly permissions = new Map<string, (decision: PermitDecision) => void>();
  /** Implementer work the leader has not seen yet. */
  private unseen: PendingReport[] = [];
  /** Sessions of a reopened chat not resumed yet. */
  private readonly resumable = new Map<TurnRole, string>();
  /** The roles as configured, with the effort the user chose during the chat. */
  private readonly roles: { leader: AgentChoice; implementer: AgentChoice };

  constructor(
    private readonly config: ChatConfig,
    private readonly events: ChatEvents,
  ) {
    this.mode = config.mode;
    this.roles = { leader: config.leader, implementer: config.implementer };
    for (const [role, id] of Object.entries(config.resume ?? {}) as [TurnRole, string][]) {
      this.resumable.set(role, id);
    }
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

  /**
   * A role's sessions, with its permission level (ADR 0011): `read-only`
   * writes nothing; `auto` acts inside the folder and asks to go beyond it;
   * `ask` asks before acting (Codex: before any command it does not know to
   * be safe).
   */
  private factory(choice: AgentChoice, bridge: PermissionBridge | undefined): AgentFactory {
    const { config } = this;
    const writable = choice.permission !== 'read-only';
    return choice.cli === 'codex'
      ? createCodexAgentFactory({
          executable: config.codexExecutable,
          ...(config.codexLauncherArgs ? { launcherArgs: config.codexLauncherArgs } : {}),
          cwd: config.cwd,
          model: choice.model,
          effort: choice.effort,
          requestTimeoutMs: 120_000,
          writable,
          approvalPolicy: choice.permission === 'ask' ? 'untrusted' : 'on-request',
          persistent: config.persistent === true,
        })
      : createClaudeAgentFactory({
          executable: config.claudeExecutable,
          ...(config.claudeLauncherArgs ? { launcherArgs: config.claudeLauncherArgs } : {}),
          cwd: config.cwd,
          model: choice.model,
          effort: choice.effort,
          ...(writable ? { sandbox: { commands: config.allowedCommands } } : {}),
          ...(bridge
            ? {
                permissionHook: {
                  settings: bridge.settings,
                  env: bridge.env,
                  askAll: choice.permission === 'ask',
                },
              }
            : {}),
        });
  }

  /**
   * A Claude role that may write asks the user through a PermissionRequest
   * hook (R9): one bridge per role, for the chat. Codex asks through its own
   * protocol, so it needs none.
   */
  private async bridgeFor(role: TurnRole): Promise<PermissionBridge | undefined> {
    const choice = this.roles[role];
    const hook = this.config.permissionHook;
    if (choice.cli !== 'claude' || choice.permission === 'read-only' || !hook) return undefined;
    let bridge = this.bridges.get(role);
    if (!bridge) {
      bridge = await startPermissionBridge(
        (request) => this.askPermission(role, `Claude (${choice.model})`, request.summary),
        hook,
      );
      this.bridges.set(role, bridge);
    }
    return bridge;
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

  /** The session to resume for a role, once: a later reset starts new ones. */
  private resumeOf(role: TurnRole): { resume?: string } {
    const id = this.resumable.get(role);
    this.resumable.delete(role);
    return id ? { resume: id } : {};
  }

  /** The implementer's session, opened once and continued (ADR 0011). */
  private async implementer(): Promise<AgentSession> {
    this.implementerSession ??= await this.factory(
      this.roles.implementer,
      await this.bridgeFor('implementer'),
    )({
      ...agentSessionOptions(LIGHT_IMPLEMENTER_INSTRUCTIONS, this.policy(this.roles.implementer)),
      ...this.resumeOf('implementer'),
    });
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
      onApprovalRequest: (request) =>
        this.askPermission('implementer', session.name, request.summary),
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
    if (result.identity.sessionId)
      this.events.sessionId?.('implementer', result.identity.sessionId);
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
      await this.bridgeFor('leader'),
    )({
      ...agentSessionOptions(leaderInstructions(this.roles.implementer.cli), leaderPolicy),
      ...this.resumeOf('leader'),
    });
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
      onApproval: ({ role, agent, request }, signal) =>
        this.askPermission(roleOf(role), agent, request.summary, signal),
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

  /** Shows an agent's permission request and waits for the user; stopping declines it. */
  private askPermission(
    role: TurnRole,
    agent: string,
    summary: string,
    signal?: AbortSignal,
  ): Promise<PermitDecision> {
    return new Promise((resolve) => {
      const id = this.id('p');
      this.permissions.set(id, resolve);
      signal?.addEventListener('abort', () => {
        this.permit(id, 'decline');
      });
      this.events.update({ type: 'permission', id, role, agent, summary });
    });
  }

  /** The user's answer to a permission request. */
  permit(id: string, decision: PermitDecision): void {
    const resolve = this.permissions.get(id);
    if (!resolve) return;
    this.permissions.delete(id);
    resolve(decision);
    this.events.update({ type: 'permission_closed', id, decision });
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
    // Whatever is still waiting for the user is declined.
    for (const id of [...this.permissions.keys()]) this.permit(id, 'decline');
    await this.stopRunning?.();
  }

  /** Ends the leader's and the implementer's sessions: the next message starts new ones. */
  async reset(): Promise<void> {
    await this.stop();
    await this.leaderSession?.close();
    await this.implementerSession?.close();
    this.leaderSession = undefined;
    this.implementerSession = undefined;
    await Promise.allSettled([...this.bridges.values()].map((bridge) => bridge.close()));
    this.bridges.clear();
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
        if (event.identity.sessionId) this.events.sessionId?.(role, event.identity.sessionId);
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
