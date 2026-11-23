// The leader's and the implementer's sessions for a chat (ADR 0011, 0012,
// 0017, 0027): the roles as configured, each role's CLI session, the sessions
// a reopened chat resumes, the permission bridges, and a pending handoff.
// ChatSession decides when a turn runs; this opens, resumes and closes the
// sessions. Node only, no `vscode`.

import { startPermissionBridge, type PermissionBridge } from '@only-one-chat/adapters';
import {
  agentSessionOptions,
  handoffTools,
  implementerInstructions,
  leaderInstructions,
  type AgentFactory,
  type AgentSession,
  type SubagentPolicy,
} from '@only-one-chat/runtime';
import type { RoleName } from '../shared/protocol.js';
import {
  hasJunit,
  policyOf,
  readOnly,
  StoppedBeforeTurn,
  withUserInstructions,
  type AgentChoice,
  type ChatConfig,
  type ChatEvents,
} from './chat-types.js';
import { PROVIDERS } from './providers.js';
import type { UserRequests } from './user-requests.js';

export interface RoleSessionsDeps {
  readonly config: ChatConfig;
  readonly events: Pick<ChatEvents, 'update' | 'sessionId' | 'saveImplementerHandoff'>;
  /** Where a role's permission request waits for the user (R9). */
  readonly requests: UserRequests;
  /** The user stopped the request running now. */
  readonly stopRequested: () => boolean;
  /** The chat is being closed. */
  readonly closing: () => boolean;
  /** A saved task is being resumed. */
  readonly resuming: () => boolean;
  /** The CLI session the saved task recorded for a role; a read with no side effect. */
  readonly savedSession: (role: RoleName) => string | undefined;
}

export class RoleSessions {
  private leaderSessionNow: AgentSession | undefined;
  /** Kept across delegations and direct messages: a follow-up costs it little (calc-small). */
  private implementerSession: AgentSession | undefined;
  /** The pending handoff, until the replacement session ID is saved. */
  private pendingHandoff: string | undefined;
  private readonly recoveredWithoutHistory = new Set<RoleName>();
  /** The permission bridges of the Claude roles, for the chat. */
  private readonly bridges = new Map<RoleName, PermissionBridge>();
  /** Sessions of a reopened chat not resumed yet. */
  private readonly resumable = new Map<RoleName, string>();
  /** The CLIs' own session of each role, as last reported. */
  private readonly nativeSessions = new Map<RoleName, string>();
  /** Roles whose session is reopened with new rules before their next turn. */
  private readonly reopen = new Set<RoleName>();
  /** The roles as configured, with the effort the user chose during the chat. */
  private readonly rolesNow: { leader: AgentChoice; implementer: AgentChoice };

  /**
   * `saved`: the sessions a reopened chat continues, by role; `handoff`: a
   * pending handoff, already validated, whose implementer session is not resumed.
   */
  constructor(
    private readonly deps: RoleSessionsDeps,
    saved: Readonly<Record<string, unknown>>,
    handoff: string | undefined,
  ) {
    const { config } = deps;
    this.rolesNow = { leader: readOnly(config.leader), implementer: config.implementer };
    this.pendingHandoff = handoff;
    for (const [role, id] of Object.entries(saved) as [RoleName, string][]) {
      if (!['leader', 'implementer'].includes(role) || typeof id !== 'string' || id.length > 512)
        continue;
      if (role === 'implementer' && this.pendingHandoff !== undefined) continue;
      this.resumable.set(role, id);
    }
  }

  /** The roles now, as a task records them; not a copy. */
  get roles(): { readonly leader: AgentChoice; readonly implementer: AgentChoice } {
    return this.rolesNow;
  }

  /** The roles of this chat, with the user's changes. */
  get currentRoles(): { readonly leader: AgentChoice; readonly implementer: AgentChoice } {
    return { ...this.rolesNow };
  }

  get handoffBrief(): string | undefined {
    return this.pendingHandoff;
  }

  /** The CLI's own session of a role, as last reported; a read with no side effect. */
  native(role: RoleName): string | undefined {
    return this.nativeSessions.get(role);
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
    const before = this.rolesNow[role];
    if (choice.cli !== before.cli) return false;
    const locked = role === 'leader' && choice.model !== before.model;
    if (locked) choice = { ...choice, model: before.model };
    this.rolesNow[role] = choice;
    const session = role === 'leader' ? this.leaderSessionNow : this.implementerSession;
    if (choice.permission !== before.permission && session) {
      this.reopen.add(role);
      return !locked;
    }
    if (choice.model !== before.model) session?.setModel?.(choice.model);
    if (choice.effort !== before.effort) session?.setEffort?.(choice.effort);
    return !locked;
  }

  /** Sessions reopened with new rules: before a message, never during a turn. */
  async applyChanges(): Promise<void> {
    for (const role of this.reopen) {
      this.reopen.delete(role);
      const session = role === 'leader' ? this.leaderSessionNow : this.implementerSession;
      if (role === 'leader') this.leaderSessionNow = undefined;
      else this.implementerSession = undefined;
      await session?.close();
      await this.bridges.get(role)?.close();
      this.bridges.delete(role);
      const native = this.nativeSessions.get(role);
      if (native) this.resumable.set(role, native);
    }
  }

  /** A role's CLI reported its own session: to resume it, now or in a reopened chat. */
  noteSession(role: RoleName, id: string): void {
    if (id.trim() === '') return;
    const { config, events } = this.deps;
    const originalSession = config.resume?.[role] ?? this.deps.savedSession(role);
    if (
      this.deps.resuming() &&
      originalSession &&
      originalSession !== id &&
      !this.recoveredWithoutHistory.has(role)
    ) {
      this.recoveredWithoutHistory.add(role);
      events.update({
        type: 'notice',
        level: 'warn',
        text: `The ${role} provider started a fresh session. Saved task context was supplied for recovery.`,
      });
    }
    if (role === 'implementer' && this.pendingHandoff !== undefined) {
      try {
        events.saveImplementerHandoff(id, null);
      } catch (error) {
        events.update({
          type: 'notice',
          level: 'warn',
          text: `The handoff remains pending because the replacement session could not be saved: ${error instanceof Error ? error.message : String(error)}`,
        });
        return;
      }
      this.pendingHandoff = undefined;
      this.nativeSessions.set(role, id);
      return;
    }
    this.nativeSessions.set(role, id);
    events.sessionId?.(role, id);
  }

  /** The leader's session, opened once for the chat; read-only (ADR 0018). */
  async leader(policy: SubagentPolicy): Promise<AgentSession> {
    const { config } = this.deps;
    // Read-only (ADR 0018): it reasons, searches and delegates; it never writes.
    this.leaderSessionNow ??= await this.openSession(
      'leader',
      this.factory('leader', this.rolesNow.leader, await this.bridgeFor('leader')),
      agentSessionOptions(
        withUserInstructions(
          config,
          'leader',
          // Every leader has the questions tool, Codex's or Claude's (ADR 0019, 0022).
          leaderInstructions(this.rolesNow.implementer.cli),
        ),
        policy,
        handoffTools('leader', config.handoffServer),
      ),
    );
    return this.leaderSessionNow;
  }

  /**
   * The implementer's session, opened once and continued (ADR 0011); after a
   * handoff, a new one that starts from it (ADR 0017).
   */
  async implementer(): Promise<AgentSession> {
    this.checkStop();
    if (this.implementerSession?.closed) {
      const closed = this.implementerSession;
      this.implementerSession = undefined;
      const native = this.nativeSessions.get('implementer');
      if (native) this.resumable.set('implementer', native);
      await closed.close();
    }
    if (!this.implementerSession) {
      const { config } = this.deps;
      const instructions = withUserInstructions(
        config,
        'implementer',
        implementerInstructions({ junit: hasJunit(config) }),
      );
      this.implementerSession = await this.openSession(
        'implementer',
        this.factory('implementer', this.rolesNow.implementer, await this.bridgeFor('implementer')),
        agentSessionOptions(
          instructions,
          { ...policyOf(config, this.rolesNow.implementer), proactive: true },
          handoffTools('implementer', config.handoffServer),
        ),
      );
    }
    this.checkStop();
    return this.implementerSession;
  }

  /** Whether the implementer has a session to hand off: open, or one a reopened chat continues. */
  hasImplementerSession(): boolean {
    return (
      this.implementerSession !== undefined ||
      this.resumable.has('implementer') ||
      this.nativeSessions.has('implementer')
    );
  }

  /**
   * The handoff was written (ADR 0017): it is saved first, then the session
   * it came from is forgotten and closed with its bridge. False when that
   * cleanup did not complete; the handoff stays saved.
   */
  async completeHandoff(session: AgentSession, brief: string): Promise<boolean> {
    this.deps.events.saveImplementerHandoff('', brief);
    this.pendingHandoff = brief;
    this.implementerSession = undefined;
    this.nativeSessions.delete('implementer');
    this.resumable.delete('implementer');
    const bridge = this.bridges.get('implementer');
    this.bridges.delete('implementer');
    const closed = await Promise.allSettled([session.close(), bridge?.close()]);
    return !closed.some((result) => result.status === 'rejected');
  }

  /** Ends the leader's and the implementer's sessions and the bridges: the next message starts new ones. */
  async closeAll(): Promise<void> {
    await this.leaderSessionNow?.close();
    await this.implementerSession?.close();
    this.leaderSessionNow = undefined;
    this.implementerSession = undefined;
    await Promise.allSettled([...this.bridges.values()].map((bridge) => bridge.close()));
    this.bridges.clear();
  }

  checkStop(): void {
    if (this.deps.stopRequested() || this.deps.closing()) throw new StoppedBeforeTurn();
  }

  /** A role's sessions, from its provider (ADR 0022): the leader read-only (ADR 0018). */
  private factory(
    role: RoleName,
    choice: AgentChoice,
    bridge: PermissionBridge | undefined,
  ): AgentFactory {
    return PROVIDERS[choice.cli].factory(
      this.deps.config,
      { choice, leader: role === 'leader' },
      bridge,
    );
  }

  /**
   * The permission bridge of a role that may write, when its provider asks
   * through it (R9): one per role, for the chat. A read-only role has none.
   */
  private async bridgeFor(role: RoleName): Promise<PermissionBridge | undefined> {
    const choice = this.rolesNow[role];
    const hook = this.deps.config.permissionHook;
    const provider = PROVIDERS[choice.cli];
    if (!provider.bridged || !hook || role === 'leader' || choice.permission === 'read-only') {
      return undefined;
    }
    let bridge = this.bridges.get(role);
    if (!bridge) {
      bridge = await startPermissionBridge(
        (request) =>
          this.deps.requests.askPermission(
            role,
            `${provider.name} (${this.rolesNow[role].model})`,
            request.summary,
          ),
        hook,
      );
      if (this.deps.closing()) {
        await bridge.close();
        throw new StoppedBeforeTurn();
      }
      this.bridges.set(role, bridge);
    }
    return bridge;
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
        if (this.deps.stopRequested()) this.resumable.set(role, resume);
        this.checkStop();
        this.deps.events.sessionId?.(role, '');
        this.deps.events.update({
          type: 'notice',
          level: 'warn',
          text: `Could not resume the saved ${role} session (${error instanceof Error ? error.message : String(error)}). A new session will start without the conversation history.`,
        });
      }
    }
    session ??= await factory(options);
    if (this.deps.closing()) {
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
}
