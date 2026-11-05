// One chat with the leader (ADR 0010, 0011, 0018), as the panel drives it. The
// leader's and the implementer's sessions live as long as the chat; the
// leader's is read-only. A user message is one leader-mode loop of the runtime
// (an answer, or a delegation and its review), or a turn of the implementer
// alone. A delegation held for the user (manual delivery) is kept with the
// chat until decided. Work the leader has not seen
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
  type ContextUsage,
  type QuotaSnapshot,
  type SubagentPolicy,
  type SkillRef,
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
import type { Checkpoint, CheckpointStore } from './checkpoints.js';
import { changes, snapshot, verifiedFacts } from './facts.js';
import { plainRefs } from './mentions.js';

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
  /** Records the folder before each message, for the review and the restore (ADR 0014). */
  readonly checkpoints?: CheckpointStore;
  /** The user's own instructions per role, added to the role's (ADR 0013). */
  readonly instructions?: Partial<Record<TurnRole, string>>;
  /** Implementer work of a reopened chat the leader has not seen yet (R5). */
  readonly unseen?: readonly PendingReport[];
  /** A delegation of a reopened chat still waiting for the user (ADR 0018). */
  readonly draft?: DraftDelegation;
  /** Notes on files the user put back, not received yet by each role (ADR 0014). */
  readonly fileNotes?: Partial<FileNotes>;
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

/**
 * What the implementer is asked for a handoff (ADR 0017): its session closes
 * and a new one of the same model continues without seeing this conversation.
 */
const HANDOFF_REQUEST = [
  'Passaggio di consegne. Questa sessione sta per chiudersi: il lavoro continua in una sessione nuova',
  'dello stesso modello, che non vedrà questa conversazione. Scrivi per quella sessione un passaggio',
  'di consegne completo ma conciso: obiettivo, stato attuale, file toccati e perché, decisioni prese,',
  'problemi aperti, prossimi passi, comandi utili per verificare. Non modificare file e non eseguire',
  'comandi: scrivi solo il testo.',
].join('\n');

/** How the new session receives the handoff, after its instructions. */
const HANDOFF_PREFACE =
  'Continui il lavoro di una sessione precedente di questo ruolo. Il suo passaggio di consegne:';

/** A delegation held for the user, kept with the chat until decided (ADR 0018). */
export interface DraftDelegation {
  /** The id of its card in the thread. */
  readonly id: string;
  readonly text: string;
  readonly from: string;
  readonly to: string;
}

/** The leader never writes (ADR 0018): whatever the settings say, its session is read-only. */
const readOnly = (choice: AgentChoice): AgentChoice => ({ ...choice, permission: 'read-only' });

/** Notes on files the user put back (ADR 0014), per role, until each receives them. */
export type FileNotes = Readonly<Record<TurnRole, readonly string[]>>;

export interface ChatEvents {
  update(update: ThreadUpdate): void;
  busy(busy: boolean): void;
  /** A role's CLI reported its own session id: to resume the chat later. */
  sessionId?(role: TurnRole, id: string): void;
  /** The implementer work the leader has not seen changed: to keep it with the chat. */
  unseen?(reports: readonly PendingReport[]): void;
  /** The notes on files put back that each role has not received yet changed. */
  fileNotes?(notes: FileNotes): void;
  /** A delegation now waits for the user, or no longer does: to keep it with the chat. */
  draft?(draft: DraftDelegation | null): void;
  /** A role's session context after a turn: how full it is. */
  context?(role: TurnRole, context: ContextUsage): void;
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
  /** The handoff the implementer's next session starts from, until it is opened. */
  private handoffBrief: string | undefined;
  /** Stops what is running now: a leader loop or a direct implementer turn. */
  private stopRunning: (() => Promise<void>) | undefined;
  private running = false;
  private nextId = 1;
  private readonly tag = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
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
  /** The CLIs' own session of each role, as last reported. */
  private readonly nativeSessions = new Map<TurnRole, string>();
  /** Files the user put back, not told yet to each role. */
  private readonly fileNotes: Record<TurnRole, string[]>;
  /** Roles whose session is reopened with new rules before their next turn. */
  private readonly reopen = new Set<TurnRole>();
  /** The roles as configured, with the effort the user chose during the chat. */
  private readonly roles: { leader: AgentChoice; implementer: AgentChoice };
  /** The delegation of a reopened chat still waiting for the user; sent from here. */
  private restored: DraftDelegation | undefined;
  /** The message held for the user now, as the loop showed it. */
  private held: DraftDelegation | undefined;
  /** The chat is being closed: what waits for the user stays kept with it. */
  private closing = false;
  /** The latest message between agents the loop showed, for the card of one that went on by itself. */
  private lastIntercepted: { from: string; to: string; text: string } | undefined;

  constructor(
    private readonly config: ChatConfig,
    private readonly events: ChatEvents,
  ) {
    this.mode = config.mode;
    this.roles = { leader: readOnly(config.leader), implementer: config.implementer };
    this.restored = config.draft;
    this.unseen = [...(config.unseen ?? [])];
    this.fileNotes = {
      leader: [...(config.fileNotes?.leader ?? [])],
      implementer: [...(config.fileNotes?.implementer ?? [])],
    };
    for (const [role, id] of Object.entries(config.resume ?? {}) as [TurnRole, string][]) {
      this.resumable.set(role, id);
    }
  }

  /**
   * The user's choice for a role during the chat (ADR 0012), from the role's
   * next turn and always in the role's own CLI session: model and effort go to
   * the same session; another permission level reopens that session with the
   * new rules. Another CLI is not applied: the chat keeps its providers, since
   * moving the work to another provider is a handoff (to be designed). The
   * leader keeps its model too: without a handoff of the leader, its
   * conversation stays with the model it began with.
   * Returns false when the choice was not applied in full.
   */
  setRole(role: TurnRole, choice: AgentChoice): boolean {
    if (role === 'leader') choice = readOnly(choice);
    const before = this.roles[role];
    if (choice.cli !== before.cli) return false;
    const locked = role === 'leader' && choice.model !== before.model;
    if (locked) choice = { ...choice, model: before.model };
    this.roles[role] = choice;
    const session = role === 'leader' ? this.leaderSession : this.implementerSession;
    if (choice.permission !== before.permission && session) {
      this.reopen.add(role);
      return !locked;
    }
    if (choice.model !== before.model) session?.setModel?.(choice.model);
    if (choice.effort !== before.effort) session?.setEffort?.(choice.effort);
    return !locked;
  }

  /** The roles of this chat, with the user's changes. */
  get currentRoles(): { readonly leader: AgentChoice; readonly implementer: AgentChoice } {
    return { ...this.roles };
  }

  /** Sessions reopened with new rules: before a message, never during a turn. */
  private async applyRoleChanges(): Promise<void> {
    for (const role of this.reopen) {
      this.reopen.delete(role);
      const session = role === 'leader' ? this.leaderSession : this.implementerSession;
      if (role === 'leader') this.leaderSession = undefined;
      else this.implementerSession = undefined;
      await session?.close();
      await this.bridges.get(role)?.close();
      this.bridges.delete(role);
      const native = this.nativeSessions.get(role);
      if (native) this.resumable.set(role, native);
    }
  }

  /** A role's CLI reported its own session: to resume it, now or in a reopened chat. */
  private noteSession(role: TurnRole, id: string): void {
    if (id === '') return;
    this.nativeSessions.set(role, id);
    this.events.sessionId?.(role, id);
  }

  get busy(): boolean {
    return this.running;
  }

  setMode(mode: ApprovalMode): void {
    this.mode = mode;
  }

  /** Ids unique across the sessions of a chat: a reopened chat redraws the earlier ones. */
  private id(prefix: string): string {
    return `${prefix}-${this.tag}-${String(this.nextId++)}`;
  }

  /**
   * A role's sessions, with its permission level (ADR 0011): `read-only`
   * writes nothing; `auto` acts inside the folder and asks to go beyond it;
   * `ask` asks before acting (Codex: before any command it does not know to
   * be safe). The leader is read-only and still runs commands to search and
   * check (ADR 0018): Codex in its read-only sandbox, never asking to leave
   * it; Claude with the commands it counts as read-only.
   */
  private factory(
    role: TurnRole,
    choice: AgentChoice,
    bridge: PermissionBridge | undefined,
  ): AgentFactory {
    const { config } = this;
    const leader = role === 'leader';
    const writable = !leader && choice.permission !== 'read-only';
    return choice.cli === 'codex'
      ? createCodexAgentFactory({
          executable: config.codexExecutable,
          ...(config.codexLauncherArgs ? { launcherArgs: config.codexLauncherArgs } : {}),
          cwd: config.cwd,
          model: choice.model,
          effort: choice.effort,
          requestTimeoutMs: 120_000,
          writable,
          approvalPolicy: leader
            ? 'never'
            : choice.permission === 'ask'
              ? 'untrusted'
              : 'on-request',
          persistent: config.persistent === true,
        })
      : createClaudeAgentFactory({
          executable: config.claudeExecutable,
          ...(config.claudeLauncherArgs ? { launcherArgs: config.claudeLauncherArgs } : {}),
          cwd: config.cwd,
          model: choice.model,
          effort: choice.effort,
          ...(writable ? { sandbox: { commands: config.allowedCommands } } : {}),
          ...(leader ? { readOnlyShell: true } : {}),
          // The model loads a skill by itself, as Codex does (ADR 0019).
          skills: true,
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
        (request) =>
          this.askPermission(role, `Claude (${this.roles[role].model})`, request.summary),
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

  /** The role's instructions, followed by the user's own for it, if any (ADR 0013). */
  private withUserInstructions(role: TurnRole, instructions: string): string {
    const own = this.config.instructions?.[role]?.trim();
    return own
      ? `${instructions}\n\nIstruzioni dell’utente per questo ruolo:\n${own}`
      : instructions;
  }

  /** The session to resume for a role, once: a later reset starts new ones. */
  private resumeOf(role: TurnRole): { resume?: string } {
    const id = this.resumable.get(role);
    this.resumable.delete(role);
    return id ? { resume: id } : {};
  }

  /**
   * The implementer's session, opened once and continued (ADR 0011); after a
   * handoff, a new one that starts from it (ADR 0017).
   */
  private async implementer(): Promise<AgentSession> {
    if (!this.implementerSession) {
      const brief = this.handoffBrief;
      this.handoffBrief = undefined;
      const instructions = this.withUserInstructions('implementer', LIGHT_IMPLEMENTER_INSTRUCTIONS);
      this.implementerSession = await this.factory(
        'implementer',
        this.roles.implementer,
        await this.bridgeFor('implementer'),
      )({
        ...agentSessionOptions(
          brief ? `${instructions}\n\n${HANDOFF_PREFACE}\n${brief}` : instructions,
          this.policy(this.roles.implementer),
        ),
        ...this.resumeOf('implementer'),
      });
    }
    return this.implementerSession;
  }

  /** Whether the implementer has a session to hand off: open, or one a reopened chat continues. */
  private hasImplementerSession(): boolean {
    return (
      this.implementerSession !== undefined ||
      this.resumable.has('implementer') ||
      this.nativeSessions.has('implementer')
    );
  }

  /**
   * Hands the implementer's work to a new session of the same model (ADR
   * 0017): its session writes a handoff in a turn shown in the thread, is
   * closed and forgotten, and the next one starts with that handoff in its
   * instructions. Not while a message runs, nor before its first turn.
   */
  async handoff(): Promise<void> {
    if (this.running) {
      this.events.update({
        type: 'notice',
        level: 'warn',
        text: 'Un messaggio è in corso: l’handoff si fa quando finisce.',
      });
      return;
    }
    if (!this.hasImplementerSession()) {
      this.events.update({
        type: 'notice',
        level: 'info',
        text: 'L’implementatore non ha ancora una sessione da passare: parte già da zero.',
      });
      return;
    }
    this.running = true;
    this.events.busy(true);
    try {
      await this.applyRoleChanges();
      const session = await this.implementer();
      const result = await this.implementerTurn(session, HANDOFF_REQUEST, false);
      if (result.text.trim() === '') {
        throw new Error(
          'L’implementatore non ha scritto il passaggio di consegne: la sessione resta quella di prima.',
        );
      }
      this.implementerSession = undefined;
      await session.close();
      await this.bridges.get('implementer')?.close();
      this.bridges.delete('implementer');
      this.nativeSessions.delete('implementer');
      this.resumable.delete('implementer');
      // A reopened chat must not resume the session that was handed off.
      this.events.sessionId?.('implementer', '');
      this.events.context?.('implementer', { used: 0, window: result.context?.window ?? null });
      this.handoffBrief = result.text;
      this.events.update({
        type: 'notice',
        level: 'info',
        text: `Handoff: la prossima sessione dell’implementatore (${this.roles.implementer.model}) parte da questo passaggio di consegne.`,
      });
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
      this.events.busy(false);
    }
  }

  /**
   * One turn of the implementer, shown in the thread as it runs; `keep` notes
   * its session to resume (not for a handoff, whose session is closed).
   */
  private async implementerTurn(
    session: AgentSession,
    prompt: string,
    keep: boolean,
    skill?: SkillRef,
  ) {
    const id = this.id('t');
    this.currentTurn.set('implementer', id);
    this.events.update({
      type: 'turn',
      id,
      role: 'implementer',
      agent: session.name,
      status: 'running',
    });
    const turn = session.runTurn(
      prompt,
      {
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
      },
      skill ? { skill } : undefined,
    );
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
    if (result.context) this.events.context?.('implementer', result.context);
    if (keep) this.noteSession('implementer', result.identity.sessionId);
    return result;
  }

  /**
   * The user put files back as they were (ADR 0014): each role is told with
   * its next message, since its context still holds the changes.
   */
  noteFiles(note: string): void {
    this.fileNotes.leader.push(note);
    this.fileNotes.implementer.push(note);
    this.events.fileNotes?.(this.pendingNotes());
  }

  /** The notes each role has not received yet: kept with the chat (R5). */
  private pendingNotes(): FileNotes {
    return { leader: [...this.fileNotes.leader], implementer: [...this.fileNotes.implementer] };
  }

  private takeNotes(role: TurnRole): string | undefined {
    const notes = this.fileNotes[role].splice(0);
    if (notes.length === 0) return undefined;
    this.events.fileNotes?.(this.pendingNotes());
    return [
      'Nota del runtime: dopo il lavoro precedente l’utente ha rimesso dei file com’erano. Conta il',
      'contenuto attuale su disco: rileggilo prima di basarti su quello che ricordi.',
      ...notes.map((note) => `- ${note}`),
    ].join('\n');
  }

  /** The folder recorded before a message (ADR 0014); null without a store or when it cannot be. */
  private checkpoint(): Checkpoint | null {
    const store = this.config.checkpoints;
    if (!store) return null;
    try {
      const checkpoint = store.take(this.id('ckpt'));
      if (!checkpoint) {
        this.events.update({
          type: 'notice',
          level: 'warn',
          text: 'Nessun checkpoint: la cartella ha troppi file o non si può leggere. Le modifiche di questo messaggio non si potranno annullare da qui.',
        });
      }
      return checkpoint;
    } catch (error) {
      this.events.update({
        type: 'notice',
        level: 'warn',
        text: `Checkpoint non riuscito: ${error instanceof Error ? error.message : String(error)}`,
      });
      return null;
    }
  }

  /** The changes card of a message; false when it could not be made. */
  private review(checkpoint: Checkpoint): boolean {
    try {
      const review = this.config.checkpoints?.review(checkpoint);
      if (!review) return false;
      if (review.files.length > 0 || review.uncovered.length > 0) {
        this.events.update({
          type: 'changes',
          id: this.id('m'),
          checkpoint: checkpoint.id,
          files: review.files,
          uncovered: review.uncovered,
        });
      }
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Sends the user's message, one at a time: to the leader, or to the
   * implementer alone. Without `to`, an `@impl` at the start chooses it (the
   * tests and older callers); the panel always says.
   */
  async send(
    text: string,
    attached?: { readonly text: string; readonly paths: readonly string[] },
    to?: 'leader' | 'implementer',
    skill?: SkillRef,
  ): Promise<void> {
    const direct = to ? to === 'implementer' : DIRECT.test(text);
    if (!to && direct) text = text.replace(DIRECT, '');
    const attachments = attached?.text ?? '';
    if (this.running) {
      this.events.update({
        type: 'notice',
        level: 'warn',
        text: 'Un messaggio è già in corso: aspetta o fermalo.',
      });
      return;
    }
    if (this.restored) {
      this.events.update({
        type: 'notice',
        level: 'warn',
        text: 'Una delega aspetta la tua decisione: inviala o annullala.',
      });
      return;
    }
    const checkpoint = this.checkpoint();
    this.events.update({
      type: 'user',
      id: this.id('u'),
      text,
      to: direct ? 'implementer' : 'leader',
      ...(checkpoint ? { checkpoint: checkpoint.id } : {}),
      ...(attached && attached.paths.length > 0 ? { attachments: attached.paths } : {}),
      ...(skill ? { skill: skill.name } : {}),
    });
    // The files the user named reach the agent after the text; the thread shows the text.
    const prompt = attachments === '' ? text : `${text}\n\n${attachments}`;
    await this.run(checkpoint, (baseline, shown) =>
      direct
        ? this.toImplementer(prompt, baseline, shown, skill)
        : this.toLeader(prompt, baseline, shown, undefined, skill),
    );
  }

  /**
   * The delegation of a reopened chat, decided (ADR 0018): sent to the
   * implementer as it is or as the user edited it, with no leader turn first,
   * then reviewed by the leader as usual; or cancelled.
   */
  private async sendDraft(action: ApprovalAction, text?: string): Promise<void> {
    const draft = this.restored;
    if (!draft || this.running) return;
    this.restored = undefined;
    this.events.update({ type: 'approval_closed', id: draft.id, action });
    this.events.draft?.(null);
    if (action === 'cancel') return;
    const delegation = action === 'edit' && text !== undefined ? text : draft.text;
    await this.run(this.checkpoint(), (baseline, shown) =>
      this.toLeader('', baseline, shown, delegation),
    );
  }

  /** One message at a time: the agents' work, then the review of what changed. */
  private async run(
    checkpoint: Checkpoint | null,
    work: (baseline: ReturnType<typeof snapshot>, shown: { facts: boolean }) => Promise<void>,
  ): Promise<void> {
    this.running = true;
    this.events.busy(true);
    const baseline = snapshot(this.config.cwd);
    /** Set once the facts are shown, by the facts callback or the direct turn. */
    const shown = { facts: false };
    try {
      this.log ??= await openEventLog(this.config.logPath, this.config.cwd);
      await this.applyRoleChanges();
      await work(baseline, shown);
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
      const reviewed = checkpoint ? this.review(checkpoint) : false;
      if (!shown.facts && !reviewed) {
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
    skill?: SkillRef,
  ): Promise<void> {
    const { config } = this;
    const session = await this.implementer();
    const notes = this.takeNotes('implementer');
    const result = await this.implementerTurn(
      session,
      notes ? `${notes}\n\n${text}` : text,
      true,
      skill,
    );
    const facts = await verifiedFacts(config.cwd, baseline, config.verifyCommand);
    shown.facts = true;
    this.events.update({ type: 'notice', level: 'info', text: facts });
    this.unseen.push({ source: 'direct', request: text, report: result.text, facts });
    this.events.unseen?.(this.unseen);
    this.events.update({
      type: 'notice',
      level: 'info',
      text: 'Il leader leggerà questo rapporto con il tuo prossimo messaggio.',
    });
  }

  /** A message to the leader; with `draft`, a delegation already approved goes straight on. */
  private async toLeader(
    text: string,
    baseline: ReturnType<typeof snapshot>,
    shown: { facts: boolean },
    draft?: string,
    skill?: SkillRef,
  ): Promise<void> {
    const { config } = this;
    const leaderPolicy = { ...this.policy(this.roles.leader), proactive: true };
    // Read-only (ADR 0018): it reasons, searches and delegates; it never writes.
    this.leaderSession ??= await this.factory(
      'leader',
      this.roles.leader,
      await this.bridgeFor('leader'),
    )({
      ...agentSessionOptions(
        this.withUserInstructions('leader', leaderInstructions(this.roles.implementer.cli)),
        leaderPolicy,
      ),
      ...this.resumeOf('leader'),
    });
    // A draft sent later has no message of the user: what the leader has not seen waits for one.
    const unseen = draft === undefined ? this.unseen : [];
    if (draft === undefined) this.unseen = [];
    const preface = [
      this.takeNotes('leader') ?? '',
      unseen.length > 0 ? pendingReportsPreface(unseen) : '',
    ]
      .filter(Boolean)
      .join('\n\n');
    const manual = this.mode === 'manual';
    const loop = runLoop({
      request: text,
      ...(preface !== '' ? { preface } : {}),
      ...(draft !== undefined ? { delegation: draft } : {}),
      ...(skill ? { skill } : {}),
      // `@path` reaches the other agent as a plain path (ADR 0018).
      relay: (message) => plainRefs(message, config.cwd),
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
          const held = { id, text: message.text, from: message.from, to: message.to };
          this.held = held;
          signal.addEventListener('abort', () => {
            this.pending.delete(id);
            if (this.held === held) this.held = undefined;
            // Closing the chat keeps the delegation with it; stopping drops it.
            if (!this.closing) this.events.draft?.(null);
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
          if (message.kind === 'delegation') this.events.draft?.(held);
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
    // Only now: a chat closed during the turn keeps the reports the leader may not have read.
    this.events.unseen?.(this.unseen);
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

  /** The user's decision on a message between agents (manual delivery), or on a kept draft. */
  decide(id: string, action: ApprovalAction, text?: string): void {
    const resolve = this.pending.get(id);
    if (!resolve) {
      if (this.restored?.id === id) void this.sendDraft(action, text);
      return;
    }
    this.pending.delete(id);
    if (this.held?.id === id) {
      this.held = undefined;
      this.events.draft?.(null);
    }
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

  /** The chat is closed or another is shown: a delegation waiting for the user stays with it. */
  async dispose(): Promise<void> {
    this.closing = true;
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
        if (event.context) this.events.context?.(role, event.context);
        this.noteSession(role, event.identity.sessionId);
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
      case 'intercepted':
        this.lastIntercepted = event.message;
        break;
      case 'decision': {
        // A delegation that went on by itself still has its card, closed at once (ADR 0018).
        const message = this.lastIntercepted;
        if (event.action !== 'auto_approve' || event.kind !== 'delegation' || !message) break;
        const id = this.id('a');
        update({
          type: 'approval',
          id,
          kind: 'delegation',
          from: message.from,
          to: message.to,
          text: message.text,
        });
        update({ type: 'approval_closed', id, action: 'sent' });
        break;
      }
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
