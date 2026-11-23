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

import { startPermissionBridge, type PermissionBridge } from '@only-one-chat/adapters';
import {
  CommandEvidence,
  DIFF_CHECKS_UNAVAILABLE,
  GATE_SENT_BACK_HEADER,
  directMessagePrompt,
  implementerInstructions,
  NO_COMMANDS_NOTE,
  agentLabel,
  agentSessionOptions,
  leaderInstructions,
  openEventLog,
  handoffTools,
  pendingReportsPreface,
  frameWorkerAnswer,
  readHandoff,
  renderReport,
  runLoop,
  type AgentFactory,
  type LoopOptions,
  type AgentSession,
  type EventLog,
  type InterceptDecision,
  type AgentQuestion,
  type QuestionAnswers,
  type PendingReport,
  type Report,
  type SubagentPolicy,
  type SkillRef,
  type ThreadEvent,
  type TaskProgress,
  type TaskJournal,
} from '@only-one-chat/runtime';
import { validImplementerHandoff } from './history.js';
import { WorkspaceVerification } from './verification.js';
import { readSavedTask, taskUnfinished, type SavedTask } from './task.js';
import type {
  ApprovalAction,
  ApprovalMode,
  PermitDecision,
  RoleName,
  ThreadUpdate,
  TurnRole,
} from '../shared/protocol.js';
import type { Checkpoint } from './checkpoints.js';
import { changes, configuredCommandFact, snapshot, verifiedFacts } from './facts.js';
import { guardReviewerTurn } from './guard.js';
import { ignoredPaths, type Ignored } from './ignore.js';
import { plainRefs, referenceKind } from './mentions.js';
import { PROVIDERS } from './providers.js';
import {
  DIRECT,
  HANDOFF_PREFACE,
  HANDOFF_REQUEST,
  readOnly,
  roleOf,
  scopeOf,
  StoppedBeforeTurn,
  summarize,
  type AgentChoice,
  type ChatConfig,
  type ChatEvents,
  type DraftDelegation,
  type FileNotes,
  type ReviewerConfig,
} from './chat-types.js';

export { summarize } from './chat-types.js';
export type {
  AgentChoice,
  ChatConfig,
  DraftDelegation,
  FileNotes,
  ReviewerConfig,
} from './chat-types.js';

export class ChatSession {
  private mode: ApprovalMode;
  private log: EventLog | undefined;
  private leaderSession: AgentSession | undefined;
  /** Kept across delegations and direct messages: a follow-up costs it little (calc-small). */
  private implementerSession: AgentSession | undefined;
  /** The pending handoff, until the replacement session ID is saved. */
  private handoffBrief: string | undefined;
  /** Stops what is running now: a leader loop or a direct implementer turn. */
  private stopRunning: (() => Promise<void>) | undefined;
  private stopRequested = false;
  private requestController = new AbortController();
  private readonly verification: WorkspaceVerification;
  private task: SavedTask | undefined;
  private taskInvalid = false;
  private resuming = false;
  private readonly recoveredWithoutHistory = new Set<RoleName>();
  private readonly taskEnabled: boolean;
  private recoveryChanged = false;
  private running = false;
  private nextId = 1;
  private readonly tag = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  private readonly currentTurn = new Map<TurnRole, string>();
  private readonly pending = new Map<string, (decision: InterceptDecision) => void>();
  /** The permission bridges of the Claude roles, for the chat. */
  private readonly bridges = new Map<RoleName, PermissionBridge>();
  /** Agents' permission requests waiting for the user (R9). */
  private readonly permissions = new Map<string, (decision: PermitDecision) => void>();
  /** The leader's questions waiting for the user (ADR 0019), with their secret ids. */
  private readonly questions = new Map<
    string,
    { resolve: (answers: QuestionAnswers) => void; secret: ReadonlySet<string> }
  >();
  /** Implementer work the leader has not seen yet. */
  private unseen: PendingReport[] = [];
  /** Sessions of a reopened chat not resumed yet. */
  private readonly resumable = new Map<RoleName, string>();
  /** The CLIs' own session of each role, as last reported. */
  private readonly nativeSessions = new Map<RoleName, string>();
  /** Files the user put back, not told yet to each role. */
  private readonly fileNotes: Record<RoleName, string[]>;
  /** Roles whose session is reopened with new rules before their next turn. */
  private readonly reopen = new Set<RoleName>();
  /** The roles as configured, with the effort the user chose during the chat. */
  private readonly roles: { leader: AgentChoice; implementer: AgentChoice };
  /** The delegation of a reopened chat still waiting for the user; sent from here. */
  private restored: DraftDelegation | undefined;
  /** The message held for the user now, as the loop showed it. */
  private held: DraftDelegation | undefined;
  /** The chat is being closed: what waits for the user stays kept with it. */
  private closing = false;
  private readonly ignored: Ignored;
  /** The folder as it was before the message running now: what the checks on the diff start from. */
  private inRequest: Checkpoint | null = null;
  /**
   * The task checkpoint last taken, and whether something that could write
   * to the folder ran since (an agent turn, a verification command): a clean
   * save reuses it instead of walking the folder again (ADR 0047).
   */
  private taskCheckpoint: { id: string; clean: boolean } | undefined;
  /** The latest message between agents the loop showed, for the card of one that went on by itself. */
  private lastIntercepted: Omit<DraftDelegation, 'id'> | undefined;
  /** The reviewer now: the panel switches it on and off during the chat (ADR 0033). */
  private reviewerConfig: ReviewerConfig | undefined;
  /** The last implementer work, what a review the user asks for looks at (ADR 0033). */
  private lastWork:
    | {
        brief: string;
        report: string;
        reportCommandEvidence?: string | undefined;
        direct: boolean;
        /** The `report` call behind `report`; absent when unknown (then it is not checked). */
        reportData?: Report | null | undefined;
      }
    | undefined;

  constructor(
    private readonly config: ChatConfig,
    private readonly events: ChatEvents,
  ) {
    this.mode = config.mode;
    this.taskEnabled =
      events.saveTask !== undefined || config.task !== undefined || config.taskInvalid === true;
    this.verification = new WorkspaceVerification({
      cwd: config.cwd,
      command: config.verifyCommand,
      store: config.checkpoints,
      id: () => this.id('v'),
      update: (evidence) => {
        this.events.update({ type: 'verification', evidence });
      },
      onRun: () => {
        this.folderMayHaveChanged();
      },
    });
    this.reviewerConfig = config.reviewer;
    this.roles = { leader: readOnly(config.leader), implementer: config.implementer };
    this.task = readSavedTask(config.task);
    this.taskInvalid =
      config.taskInvalid === true || (config.task !== undefined && this.task === undefined);
    const lastTask = this.task?.progress.work ? this.task : readSavedTask(config.lastCompletedTask);
    if (lastTask?.progress.work) {
      const { progress } = lastTask;
      this.lastWork = {
        brief: progress.brief,
        direct: progress.direct,
        report: progress.work?.text ?? '',
        reportData: progress.work?.data,
        reportCommandEvidence: progress.work?.commandEvidence,
      };
    }
    this.restored = config.draft;
    this.ignored = ignoredPaths(config.ignoredPaths ?? []);
    this.unseen = [...(config.unseen ?? [])];
    this.handoffBrief = validImplementerHandoff(config.implementerHandoff)
      ? config.implementerHandoff
      : undefined;
    this.fileNotes = {
      leader: [...(config.fileNotes?.leader ?? [])],
      implementer: [...(config.fileNotes?.implementer ?? [])],
    };
    for (const [role, id] of Object.entries({ ...this.task?.sessions, ...config.resume }) as [
      RoleName,
      string,
    ][]) {
      if (!['leader', 'implementer'].includes(role) || typeof id !== 'string' || id.length > 512)
        continue;
      if (role === 'implementer' && this.handoffBrief !== undefined) continue;
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
  setRole(role: RoleName, choice: AgentChoice): boolean {
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

  /**
   * The reviewer from the next piece of work on, or none (ADR 0033): its
   * session lasts one review, so a change takes effect at once.
   */
  setReviewer(reviewer: ReviewerConfig | undefined): void {
    this.reviewerConfig = reviewer;
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
  private noteSession(role: RoleName, id: string): void {
    if (id.trim() === '') return;
    const originalSession = this.config.resume?.[role] ?? this.task?.sessions?.[role];
    if (
      this.resuming &&
      originalSession &&
      originalSession !== id &&
      !this.recoveredWithoutHistory.has(role)
    ) {
      this.recoveredWithoutHistory.add(role);
      this.events.update({
        type: 'notice',
        level: 'warn',
        text: `The ${role} provider started a fresh session. Saved task context was supplied for recovery.`,
      });
    }
    if (role === 'implementer' && this.handoffBrief !== undefined) {
      try {
        this.events.saveImplementerHandoff(id, null);
      } catch (error) {
        this.events.update({
          type: 'notice',
          level: 'warn',
          text: `The handoff remains pending because the replacement session could not be saved: ${error instanceof Error ? error.message : String(error)}`,
        });
        return;
      }
      this.handoffBrief = undefined;
      this.nativeSessions.set(role, id);
      return;
    }
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

  /** A role's sessions, from its provider (ADR 0022): the leader read-only (ADR 0018). */
  private factory(
    role: RoleName,
    choice: AgentChoice,
    bridge: PermissionBridge | undefined,
  ): AgentFactory {
    return PROVIDERS[choice.cli].factory(
      this.config,
      { choice, leader: role === 'leader' },
      bridge,
    );
  }

  /**
   * The permission bridge of a role that may write, when its provider asks
   * through it (R9): one per role, for the chat. A read-only role has none.
   */
  private async bridgeFor(role: RoleName): Promise<PermissionBridge | undefined> {
    const choice = this.roles[role];
    const hook = this.config.permissionHook;
    const provider = PROVIDERS[choice.cli];
    if (!provider.bridged || !hook || role === 'leader' || choice.permission === 'read-only') {
      return undefined;
    }
    let bridge = this.bridges.get(role);
    if (!bridge) {
      bridge = await startPermissionBridge(
        (request) =>
          this.askPermission(role, `${provider.name} (${this.roles[role].model})`, request.summary),
        hook,
      );
      if (this.closing) {
        await bridge.close();
        throw new StoppedBeforeTurn();
      }
      this.bridges.set(role, bridge);
    }
    return bridge;
  }

  private policy(choice: AgentChoice): SubagentPolicy {
    return {
      ...this.config.subagents[choice.cli],
      maxConcurrent: 2,
      forbiddenNames: PROVIDERS[choice.cli].subagentForbiddenNames,
    };
  }

  /** The verification command has a {junit} placeholder: the roles may select a test (ADR 0045). */
  private hasJunit(): boolean {
    return this.config.verifyCommand.some((part) => part.includes('{junit}'));
  }

  /** The role's instructions, followed by the user's own for it, if any (ADR 0013). */
  private withUserInstructions(role: TurnRole, instructions: string): string {
    const own = this.config.instructions?.[role]?.trim();
    return own ? `${instructions}\n\nUser instructions for this role:\n${own}` : instructions;
  }

  /**
   * A role's session: the one a reopened chat saved, resumed; when that one no
   * longer opens (deleted or expired in its CLI), a new one, and the user is
   * told it does not remember the conversation (ADR 0027).
   */
  private async openSession(
    role: RoleName,
    factory: AgentFactory,
    options: Parameters<AgentFactory>[0],
  ): Promise<AgentSession> {
    this.checkStop();
    const { resume } = this.resumeOf(role);
    let session: AgentSession | undefined;
    if (resume) {
      try {
        session = await factory({ ...options, resume });
      } catch (error) {
        if (this.stopRequested) this.resumable.set(role, resume);
        this.checkStop();
        this.events.sessionId?.(role, '');
        this.events.update({
          type: 'notice',
          level: 'warn',
          text: `Could not resume the saved ${role} session (${error instanceof Error ? error.message : String(error)}). A new session will start without the conversation history.`,
        });
      }
    }
    session ??= await factory(options);
    if (this.closing) {
      await session.close();
      throw new StoppedBeforeTurn();
    }
    return session;
  }

  private resumeOf(role: RoleName): { resume?: string } {
    const id = this.resumable.get(role);
    this.resumable.delete(role);
    return id ? { resume: id } : {};
  }

  /**
   * The implementer's session, opened once and continued (ADR 0011); after a
   * handoff, a new one that starts from it (ADR 0017).
   */
  private async implementer(): Promise<AgentSession> {
    this.checkStop();
    if (this.implementerSession?.closed) {
      const closed = this.implementerSession;
      this.implementerSession = undefined;
      const native = this.nativeSessions.get('implementer');
      if (native) this.resumable.set('implementer', native);
      await closed.close();
    }
    if (!this.implementerSession) {
      const instructions = this.withUserInstructions(
        'implementer',
        implementerInstructions({ junit: this.hasJunit() }),
      );
      this.implementerSession = await this.openSession(
        'implementer',
        this.factory('implementer', this.roles.implementer, await this.bridgeFor('implementer')),
        agentSessionOptions(
          instructions,
          { ...this.policy(this.roles.implementer), proactive: true },
          handoffTools('implementer', this.config.handoffServer),
        ),
      );
    }
    this.checkStop();
    return this.implementerSession;
  }

  private taskConfiguration(): string {
    return JSON.stringify({
      cwd: this.config.cwd,
      roles: this.roles,
      reviewer: this.reviewerConfig?.choice ?? null,
      instructions: this.config.instructions ?? {},
      verifyCommand: this.config.verifyCommand,
      allowedCommands: this.config.allowedCommands,
      subagents: this.config.subagents,
      executables: {
        codex: this.config.codexExecutable,
        claude: this.config.claudeExecutable,
        antigravity: this.config.antigravityExecutable ?? null,
      },
      ignoredPaths: this.config.ignoredPaths ?? [],
      mode: this.mode,
      review: this.config.review,
    });
  }

  private saveTaskProgress(progress: TaskProgress): void {
    if (!this.taskEnabled) return;
    const previous = taskUnfinished(this.task) ? this.task : undefined;
    // Reuse only inside a task, for the checkpoint this task last recorded.
    const reused =
      previous?.checkpoint &&
      this.taskCheckpoint?.clean &&
      this.taskCheckpoint.id === previous.checkpoint
        ? this.taskCheckpoint.id
        : undefined;
    const checkpoint =
      progress.step === 'cancelled' || reused
        ? null
        : (this.config.checkpoints?.take(this.id('task-ckpt')) ?? null);
    if (checkpoint) this.taskCheckpoint = { id: checkpoint.id, clean: true };
    const next: SavedTask = {
      version: 1,
      id: previous?.id ?? this.id('task'),
      configuration: previous?.configuration ?? this.taskConfiguration(),
      progress,
      checkpoint:
        reused ??
        checkpoint?.id ??
        (progress.step === 'cancelled' ? (previous?.checkpoint ?? null) : null),
      verification: this.verification.checkpoint() ?? previous?.verification,
      sessions: Object.fromEntries(
        (['leader', 'implementer'] as const).flatMap((role) => {
          const id =
            this.nativeSessions.get(role) ??
            this.config.resume?.[role] ??
            previous?.sessions?.[role];
          return typeof id === 'string' && id.length <= 512 ? [[role, id]] : [];
        }),
      ),
    };
    if (!readSavedTask(next)) throw new Error('Task state cannot be safely persisted');
    this.events.saveTask?.(next);
    this.task = next;
    this.taskInvalid = false;
  }

  private taskJournal(): TaskJournal | undefined {
    if (!this.taskEnabled) return undefined;
    return {
      resume: this.resuming ? this.task?.progress : undefined,
      save: (progress) => {
        this.saveTaskProgress(progress);
      },
    };
  }

  recoveryConfigurationMatches(): boolean {
    return !this.taskInvalid && this.task?.configuration === this.taskConfiguration();
  }

  recoveryReason(showChanges = true): string | undefined {
    this.recoveryChanged = false;
    if (this.taskInvalid)
      return 'The saved task record is invalid. Inspect the history and cancel the task to continue.';
    if (!taskUnfinished(this.task) || !this.task) return undefined;
    if (this.task.configuration !== this.taskConfiguration())
      return 'The task configuration changed. Restore its recorded roles, providers, and verification settings before resuming.';
    const store = this.config.checkpoints;
    const checkpoint = this.task.checkpoint ? store?.load(this.task.checkpoint) : undefined;
    if (!checkpoint || checkpoint.incomplete || Object.keys(checkpoint.large).length > 0) {
      this.recoveryChanged = true;
      return 'The workspace checkpoint is incomplete or unavailable. Review the current files before continuing.';
    }
    try {
      const current = store?.take(this.id('recovery-ckpt'));
      const review = store?.review(checkpoint);
      if (!current || current.incomplete || !review) {
        this.recoveryChanged = true;
        return 'The current workspace cannot be fully compared. Review the files before continuing.';
      }
      if (review.files.length > 0 || review.uncovered.length > 0) {
        this.recoveryChanged = true;
        if (showChanges)
          this.events.update({
            type: 'changes',
            id: this.id('changes'),
            checkpoint: checkpoint.id,
            ...review,
          });
        return 'Files changed after the recorded task boundary. Review the changes before continuing.';
      }
    } catch {
      this.recoveryChanged = true;
      return 'The recorded workspace cannot be read. Review the files before continuing.';
    }
    const baseline = this.task.verification?.baseline;
    if (baseline && !store?.load(baseline))
      return 'The original verification baseline is unavailable. Inspect the recorded evidence before continuing.';
    return this.task.progress.inFlight
      ? 'The last operation has no committed outcome. Review the current files before continuing.'
      : undefined;
  }

  cancelTask(): void {
    if (this.running) return;
    if (!this.taskInvalid && !taskUnfinished(this.task)) return;
    if (this.task)
      this.saveTaskProgress({ ...this.task.progress, step: 'cancelled', inFlight: false });
    else {
      this.events.saveTask?.(null);
      this.taskInvalid = false;
    }
  }

  async resumeTask(confirmed = false): Promise<void> {
    if (this.taskInvalid) {
      this.events.update({
        type: 'notice',
        level: 'warn',
        text: 'The saved task is invalid. Cancel it before starting new work.',
      });
      return;
    }
    if (this.running || this.resuming || !taskUnfinished(this.task) || !this.task) return;
    if (this.task.configuration !== this.taskConfiguration())
      throw new Error('Restore the task configuration before resuming');
    const reason = this.recoveryReason(!confirmed);
    if (reason && !confirmed) {
      this.events.update({ type: 'notice', level: 'warn', text: reason });
      return;
    }
    this.resuming = true;
    try {
      await this.run(this.checkpoint(), async (baseline, shown) => {
        if (!this.task) return;
        this.verification.restore(this.task.verification);
        let progress = this.task.progress;
        if (
          progress.direct &&
          progress.step === 'implementation' &&
          !progress.inFlight &&
          !progress.work
        ) {
          await this.toImplementer(progress.brief, baseline, shown);
          return;
        }
        const uncertainDelivery = progress.step === 'delivery' && progress.inFlight;
        if (progress.inFlight) {
          const step =
            progress.step === 'verification' && progress.answer
              ? 'verification'
              : progress.step === 'delivery'
                ? 'delivery'
                : this.reviewerConfig
                  ? 'review'
                  : 'verification';
          progress = {
            ...progress,
            step,
            inFlight: false,
            findings: [
              progress.findings,
              'Recovery note: the last operation has an uncertain outcome. Inspect current files and treat the prior report as historical context.',
            ]
              .filter(Boolean)
              .join('\n\n'),
            work:
              !progress.work && progress.step === 'implementation'
                ? {
                    text: 'The implementer was interrupted. Inspect the current files against the approved request and saved findings.',
                    data: null,
                  }
                : (progress.work ?? {
                    text: 'Interrupted work requires review of the current files.',
                    data: null,
                  }),
          };
          this.saveTaskProgress(progress);
        }
        if (this.recoveryChanged) {
          progress = {
            ...progress,
            step:
              this.reviewerConfig && progress.work?.data?.outcome !== 'blocked'
                ? 'review'
                : 'verification',
            inFlight: false,
            answer: undefined,
            result: undefined,
            leaderDelivered: false,
            work: progress.work ?? {
              text: 'Inspect the current files against the approved request.',
              data: null,
            },
            findings: [
              progress.findings,
              'Recovery note: workspace inputs changed. Prior verification and review results are stale; review and verify the current files.',
            ]
              .filter(Boolean)
              .join('\n\n'),
          };
          this.saveTaskProgress(progress);
        }
        if (progress.leaderDelivered) return;
        if (uncertainDelivery && progress.work && progress.result) {
          this.keepForLeader(
            {
              source: progress.direct ? 'direct' : 'delegation',
              request: progress.brief,
              report: progress.work.text,
              facts: progress.result.facts,
              ...(progress.result.review ? { review: progress.result.review } : {}),
            },
            'the recovered result',
          );
          return;
        }
        if (!progress.direct && progress.delivery !== 'deferred') {
          await this.toLeader('', baseline, shown, progress.brief);
          return;
        }
        if (progress.step === 'delivery' && progress.result && progress.work) {
          this.keepForLeader(
            {
              source: progress.source ?? (progress.direct ? 'direct' : 'delegation'),
              request: progress.brief,
              report: progress.work.text,
              facts: progress.result.facts,
              ...(progress.result.review ? { review: progress.result.review } : {}),
            },
            'the recovered result',
          );
        } else if (
          this.reviewerConfig &&
          progress.work &&
          progress.work.data?.outcome !== 'blocked'
        ) {
          const judged = await this.reviewWork(
            {
              brief: progress.brief,
              report: progress.work.text,
              reportData: progress.work.data ?? null,
              reportCommandEvidence: progress.work.commandEvidence,
              direct: progress.direct,
            },
            baseline,
            shown,
          );
          if (!judged) throw new Error('Task review did not complete');
          this.keepForLeader(
            {
              source: progress.source ?? (progress.direct ? 'direct' : 'delegation'),
              request: progress.brief,
              report: judged.report,
              facts: judged.facts,
              review: judged.review,
            },
            'the recovered review',
          );
        } else if (progress.work) {
          this.saveTaskProgress({ ...progress, step: 'verification', inFlight: true });
          const verified = await this.verification.finish(
            progress.work.data?.test,
            'implementer',
            this.requestController.signal,
          );
          const facts = [await this.facts(baseline), verified.summary].join('\n\n');
          this.saveTaskProgress({
            ...progress,
            step: 'delivery',
            inFlight: false,
            result: { facts },
          });
          this.keepForLeader(
            {
              source: progress.source ?? (progress.direct ? 'direct' : 'delegation'),
              request: progress.brief,
              report: progress.work.text,
              facts,
            },
            'the recovered verification',
          );
        }
      });
    } finally {
      this.resuming = false;
    }
  }

  private implementerPreface(): string | undefined {
    const recovery =
      this.resuming && this.task
        ? `Saved task recovery context\n${frameWorkerAnswer(JSON.stringify({ brief: this.task.progress.brief, report: this.task.progress.work?.text, findings: this.task.progress.findings, correctionsUsed: this.task.progress.used, correctionLimit: this.task.progress.limit }).replace(/\r\n?|[\u2028\u2029]/g, '\n'))}`
        : undefined;
    if (this.handoffBrief === undefined) return recovery;
    const brief = this.handoffBrief.replace(/\r\n?|[\u2028\u2029]/g, '\n');
    return [`${HANDOFF_PREFACE}\n\n${frameWorkerAnswer(brief)}`, recovery]
      .filter(Boolean)
      .join('\n\n');
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
   * closed and forgotten, and the next work prompt includes that handoff.
   * Not while a message runs, nor before its first turn.
   */
  async handoff(): Promise<void> {
    if (this.taskInvalid || taskUnfinished(this.task)) {
      this.events.update({
        type: 'notice',
        level: 'warn',
        text: 'Resume or cancel the interrupted task before handing off its session.',
      });
      return;
    }
    if (this.running) {
      this.events.update({
        type: 'notice',
        level: 'warn',
        text: 'Wait for the current message to finish before handing off.',
      });
      return;
    }
    if (this.handoffBrief !== undefined) {
      this.events.update({
        type: 'notice',
        level: 'info',
        text: 'An implementer handoff is already pending. Send a work request to continue.',
      });
      return;
    }
    if (!this.hasImplementerSession()) {
      this.events.update({
        type: 'notice',
        level: 'info',
        text: 'The implementer will start a fresh session. There is no session to hand off yet.',
      });
      return;
    }
    this.stopRequested = false;
    this.running = true;
    this.events.busy(true);
    try {
      await this.applyRoleChanges();
      const session = await this.implementer();
      const result = await this.implementerTurn(session, HANDOFF_REQUEST, false);
      if (result.text.trim() === '') {
        throw new Error(
          'The implementer produced no handoff. The current session is still active.',
        );
      }
      if (!validImplementerHandoff(result.text)) {
        throw new Error(
          'The handoff exceeds 32,768 characters. The current session is still active.',
        );
      }
      this.events.saveImplementerHandoff('', result.text);
      this.handoffBrief = result.text;
      this.implementerSession = undefined;
      this.nativeSessions.delete('implementer');
      this.resumable.delete('implementer');
      const bridge = this.bridges.get('implementer');
      this.bridges.delete('implementer');
      const closed = await Promise.allSettled([session.close(), bridge?.close()]);
      if (closed.some((result) => result.status === 'rejected')) {
        this.events.update({
          type: 'notice',
          level: 'warn',
          text: 'The handoff was saved. Cleanup of the previous implementer session was incomplete.',
        });
      }
      this.events.context?.('implementer', { used: 0, window: result.context?.window ?? null });
      this.events.update({
        type: 'notice',
        level: 'info',
        text: `The next implementer session (${this.roles.implementer.model}) will continue from this handoff.`,
      });
    } catch (error) {
      this.events.update({
        type: 'notice',
        level: error instanceof StoppedBeforeTurn ? 'info' : 'error',
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
    this.folderMayHaveChanged();
    const id = this.id('t');
    const commands = new CommandEvidence();
    const observe = commands.nextTurn();
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
        onStep: (step) => {
          observe(step);
          this.events.update({ type: 'step', turnId: id, step });
        },
      },
      skill ? { skill } : undefined,
    );
    this.stopRunning = () => turn.stop();
    const result = await turn.done;
    this.folderMayHaveChanged();
    this.currentTurn.delete('implementer');
    const usage = summarize(result.usage);
    const report = readHandoff(result.handoffs, 'report').value;
    const reportText = report ? renderReport(report) : result.text;
    const reportCommandEvidence = report ? commands.render(report.criteria, 'Implementer') : '';
    this.events.update({
      type: 'turn',
      id,
      role: 'implementer',
      agent: session.name,
      status: 'done',
      label: agentLabel(result.identity),
      text: result.text,
      ...(report
        ? {
            handoff: {
              tool: 'report',
              text: reportText,
              outcome: report.outcome,
              ...(reportCommandEvidence ? { commandEvidence: reportCommandEvidence } : {}),
            },
          }
        : {}),
      ...(usage ? { usage } : {}),
    });
    this.events.turnUsage?.(result.identity.provider, usage, result.quota ?? null);
    if (result.context) this.events.context?.('implementer', result.context);
    if (keep) this.noteSession('implementer', result.identity.sessionId);
    return { ...result, report, reportText, reportCommandEvidence };
  }

  /**
   * The user put files back as they were (ADR 0014): each role is told with
   * its next message, since its context still holds the changes.
   */
  noteFiles(note: string): void {
    this.folderMayHaveChanged();
    this.fileNotes.leader.push(note);
    this.fileNotes.implementer.push(note);
    this.events.fileNotes?.(this.pendingNotes());
  }

  /** Something that could write to the folder ran: the next task save takes a new checkpoint. */
  private folderMayHaveChanged(): void {
    if (this.taskCheckpoint) this.taskCheckpoint.clean = false;
  }

  /** The notes each role has not received yet: kept with the chat (R5). */
  private pendingNotes(): FileNotes {
    return { leader: [...this.fileNotes.leader], implementer: [...this.fileNotes.implementer] };
  }

  private takeNotes(role: RoleName): string | undefined {
    const notes = this.fileNotes[role].splice(0);
    if (notes.length === 0) return undefined;
    this.events.fileNotes?.(this.pendingNotes());
    return [
      'Runtime note: the user restored some files after the previous work. Read the',
      'current files on disk before relying on your previous context.',
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
          text: 'Checkpoint unavailable. The workspace has too many files or could not be read. Changes from this message cannot be reverted here.',
        });
      }
      return checkpoint;
    } catch (error) {
      this.events.update({
        type: 'notice',
        level: 'warn',
        text: `Could not create a checkpoint: ${error instanceof Error ? error.message : String(error)}`,
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
    to?: TurnRole,
    skill?: SkillRef,
  ): Promise<void> {
    const recipient: TurnRole = to ?? (DIRECT.test(text) ? 'implementer' : 'leader');
    if (!to && recipient === 'implementer') text = text.replace(DIRECT, '');
    const attachments = attached?.text ?? '';
    if (this.taskInvalid || taskUnfinished(this.task)) {
      this.events.update({
        type: 'notice',
        level: 'warn',
        text: 'Resume or cancel the interrupted task before starting another request.',
      });
      return;
    }
    if (this.running) {
      this.events.update({
        type: 'notice',
        level: 'warn',
        text: 'Wait for the current message to finish or stop it.',
      });
      return;
    }
    if (this.restored) {
      this.events.update({
        type: 'notice',
        level: 'warn',
        text: 'Send or cancel the pending delegation before continuing.',
      });
      return;
    }
    if (recipient === 'reviewer' && !this.reviewerConfig) {
      this.events.update({
        type: 'notice',
        level: 'warn',
        text: 'Enable the reviewer before requesting a review.',
      });
      return;
    }
    const checkpoint = this.checkpoint();
    this.events.update({
      type: 'user',
      id: this.id('u'),
      text,
      to: recipient,
      ...(checkpoint ? { checkpoint: checkpoint.id } : {}),
      ...(attached && attached.paths.length > 0 ? { attachments: attached.paths } : {}),
      ...(skill ? { skill: skill.name } : {}),
    });
    // The files the user named reach the agent after the text; the thread shows the text.
    // `@path` in the text names a file: the agent reads it as the plain path (ADR 0026).
    const named = plainRefs(text, this.config.cwd);
    const prompt = attachments === '' ? named : `${named}\n\n${attachments}`;
    await this.run(checkpoint, (baseline, shown) =>
      recipient === 'implementer'
        ? this.toImplementer(prompt, baseline, shown, skill)
        : recipient === 'reviewer'
          ? this.toReviewer(prompt, baseline, shown)
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
    const delegation = action === 'edit' && text !== undefined ? text : draft.text;
    if (action !== 'cancel') {
      if (!taskUnfinished(this.task)) this.verification.reset();
      this.verification.begin();
      this.saveTaskProgress({
        brief: delegation,
        direct: false,
        source: 'delegation',
        delivery: this.config.review === 'deferred' ? 'deferred' : 'leader',
        step: 'implementation',
        inFlight: false,
        limit: Math.max(0, Math.min(this.reviewerConfig?.rounds ?? 0, 3)),
        used: 0,
      });
    }
    this.restored = undefined;
    this.events.update({ type: 'approval_closed', id: draft.id, action });
    this.events.draft?.(null);
    if (action === 'cancel') return;
    await this.run(this.checkpoint(), (baseline, shown) =>
      this.toLeader('', baseline, shown, delegation),
    );
  }

  /** One message at a time: the agents' work, then the review of what changed. */
  private async run(
    checkpoint: Checkpoint | null,
    work: (baseline: ReturnType<typeof snapshot>, shown: { facts: boolean }) => Promise<void>,
  ): Promise<void> {
    this.stopRequested = false;
    this.requestController = new AbortController();
    this.running = true;
    this.events.busy(true);
    this.inRequest = checkpoint;
    const baseline = snapshot(this.config.cwd, this.ignored);
    /** Set once the facts are shown, by the facts callback or the direct turn. */
    const shown = { facts: false };
    try {
      this.log ??= await openEventLog(this.config.logPath, this.config.cwd);
      await this.applyRoleChanges();
      await work(baseline, shown);
      if (this.task?.progress.step === 'delivery' && !this.task.progress.inFlight) {
        this.saveTaskProgress({ ...this.task.progress, step: 'completed' });
      }
    } catch (error) {
      this.events.update({
        type: 'notice',
        level: error instanceof StoppedBeforeTurn ? 'info' : 'error',
        text: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.running = false;
      this.stopRunning = undefined;
      this.inRequest = null;
      if (this.taskEnabled && this.held && !this.pending.has(this.held.id)) {
        this.restored = this.held;
        this.held = undefined;
      }
      this.verification.reset();
      this.closeRunningTurns('failed');
      const reviewed = checkpoint ? this.review(checkpoint) : false;
      if (!shown.facts && !reviewed) {
        // Changes made with no delegation: shown, not judged.
        const changed = changes(baseline, snapshot(this.config.cwd, this.ignored));
        if (changed !== 'unknown' && changed.length > 0) {
          this.events.update({
            type: 'notice',
            level: 'info',
            text: ['Files changed:', ...changed.map((c) => `- ${c}`)].join('\n'),
          });
        }
      }
      this.events.busy(false);
    }
  }

  /**
   * What the runtime verified after an implementer's turn (ADR 0010, 0030): the
   * changed files and the verification command, then the checks on the diff.
   */
  private async facts(
    baseline: ReturnType<typeof snapshot>,
    turnBase?: ReturnType<typeof snapshot>,
  ): Promise<string> {
    const { config } = this;
    const facts = await verifiedFacts(config.cwd, baseline, [], this.ignored, turnBase);
    const command = configuredCommandFact(config.verifyCommand);
    return `${facts}

${command}

${this.diffChecks()}`;
  }

  /** The checks on the diff since the request began; said so when they cannot be made. */
  private diffChecks(): string {
    const { checkpoints } = this.config;
    return (
      (this.inRequest ? checkpoints?.diffChecks(this.inRequest) : null) ?? DIFF_CHECKS_UNAVAILABLE
    );
  }

  /**
   * The reviewer's part of a loop (ADR 0029, 0033), or nothing when it is off.
   * A session per review: it runs commands and writes tests in the folder,
   * with its provider's own permissions; the code it never changes: each of
   * its turns is guarded by a checkpoint, and what it changed outside the
   * tests is put back. A folder that cannot be recorded leaves it read-only,
   * like the leader.
   */
  private reviewerOptions(
    baseline: ReturnType<typeof snapshot>,
  ): { options: Partial<LoopOptions>; policy?: SubagentPolicy } | undefined {
    const { config } = this;
    const current = this.reviewerConfig;
    if (!current) return undefined;
    const store = config.checkpoints;
    const guardable = store !== undefined && baseline !== 'unavailable';
    const reviewer = guardable
      ? { ...current.choice, permission: 'auto' as const }
      : readOnly(current.choice);
    const factory = PROVIDERS[reviewer.cli].factory(
      config,
      { choice: reviewer, leader: !guardable },
      undefined,
    );
    const reviewerNote = !guardable
      ? `your session is read-only. File edits, including tests, are unavailable.${
          reviewer.cli === 'antigravity' ? ` ${NO_COMMANDS_NOTE}` : ''
        }`
      : undefined;
    return {
      options: {
        reviewer: (options) =>
          factory({
            ...options,
            instructions: this.withUserInstructions('reviewer', options.instructions),
          }),
        reviewRounds: current.rounds,
        junit: this.hasJunit(),
        ...(reviewerNote ? { reviewerNote } : {}),
        ...(store && guardable
          ? {
              guardReviewer: () => {
                const restore = guardReviewerTurn(store, this.id('rev'));
                // The restore after the turn writes to the folder too.
                return restore && (() => (this.folderMayHaveChanged(), restore()));
              },
            }
          : {}),
      },
      // Antigravity has no sub-agents to rule (ADR 0023).
      ...(reviewer.cli !== 'antigravity'
        ? { policy: { ...this.policy({ ...reviewer, cli: reviewer.cli }), proactive: true } }
        : {}),
    };
  }

  /**
   * A review of work the leader did not delegate (ADR 0033), in the runtime's
   * `review` mode: the findings go back to the implementer, and what the
   * leader will read comes back. Undefined when it did not end.
   */
  private async reviewWork(
    of: NonNullable<LoopOptions['reviewOf']>,
    baseline: ReturnType<typeof snapshot>,
    shown: { facts: boolean },
  ): Promise<
    { report: string; reportData: Report | null; facts: string; review: string } | undefined
  > {
    const { config } = this;
    const reviewer = this.reviewerOptions(baseline);
    if (!reviewer) return undefined;
    let turnBase: ReturnType<typeof snapshot> | undefined;
    const loop = runLoop({
      request: '',
      handoffServer: config.handoffServer,
      mode: 'review',
      task: this.taskJournal(),
      verification: this.verification,
      reviewOf: of,
      relay: (message) => plainRefs(message, config.cwd),
      log: this.log ?? (await openEventLog(config.logPath, config.cwd)),
      onEvent: (event) => {
        this.onEvent(event);
      },
      workerSession: await this.implementer(),
      workerPreface: () => this.implementerPreface(),
      ...reviewer.options,
      worker: () => Promise.reject(new Error('the implementer session is given')),
      subagents: {
        worker: { ...this.policy(this.roles.implementer), proactive: true },
        ...(reviewer.policy ? { reviewer: reviewer.policy } : {}),
      },
      onApproval: ({ role, agent, request }, signal) =>
        this.askPermission(roleOf(role), agent, request.summary, signal),
      onWorkerTurn: () => {
        turnBase = snapshot(config.cwd, this.ignored);
      },
      facts: async () => {
        const facts = await this.facts(baseline, turnBase);
        shown.facts = true;
        this.events.update({ type: 'notice', level: 'info', text: facts });
        return facts;
      },
      // The messages of a review go on by themselves, shown in the thread (ADR 0029).
      intercept: () => Promise.reject(new Error('a review passes its messages on')),
      onMalformedDelegation: () => Promise.reject(new Error('no delegation in a review')),
    });
    this.stopRunning = () => loop.stop();
    const outcome = await loop.done;
    if (taskUnfinished(this.task) && outcome.status !== 'delegated')
      throw new Error(`Task review did not complete: ${outcome.status}`);
    return outcome.status === 'delegated' && outcome.review !== undefined
      ? {
          report: outcome.report,
          reportData: outcome.reportData,
          facts: outcome.facts,
          review: outcome.review,
        }
      : undefined;
  }

  private queueForLeader(pending: PendingReport): void {
    const taskId = this.task?.id;
    if (!taskId || !this.unseen.some((item) => item.taskId === taskId)) {
      this.unseen.push({ ...pending, ...(taskId ? { taskId } : {}) });
    } else {
      this.unseen = this.unseen.map((item) =>
        item.taskId === taskId ? { ...pending, taskId } : item,
      );
    }
  }

  /** Work the leader has not seen, kept for the user's next message to it. */
  private keepForLeader(pending: PendingReport, what: string): void {
    this.queueForLeader(pending);
    this.events.unseen?.(this.unseen);
    this.events.update({
      type: 'notice',
      level: 'info',
      text: `The leader will read ${what} with your next message.`,
    });
  }

  /**
   * A turn of the implementer alone; reviewed when the reviewer is on (ADR
   * 0033), then its report, or the review in its place, waits for the leader.
   */
  private async toImplementer(
    text: string,
    baseline: ReturnType<typeof snapshot>,
    shown: { facts: boolean },
    skill?: SkillRef,
  ): Promise<void> {
    this.verification.begin();
    const initial =
      this.resuming && this.task
        ? this.task.progress
        : {
            brief: text,
            source: 'direct' as const,
            delivery: 'deferred' as const,
            direct: true,
            limit: Math.max(0, Math.min(this.reviewerConfig?.rounds ?? 0, 3)),
            used: 0,
          };
    this.saveTaskProgress({ ...initial, step: 'implementation', inFlight: false });
    const session = await this.implementer();
    const notes = this.takeNotes('implementer');
    this.saveTaskProgress({ ...initial, step: 'implementation', inFlight: true });
    const result = await this.implementerTurn(
      session,
      directMessagePrompt(
        [
          this.implementerPreface(),
          notes,
          this.resuming
            ? 'Continue the approved work described in the saved recovery context.'
            : text,
        ]
          .filter(Boolean)
          .join('\n\n'),
      ),
      true,
      skill,
    );
    // The report call, rendered; a turn that made none is its text.
    const report = result.reportText;
    const { reportCommandEvidence } = result;
    this.saveTaskProgress({
      ...(this.task?.progress ?? { brief: text, direct: true, limit: 0, used: 0 }),
      work: { text: report, data: result.report, commandEvidence: reportCommandEvidence },
      step: this.reviewerConfig && result.report?.outcome !== 'blocked' ? 'review' : 'verification',
      inFlight: false,
    });
    this.lastWork = { brief: text, report, reportCommandEvidence, direct: true };
    // A report that stopped on a missing decision goes to the leader as it is.
    const judged =
      this.reviewerConfig && result.report?.outcome !== 'blocked'
        ? await this.reviewWork(
            { brief: text, report, reportData: result.report, reportCommandEvidence, direct: true },
            baseline,
            shown,
          )
        : undefined;
    if (judged) {
      this.lastWork = {
        brief: text,
        report: judged.report,
        reportCommandEvidence: this.lastWork.reportCommandEvidence,
        direct: true,
      };
      this.keepForLeader(
        {
          source: 'direct',
          request: text,
          report: judged.report,
          facts: judged.facts,
          review: judged.review,
        },
        'this work and its review',
      );
      return;
    }
    if (this.task)
      this.saveTaskProgress({ ...this.task.progress, step: 'verification', inFlight: true });
    const comparison = await this.verification.finish(
      result.report?.test,
      'implementer',
      this.requestController.signal,
    );
    const facts = [await this.facts(baseline), comparison.summary].join('\n\n');
    if (this.task)
      this.saveTaskProgress({
        ...this.task.progress,
        step: 'delivery',
        inFlight: false,
        result: { facts },
      });
    shown.facts = true;
    this.events.update({ type: 'notice', level: 'info', text: facts });
    this.keepForLeader(
      {
        source: 'direct',
        request: text,
        report,
        facts: [facts, reportCommandEvidence].filter(Boolean).join('\n\n'),
      },
      'this report',
    );
  }

  /**
   * A review the user asks the reviewer for (ADR 0033): of the last work, if
   * any, with the user's words; it waits for the leader like a direct report.
   */
  private async toReviewer(
    text: string,
    baseline: ReturnType<typeof snapshot>,
    shown: { facts: boolean },
  ): Promise<void> {
    this.verification.beginReview();
    const previous =
      this.task?.progress.step === 'completed' ? this.task : this.config.lastCompletedTask;
    if (previous?.verification)
      this.verification.restore({
        ...previous.verification,
        id: this.id('v'),
        round: 0,
        budget: Math.max(0, Math.min(this.reviewerConfig?.rounds ?? 0, 3)),
      });
    const work = this.lastWork;
    const judged = await this.reviewWork(
      {
        brief: work?.brief ?? '',
        report: work?.report ?? '',
        reportCommandEvidence: work?.reportCommandEvidence,
        // A direct message has no brief to hold the report to.
        ...(work?.direct
          ? { direct: true }
          : work?.reportData !== undefined
            ? { reportData: work.reportData }
            : {}),
        asked: text,
      },
      baseline,
      shown,
    );
    if (!judged) return;
    if (work) {
      this.lastWork = {
        brief: work.brief,
        direct: work.direct,
        report: judged.report,
        reportCommandEvidence: this.lastWork?.reportCommandEvidence,
        ...(!work.direct ? { reportData: judged.reportData } : {}),
      };
    }
    this.keepForLeader(
      {
        source: 'review',
        request: text,
        report: judged.report,
        facts: judged.facts,
        review: judged.review,
      },
      'the review',
    );
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
    this.leaderSession ??= await this.openSession(
      'leader',
      this.factory('leader', this.roles.leader, await this.bridgeFor('leader')),
      agentSessionOptions(
        this.withUserInstructions(
          'leader',
          // Every leader has the questions tool, Codex's or Claude's (ADR 0019, 0022).
          leaderInstructions(this.roles.implementer.cli),
        ),
        leaderPolicy,
        handoffTools('leader', config.handoffServer),
      ),
    );
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
    const reviewer = this.reviewerOptions(baseline);
    let turnBase: ReturnType<typeof snapshot> | undefined;
    const loop = runLoop({
      request: text,
      handoffServer: config.handoffServer,
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
      task: this.taskJournal(),
      verification: this.verification,
      leaderSession: this.leaderSession,
      referenceKind: referenceKind(config.cwd, this.ignored),
      workerSession: () => this.implementer(),
      workerPreface: () => this.implementerPreface(),
      review: config.review,
      ...(reviewer?.options ?? {}),
      autoApprove: !manual,
      worker: () => Promise.reject(new Error('the implementer session is given')),
      subagents: {
        orchestrator: leaderPolicy,
        worker: { ...this.policy(this.roles.implementer), proactive: true },
        ...(reviewer?.policy ? { reviewer: reviewer.policy } : {}),
      },
      onApproval: ({ role, agent, request }, signal) =>
        this.askPermission(roleOf(role), agent, request.summary, signal),
      onQuestion: ({ role, agent, questions }, signal) =>
        this.ask(roleOf(role), agent, questions, signal),
      onWorkerTurn: () => {
        turnBase = snapshot(config.cwd, this.ignored);
      },
      facts: async () => {
        const facts = await this.facts(baseline, turnBase);
        shown.facts = true;
        this.events.update({ type: 'notice', level: 'info', text: facts });
        return facts;
      },
      intercept: (message, signal) =>
        new Promise<InterceptDecision>((resolve, reject) => {
          const id = this.id('a');
          this.pending.set(id, resolve);
          const held: DraftDelegation = {
            id,
            text: message.text,
            from: message.from,
            to: message.to,
            ...scopeOf(message),
          };
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
            ...scopeOf(message),
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
    if (taskUnfinished(this.task) && !['delegated', 'completed', 'result'].includes(outcome.status))
      throw new Error(`Task did not complete: ${outcome.status}`);
    if (outcome.status === 'delegated') {
      if (this.lastWork && !this.lastWork.direct) {
        this.lastWork = {
          ...this.lastWork,
          report: outcome.report,
          reportData: outcome.reportData,
        };
      }
      this.queueForLeader({
        source: 'delegation',
        request: outcome.spec,
        report: outcome.report,
        facts: outcome.facts,
        ...(outcome.review !== undefined ? { review: outcome.review } : {}),
      });
      this.events.update({
        type: 'notice',
        level: 'info',
        text: 'The leader will read the report with your next message.',
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

  /**
   * An agent's questions, shown in the dock while its turn waits (ADR 0019);
   * stopping leaves them unanswered.
   */
  private ask(
    role: TurnRole,
    agent: string,
    questions: readonly AgentQuestion[],
    signal?: AbortSignal,
  ): Promise<QuestionAnswers> {
    return new Promise((resolve) => {
      const id = this.id('q');
      this.questions.set(id, {
        resolve,
        secret: new Set(questions.filter((q) => q.secret).map((q) => q.id)),
      });
      signal?.addEventListener('abort', () => {
        this.decline(id, 'declined');
      });
      this.events.update({ type: 'question', id, role, agent, questions });
    });
  }

  /** The user's answers to an agent's questions; a secret answer is never kept. */
  answer(id: string, answers: Readonly<Record<string, readonly string[]>>): void {
    const pending = this.questions.get(id);
    if (!pending) return;
    this.questions.delete(id);
    pending.resolve(answers);
    const shown = Object.fromEntries(
      Object.entries(answers).map(([key, values]) => [
        key,
        pending.secret.has(key) ? values.map(() => '••••') : values,
      ]),
    );
    this.events.update({ type: 'question_closed', id, outcome: 'answered', answers: shown });
  }

  private decline(id: string, outcome: 'declined' | 'interrupted'): void {
    const pending = this.questions.get(id);
    if (!pending) return;
    this.questions.delete(id);
    pending.resolve(null);
    this.events.update({ type: 'question_closed', id, outcome });
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
      if (this.restored?.id === id)
        void this.sendDraft(action, text).catch((error: unknown) => {
          this.events.update({
            type: 'notice',
            level: 'error',
            text: error instanceof Error ? error.message : String(error),
          });
        });
      return;
    }
    this.pending.delete(id);
    if (this.held?.id === id) {
      if (!this.taskEnabled || action === 'cancel') {
        this.held = undefined;
        this.events.draft?.(null);
      }
    }
    resolve(
      action === 'edit' && text !== undefined
        ? { action: 'edit', text }
        : { action: action === 'cancel' ? 'cancel' : 'approve' },
    );
    if (!this.taskEnabled || action === 'cancel')
      this.events.update({ type: 'approval_closed', id, action });
  }

  private checkStop(): void {
    if (this.stopRequested || this.closing) throw new StoppedBeforeTurn();
  }

  async stop(): Promise<void> {
    this.stopRequested = true;
    this.requestController.abort();
    // Whatever is still waiting for the user is declined.
    for (const id of [...this.permissions.keys()]) this.permit(id, 'decline');
    for (const id of [...this.questions.keys()]) this.decline(id, 'declined');
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
        // The orchestrator is read-only; the others may write.
        if (event.role !== 'orchestrator') this.folderMayHaveChanged();
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
        if (event.role !== 'orchestrator') this.folderMayHaveChanged();
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
          ...(event.handoff ? { handoff: event.handoff } : {}),
          ...(usage ? { usage } : {}),
        });
        this.events.turnUsage?.(event.identity.provider, usage, event.quota ?? null);
        if (role === 'implementer' && this.lastWork) {
          // The data of the report call is not in the event: unknown until the loop ends.
          const { brief, direct } = this.lastWork;
          this.lastWork = {
            brief,
            direct,
            report: event.handoff?.tool === 'report' ? event.handoff.text : event.text,
            reportCommandEvidence: event.handoff?.commandEvidence,
          };
        }
        // The reviewer's session lasts one review: nothing of it is kept to resume.
        if (role === 'reviewer') break;
        if (event.context) this.events.context?.(role, event.context);
        this.noteSession(role, event.identity.sessionId);
        break;
      }
      case 'step': {
        const turnId = this.currentTurn.get(roleOf(event.role));
        if (turnId) update({ type: 'step', turnId, step: event.step });
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
          text: `Request from ${event.agent} denied: ${event.request.summary}`,
        });
        break;
      case 'intercepted':
        this.lastIntercepted = event.message;
        // The last work a review the user asks for looks at (ADR 0033).
        if (event.message.kind === 'delegation') {
          this.lastWork = { brief: event.message.text, report: '', direct: false };
        }
        break;
      case 'decision': {
        if (this.taskEnabled && event.kind === 'delegation' && this.held) {
          const held = this.held;
          this.held = undefined;
          this.events.draft?.(null);
          update({
            type: 'approval_closed',
            id: held.id,
            action:
              event.action === 'edit' ? 'edit' : event.action === 'cancel' ? 'cancel' : 'sent',
          });
        }
        if (event.kind === 'delegation' && event.text !== undefined && this.lastWork) {
          this.lastWork = { ...this.lastWork, brief: event.text };
        }
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
          ...scopeOf(message),
        });
        update({ type: 'approval_closed', id, action: 'sent' });
        break;
      }
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
