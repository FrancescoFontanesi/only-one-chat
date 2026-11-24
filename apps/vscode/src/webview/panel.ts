import { realpathSync, rmSync } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { getRuntimeInfo } from '@only-one-chat/runtime';
import { cliLaunch, isFake } from '../clis.js';
import type { ChatRoles, RoleSettings, Roles } from '../roles.js';
import { ChatSession, type ReviewerConfig } from '../session/chat.js';
import { cliLabel } from '../detect.js';
import { NodeSession, type NodeChoice } from '../session/node.js';
import { PROVIDERS } from '../session/providers.js';
import { CheckpointStore } from '../session/checkpoints.js';
import { SKIPPED } from '../session/facts.js';
import { ignoredPaths } from '../session/ignore.js';
import { expandMentions, insideFolder, withRefs } from '../session/mentions.js';
import { ChatHistory, forReplay, newChatId, type ChatRecord } from '../session/history.js';
import { checkpointsRoot } from './checkpointContent.js';
import { refreshVerification, verificationUri } from './verificationContent.js';
import { taskUnfinished } from '../session/task.js';
import { refreshTask, taskUri } from './taskContent.js';
import {
  openFile,
  restoreCheckpoint,
  reviewFile,
  saveBeforeSend,
  type FileHost,
} from './fileActions.js';
import type { ModelCatalog } from '../session/catalog.js';
import type { SkillCatalog } from '../session/skills.js';
import type { MonitorStore } from '../session/monitor.js';
import { notifyChat } from '../notifications.js';
import { providerOf, type UsageStore } from '../session/usage.js';
import { createNonce, renderWebviewHtml, STYLESHEETS } from './html.js';
import { agentsGate, consentQuestion, webviewOptions } from './security-gates.js';
import {
  effortFor,
  NODE_NAME_LENGTH,
  parseWebviewMessage,
  type ApprovalMode,
  type Cli,
  type HostToWebviewMessage,
  type SessionInfo,
  type ThreadUpdate,
  type WebviewToHostMessage,
} from './protocol.js';
import { CODEX_INTERVAL_MS } from '../usageReader.js';

const TITLE = 'Only One Chat';

/**
 * The attachments of a message, read as the agents get them (ADR 0015): the
 * paths, a short range of lines included. Undefined without attachments.
 */
function attachedFiles(
  attachments: readonly string[] | undefined,
): { text: string; paths: string[] } | undefined {
  const cwd = workspaceFolder();
  if (!cwd || !attachments || attachments.length === 0) return undefined;
  // shortcut: a path with a space cannot be a `@` token, so it is not attached; quote it when one is needed.
  const expanded = expandMentions(attachments.map((a) => `@${a}`).join(' '), cwd);
  if (expanded.mentions.length === 0) return undefined;
  return {
    text: expanded.attachments,
    paths: expanded.mentions.map(
      (m) => `${m.path}${m.lines ? `#L${String(m.lines.from)}-${String(m.lines.to)}` : ''}`,
    ),
  };
}

/** A chat worth keeping: a message to the leader, the implementer or a node. */
function hasContent(record: ChatRecord): boolean {
  return (
    record.updates.length > 0 ||
    Object.values(record.nodes ?? {}).some((thread) => thread.updates.length > 0)
  );
}

/**
 * The folder the agents work in: the first workspace folder (ADR 0010), in
 * its long form. Claude asks for manual approval on 8.3 short names, which no
 * hook can give (verified on 2.1.308).
 */
function workspaceFolder(): string | null {
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!folder) return null;
  try {
    return realpathSync.native(folder);
  } catch {
    return folder;
  }
}

/** Folders never offered for `@`: the same as the checkpoints skip. */
const EXCLUDED = `{${[...SKIPPED].map((name) => `**/${name}/**`).join(',')}}`;

/** The folder's files and their folders, for `@` in the composer; at most 5000 files. */
async function folderPaths(): Promise<string[]> {
  const files = await vscode.workspace.findFiles('**/*', EXCLUDED, 5000);
  const paths = new Set<string>();
  for (const uri of files) {
    const file = vscode.workspace.asRelativePath(uri, false).split(path.sep).join('/');
    paths.add(file);
    const parts = file.split('/');
    for (let i = 1; i < parts.length; i++) paths.add(`${parts.slice(0, i).join('/')}/`);
  }
  return [...paths].sort();
}

/** Shared by the panel and the views it feeds. */
export interface PanelServices {
  readonly usage: UsageStore;
  readonly monitor: MonitorStore;
  readonly roles: RoleSettings;
  readonly catalog: ModelCatalog;
  /** The CLIs' skills for `$` (ADR 0019). */
  readonly skills: SkillCatalog;
  readonly refreshUsage: () => Promise<void>;
}

/** Single editor panel hosting the chat with the leader. */
export class OnlyOneChatPanel {
  static readonly viewType = 'onlyOneChat.panel';

  private static current: OnlyOneChatPanel | undefined;
  private static readonly readyEmitter = new vscode.EventEmitter<void>();
  private static readonly rolesEmitter = new vscode.EventEmitter<void>();

  /** Fires each time a panel's webview has loaded and received its status. */
  static readonly onDidBecomeReady = OnlyOneChatPanel.readyEmitter.event;

  /** The roles of the chat shown, for the roles view. */
  static readonly chatRoles: ChatRoles = {
    current: () => OnlyOneChatPanel.current?.chatRoles() ?? null,
    onDidChange: OnlyOneChatPanel.rolesEmitter.event,
  };

  /** A new, empty chat in the panel shown (command palette). */
  static async newChat(): Promise<void> {
    const current = OnlyOneChatPanel.current;
    if (current && !current.chat?.busy) await current.switchTo(current.emptyRecord());
  }

  /**
   * Puts a mention of the editor's file, or of its selection, in the composer
   * (command onlyOneChat.addSelection); the chat opens if it is closed.
   */
  static insertFromEditor(context: vscode.ExtensionContext, services: PanelServices): void {
    const editor = vscode.window.activeTextEditor;
    const cwd = workspaceFolder();
    if (!editor || editor.document.uri.scheme !== 'file' || !cwd) return;
    const file = path.relative(cwd, editor.document.uri.fsPath);
    if (file === '' || file.startsWith('..') || path.isAbsolute(file)) {
      void vscode.window.showWarningMessage('The file is outside the agents’ workspace.');
      return;
    }
    const selection = editor.selection;
    const lines = selection.isEmpty
      ? ''
      : `#L${String(selection.start.line + 1)}-${String(
          // A selection ending at the start of a line does not take that line.
          selection.end.character === 0 && selection.end.line > selection.start.line
            ? selection.end.line
            : selection.end.line + 1,
        )}`;
    OnlyOneChatPanel.show(context, services);
    OnlyOneChatPanel.current?.insert(`@${file.split(path.sep).join('/')}${lines} `);
  }

  /** Stops what the chat is running (command palette). */
  static async stop(): Promise<void> {
    await OnlyOneChatPanel.current?.chat?.stop();
  }

  static show(context: vscode.ExtensionContext, services: PanelServices): void {
    if (OnlyOneChatPanel.current) {
      OnlyOneChatPanel.current.panel.reveal();
      return;
    }
    const webviewRoot = vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview');
    const mediaRoot = vscode.Uri.joinPath(context.extensionUri, 'media');
    const panel = vscode.window.createWebviewPanel(
      OnlyOneChatPanel.viewType,
      TITLE,
      vscode.ViewColumn.Active,
      { ...webviewOptions([webviewRoot, mediaRoot]), retainContextWhenHidden: true },
    );
    OnlyOneChatPanel.current = new OnlyOneChatPanel(
      panel,
      context,
      services,
      webviewRoot,
      mediaRoot,
    );
    OnlyOneChatPanel.rolesEmitter.fire();
  }

  private readonly disposables: vscode.Disposable[] = [];
  private chat: ChatSession | undefined;
  private recoveringTask = false;
  /** The CLIs the chat could start, the reviewer's among them (ADR 0033). */
  private launched = new Set<Cli>();
  /** The nodes spoken to in the chat shown (ADR 0023), opened on their first message. */
  private readonly nodes = new Map<string, NodeSession>();
  /** How full each node's session is after its latest turn, for CTX. */
  private readonly nodeContexts = new Map<string, { used: number; window: number | null }>();
  /** The chats of this folder (R5), and the one shown: saved after each update. */
  private readonly history: ChatHistory;
  private record: ChatRecord;
  private saveTimer: NodeJS.Timeout | undefined;
  private mode: ApprovalMode;
  /** The user agreed that the agents may change this folder. */
  private confirmedFolder: string | undefined;
  /** The webview has loaded: messages to it are no longer lost. */
  private ready = false;
  /** Text for the composer that arrived before the webview loaded. */
  private pendingInsert: string | undefined;

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly context: vscode.ExtensionContext,
    private readonly services: PanelServices,
    webviewRoot: vscode.Uri,
    mediaRoot: vscode.Uri,
  ) {
    const mode = vscode.workspace.getConfiguration('onlyOneChat').get<string>('approvalMode');
    this.mode = mode === 'auto' ? 'auto' : 'manual';
    const storage = context.storageUri ?? context.globalStorageUri;
    // A chat dropped from the history takes its checkpoints with it.
    this.history = new ChatHistory(vscode.Uri.joinPath(storage, 'chats').fsPath, (id) => {
      rmSync(checkpointsRoot(context, id), { recursive: true, force: true });
    });
    // The most recent chat of this folder comes back; otherwise a new one.
    const latest = this.history.list()[0];
    this.record = (latest && this.history.load(latest.id)) ?? this.emptyRecord();
    this.showRoles();
    const webview = panel.webview;
    webview.html = renderWebviewHtml({
      cspSource: webview.cspSource,
      nonce: createNonce(),
      scriptUri: webview.asWebviewUri(vscode.Uri.joinPath(webviewRoot, 'main.js')).toString(),
      styleUris: STYLESHEETS.map((file) =>
        webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'cn', file)).toString(),
      ),
      title: TITLE,
    });

    this.disposables.push(
      webview.onDidReceiveMessage((raw: unknown) => {
        const message = parseWebviewMessage(raw);
        // A failure shows in the chat, never silently (a click that did nothing).
        if (message) {
          this.handleMessage(message).catch((error: unknown) => {
            this.notice('error', error instanceof Error ? error.message : String(error));
          });
        }
      }),
      panel.onDidDispose(() => {
        this.dispose();
      }),
      vscode.workspace.onDidGrantWorkspaceTrust(() => {
        void this.postSession();
      }),
      // The Squad panel lives in the chat (ADR 0016): its data follows the stores.
      { dispose: services.monitor.onChange(() => void this.postSquad('monitor')) },
      { dispose: services.usage.onChange(() => void this.postSquad('usage')) },
      { dispose: services.catalog.onChange(() => void this.postSquad('roles')) },
      OnlyOneChatPanel.rolesEmitter.event(() => void this.postSquad('roles')),
      // Codex's usage windows every two minutes while the chat is in view (no quota).
      panel.onDidChangeViewState(() => {
        this.watchUsage();
      }),
      services.roles.onDidChange(() => {
        this.applyRoles();
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('onlyOneChat.composer')) void this.postSession();
      }),
    );
  }

  /**
   * The roles of a chat: those of the roles view, but a chat keeps the
   * providers it ran with (ADR 0012): moving its work to another provider is a
   * handoff, not a setting.
   */
  private rolesFor(record: ChatRecord): Roles {
    const next = this.services.roles.get();
    const keep = (role: 'leader' | 'implementer') => {
      const own = record.roles?.[role];
      return own && own.cli !== next[role].cli ? own : next[role];
    };
    return { leader: keep('leader'), implementer: keep('implementer') };
  }

  /** The roles of the chat shown, once it has run: null for a chat not started yet. */
  private chatRoles(): Roles | null {
    if (this.chat) return this.chat.currentRoles;
    return this.record.roles?.leader && this.record.roles.implementer
      ? this.rolesFor(this.record)
      : null;
  }

  /** The roles changed in the roles view: the chat takes what stays on its providers. */
  private applyRoles(): void {
    const settings = new Map(this.services.roles.nodes().map((node) => [node.id, node]));
    for (const [id, session] of this.nodes) {
      const node = settings.get(id);
      if (node) void session.configure(node);
      else {
        // Removed from the board: its session ends.
        this.nodes.delete(id);
        void session.close();
      }
    }
    const chat = this.chat;
    if (chat) {
      const next = this.services.roles.get();
      for (const role of ['leader', 'implementer'] as const) chat.setRole(role, next[role]);
      chat.setReviewer(this.reviewerFor());
      this.record.roles = { ...chat.currentRoles };
      this.keep(this.record);
    }
    this.showRoles();
    void this.postSession();
  }

  /** Tells the activity and roles views which roles the chat shown has. */
  private showRoles(): void {
    const roles = this.chatRoles() ?? this.rolesFor(this.record);
    this.services.monitor.setContext(this.record.context ?? {});
    this.services.monitor.setRoles({
      leader: this.services.roles.info(roles.leader),
      implementer: this.services.roles.info(roles.implementer),
    });
    OnlyOneChatPanel.rolesEmitter.fire();
  }

  private sessionInfo(): SessionInfo {
    const roles = this.chatRoles() ?? this.rolesFor(this.record);
    return {
      ...(this.record.taskInvalid
        ? {
            task: {
              id: 'task-invalid',
              status: 'invalid' as const,
              step: 'unavailable',
              used: 0,
              limit: 0,
            },
          }
        : this.record.task
          ? {
              task: {
                id: this.record.task.id,
                status:
                  this.record.task.progress.step === 'completed'
                    ? ('completed' as const)
                    : this.record.task.progress.step === 'cancelled'
                      ? ('cancelled' as const)
                      : this.chat?.busy
                        ? ('running' as const)
                        : this.record.task.progress.inFlight
                          ? ('recovery_required' as const)
                          : ('interrupted' as const),
                step: this.record.task.progress.step,
                used: this.record.task.progress.used,
                limit: this.record.task.progress.limit,
              },
            }
          : {}),
      implementerHandoffPending: this.record.implementerHandoff !== undefined,
      workspace: workspaceFolder(),
      trusted: vscode.workspace.isTrusted,
      leader: this.services.roles.info(roles.leader),
      implementer: this.services.roles.info(roles.implementer),
      mode: this.mode,
      fake: isFake(this.context),
      busy: this.chat?.busy ?? false,
      busyNodes: [...this.nodes].filter(([, node]) => node.busy).map(([id]) => id),
      nodeContext: Object.fromEntries(this.nodeContexts),
      removedNodes: (() => {
        const onBoard = new Set(this.services.roles.nodes().map((n) => n.id));
        return Object.entries(this.record.nodes ?? {})
          .filter(([id, thread]) => !onBoard.has(id) && thread.updates.length > 0)
          .map(([id, thread]) => ({
            id,
            name: thread.name ?? 'Nodo rimosso',
            cli: thread.cli ?? 'antigravity',
          }));
      })(),
      title: this.record.title,
      chats: this.history.list().map(({ id, title, updatedAt, roles, implementerUsed, nodes }) => ({
        id,
        title,
        updatedAt,
        ...(roles?.leader ? { leader: this.services.roles.info(roles.leader).modelName } : {}),
        ...(roles?.implementer
          ? { implementer: this.services.roles.info(roles.implementer).modelName }
          : {}),
        implementerUsed,
        nodes,
      })),
      chatId: this.record.id,
      enterSends:
        vscode.workspace.getConfiguration('onlyOneChat').get<boolean>('composer.enterSends') ??
        true,
      context: this.record.context ?? {},
      usageThreshold:
        vscode.workspace
          .getConfiguration('onlyOneChat')
          .get<number>('notifications.usageThreshold') ?? 80,
    };
  }

  /** The Squad panel's data: roles and models, the agents' activity, the usage windows. */
  private postSquad(part: 'roles' | 'monitor' | 'usage'): Thenable<boolean> | undefined {
    if (!this.ready) return undefined;
    if (part === 'roles') {
      return this.post({
        type: 'roles',
        roles: this.services.roles.state(this.chatRoles(), isFake(this.context)),
      });
    }
    if (part === 'monitor') {
      return this.post({ type: 'monitor', monitor: this.services.monitor.snapshot() });
    }
    return this.post({ type: 'usage', providers: this.services.usage.snapshot() });
  }

  private usageTimer: NodeJS.Timeout | undefined;

  private watchUsage(): void {
    clearInterval(this.usageTimer);
    this.usageTimer = this.panel.visible
      ? setInterval(() => void this.services.refreshUsage(), CODEX_INTERVAL_MS)
      : undefined;
  }

  private emptyRecord(): ChatRecord {
    const now = Date.now();
    return {
      version: 1,
      id: newChatId(now),
      title: '',
      createdAt: now,
      updatedAt: now,
      sessions: {},
      updates: [],
    };
  }

  /** Keeps an update of the shown chat, or of one of its nodes; written to disk shortly after (R5). */
  private remember(update: ThreadUpdate, node?: { id: string; name: string; cli: Cli }): void {
    const record = this.record;
    if (update.type === 'user' && record.title === '') {
      record.title = update.text.replace(/^(@impl|\/(fai|delega|chiedi))\b\s*/i, '').slice(0, 60);
      void this.postSession();
    }
    if (node) {
      record.nodes ??= {};
      const thread = (record.nodes[node.id] ??= { updates: [] });
      thread.name = node.name;
      thread.cli = node.cli;
      thread.updates.push(update);
    } else record.updates.push(update);
    record.updatedAt = Date.now();
    this.scheduleSave();
  }

  /** Saves a record the chat changed: soon if it is shown, at once if the user switched away. */
  private keep(record: ChatRecord): void {
    if (record === this.record) {
      this.scheduleSave();
      return;
    }
    try {
      if (hasContent(record)) this.history.save(record);
    } catch {
      // The chat is no longer shown; the next change to it tries again.
    }
  }

  private scheduleSave(): void {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveNow();
    }, 1000);
  }

  private saveNow(): void {
    clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    // An empty chat is not kept.
    if (!hasContent(this.record)) return;
    try {
      this.history.save(this.record);
    } catch (error) {
      this.notice(
        'warn',
        `Could not save the chat: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Redraws the shown chat in the webview, as it was left: a delegation kept
   * with the chat (ADR 0018) waits again for the user, its card shown anew if
   * the thread no longer holds it.
   */
  private async replay(): Promise<void> {
    await this.post({ type: 'reset' });
    const draft = this.record.draft ?? undefined;
    const updates = forReplay(this.record.updates, draft?.id);
    const cwd = workspaceFolder();
    // The files a text names are found again: the folder may have changed, and
    // older chats were kept before links and inline paths counted (ADR 0024).
    const linked = (update: ThreadUpdate) => (cwd ? withRefs(update, cwd) : update);
    for (const update of updates) {
      await this.post({ type: 'thread', update: linked(update) });
    }
    if (draft && !updates.some((u) => u.type === 'approval' && u.id === draft.id)) {
      const card: ThreadUpdate = { type: 'approval', kind: 'delegation', ...draft };
      await this.post({ type: 'thread', update: cwd ? withRefs(card, cwd) : card });
    }
    for (const [node, thread] of Object.entries(this.record.nodes ?? {})) {
      for (const update of forReplay(thread.updates)) {
        await this.post({ type: 'thread', update: linked(update), node });
      }
    }
  }

  /** Shows another chat: the current one is saved and its agents closed. */
  private async switchTo(record: ChatRecord): Promise<void> {
    this.saveNow();
    // The chosen chat shows at once; the agents of the one left close in the background:
    // a CLI may take seconds to exit, and that chat is already saved.
    const leaving = this.chat;
    this.chat = undefined;
    void Promise.allSettled([leaving?.dispose(), this.closeNodes()]);
    this.services.monitor.reset();
    this.record = record;
    this.showRoles();
    await this.replay();
    void this.postSession();
  }

  private postSession(): Thenable<boolean> {
    return this.post({ type: 'session', session: this.sessionInfo() });
  }

  /** The approvals kept for the session by the chat's roles and the nodes (ADR 0050). */
  private postApprovals(): void {
    const nodes = [...this.nodes.values()].flatMap((node) => node.approvals());
    void this.post({ type: 'approvals', approvals: [...(this.chat?.approvals() ?? []), ...nodes] });
  }

  private notice(level: 'info' | 'warn' | 'error', text: string): void {
    void this.post({ type: 'thread', update: { type: 'notice', level, text } });
  }

  private async handleMessage(message: WebviewToHostMessage): Promise<void> {
    switch (message.type) {
      case 'ready':
        await this.post({
          type: 'status',
          status: {
            extensionVersion: (this.context.extension.packageJSON as { version: string }).version,
            vscodeVersion: vscode.version,
            runtime: getRuntimeInfo(),
            workspaceTrusted: vscode.workspace.isTrusted,
          },
        });
        await this.replay();
        await this.postSession();
        this.ready = true;
        if (this.pendingInsert) await this.post({ type: 'insert', text: this.pendingInsert });
        this.pendingInsert = undefined;
        await this.postSquad('roles');
        await this.postSquad('monitor');
        await this.postSquad('usage');
        this.postApprovals();
        OnlyOneChatPanel.readyEmitter.fire();
        // The models and Codex's usage windows are read when the chat opens: no turn, no quota.
        void this.services.catalog.load();
        void this.services.refreshUsage();
        this.watchUsage();
        break;
      case 'ping':
        void this.post({ type: 'pong', id: message.id, receivedAt: new Date().toISOString() });
        break;
      case 'send': {
        if (message.node !== undefined) {
          await this.sendToNode(message.node, message.text, message.skill, message.attachments);
          break;
        }
        if (!(await saveBeforeSend(workspaceFolder()))) break;
        const chat = await this.ensureChat();
        if (!chat) break;
        // `@` is for files only: the recipient comes from the composer's control.
        const to = message.to ?? 'leader';
        // A skill named with `$` must be one the recipient's CLI listed for this folder.
        const skill =
          message.skill !== undefined && to !== 'reviewer'
            ? this.skillOf(to, message.skill)
            : undefined;
        if (message.skill !== undefined && !skill) {
          this.notice(
            'warn',
            `Message not sent. The recipient does not offer the ${message.skill} skill.`,
          );
          break;
        }
        // The attachments reach the agents' context (ADR 0015); `@` in the text only names a
        // path, which the session gives them as a plain path (ADR 0026).
        await chat.send(message.text, attachedFiles(message.attachments), to, skill);
        break;
      }
      case 'attachFiles':
        await this.pickAttachments();
        break;
      case 'decide': {
        // A delegation kept with a reopened chat starts the chat's agents (ADR 0018).
        const chat =
          this.chat ?? (this.record.draft?.id === message.id ? await this.ensureChat() : undefined);
        chat?.decide(message.id, message.action, message.text);
        break;
      }
      case 'openFile':
        await openFile(workspaceFolder(), message.path, message.from, message.to, (text) => {
          this.notice('warn', text);
        });
        break;
      case 'openVerification': {
        const evidence = this.record.updates.findLast(
          (item) => item.type === 'verification' && item.evidence.id === message.id,
        );
        if (evidence?.type !== 'verification') throw new Error('Verification evidence unavailable');
        const document = await vscode.workspace.openTextDocument(
          verificationUri(this.record.id, message.id),
        );
        await vscode.window.showTextDocument(document, {
          preview: true,
          viewColumn: vscode.ViewColumn.Beside,
        });
        break;
      }
      case 'resumeTask': {
        if (
          this.recoveringTask ||
          this.chat?.busy ||
          !taskUnfinished(this.record.task ?? undefined)
        )
          break;
        this.recoveringTask = true;
        try {
          if (!(await saveBeforeSend(workspaceFolder()))) break;
          const chat = await this.ensureChat();
          if (!chat) break;
          const reason = chat.recoveryReason();
          if (!chat.recoveryConfigurationMatches()) {
            await vscode.window.showWarningMessage(
              reason ?? 'Restore the saved task configuration before continuing.',
              { modal: true },
            );
            break;
          }
          if (reason) {
            const answer = await vscode.window.showWarningMessage(
              reason,
              { modal: true },
              'Continue with current files',
              'Inspect changes',
            );
            if (answer !== 'Continue with current files') break;
          }
          await chat.resumeTask(reason !== undefined);
        } finally {
          this.recoveringTask = false;
        }
        break;
      }
      case 'cancelTask': {
        if (this.chat?.busy || this.recoveringTask) break;
        if (!this.record.taskInvalid && !taskUnfinished(this.record.task ?? undefined)) break;
        if (this.chat) this.chat.cancelTask();
        else {
          this.history.saveTask(
            this.record,
            this.record.task
              ? {
                  ...this.record.task,
                  progress: { ...this.record.task.progress, step: 'cancelled', inFlight: false },
                }
              : null,
          );
          void this.postSession();
        }
        break;
      }
      case 'openTask': {
        const id = this.record.taskInvalid ? 'task-invalid' : this.record.task?.id;
        if (!id) break;
        const document = await vscode.workspace.openTextDocument(taskUri(this.record.id, id));
        await vscode.window.showTextDocument(document, {
          preview: true,
          viewColumn: vscode.ViewColumn.Beside,
        });
        break;
      }
      case 'permit':
        this.chat?.permit(message.id, message.decision);
        for (const node of this.nodes.values()) node.permit(message.id, message.decision);
        break;
      case 'revokeApproval':
        this.chat?.revokeApproval(message);
        for (const node of this.nodes.values()) node.revokeApproval(message);
        break;
      case 'answer':
        this.chat?.answer(message.id, message.answers);
        break;
      case 'stop':
        if (message.node !== undefined) await this.nodes.get(message.node)?.stop();
        else await this.chat?.stop();
        break;
      case 'addNode':
        await this.addNode(message.cli, message.model);
        break;
      case 'setNode': {
        const { id, cli, model, effort, permission } = message;
        const nodes = this.services.roles.nodes();
        const before = nodes.find((n) => n.id === id);
        if (!before) break;
        // A name the node was given from its model follows the model; one the user wrote stays.
        // Any model's or provider's name counts: a node may have been made with another model.
        const base = before.name.replace(/ \d+$/, '');
        const automatic =
          message.name === before.name &&
          (base === this.nodeName(before.cli) ||
            this.services.catalog.snapshot().some((c) => c.models.some((m) => m.name === base)) ||
            Object.values(PROVIDERS).some((p) => p.name === base));
        const name = automatic ? this.nodeName(cli).slice(0, NODE_NAME_LENGTH) : message.name;
        const node = { id, name, cli, model, effort, permission };
        const next = nodes.map((n) => (n.id === node.id ? node : n));
        if (!(await this.services.roles.setNodes(next))) void this.postSquad('roles');
        break;
      }
      case 'setTeamName':
        await this.services.roles.setTeamName(message.name);
        break;
      case 'removeNode':
        await this.removeNode(message.id);
        break;
      case 'setMode':
        this.mode = message.mode;
        this.chat?.setMode(message.mode);
        void this.postSession();
        break;
      case 'newChat':
        await this.switchTo(this.emptyRecord());
        break;
      case 'openChat': {
        const record = this.history.load(message.id);
        if (record) await this.switchTo(record);
        break;
      }
      case 'deleteChat':
        await this.deleteChat(message.id);
        break;
      case 'setRole': {
        const { role, cli, model, effort, permission } = message;
        if (!(await this.services.roles.choose(role, { cli, model, effort, permission }))) {
          void this.postSquad('roles');
        }
        break;
      }
      case 'setReviewerOn':
        await this.services.roles.setReviewerOn(message.enabled);
        break;
      case 'refreshModels':
        await this.services.catalog.load(true);
        break;
      case 'refreshUsage':
        await this.services.refreshUsage();
        break;
      case 'copy':
        await vscode.env.clipboard.writeText(message.text);
        break;
      case 'manageTrust':
        await vscode.commands.executeCommand('workbench.trust.manage');
        break;
      case 'openFolder':
        await vscode.commands.executeCommand('workbench.action.files.openFolder');
        break;
      case 'reviewFile':
        await reviewFile(this.fileHost(), message.id, message.path, message.action);
        break;
      case 'listFiles':
        await this.post({ type: 'files', paths: await folderPaths() });
        break;
      case 'listSkills':
        await this.postSkills(message.cli, message.again === true);
        break;
      case 'handoff':
        if (this.chat) await this.chat.handoff();
        else
          this.notice(
            'info',
            'The chat has not started. The implementer will start a fresh session.',
          );
        break;
      case 'restoreCheckpoint':
        await restoreCheckpoint(this.fileHost(), message.checkpoint);
        break;
      case 'openSettings':
        await vscode.commands.executeCommand('onlyOneChat.openSettings');
        break;
      default:
        break;
    }
  }

  /** The chat, created on the first message once folder, trust and consent are in place. */
  private async ensureChat(): Promise<ChatSession | undefined> {
    if (this.chat) return this.chat;
    const cwd = await this.agentsFolder();
    if (!cwd) return undefined;
    return this.createChat(cwd);
  }

  /** The folder the agents may work in: open, trusted, and agreed to by the user. */
  private async agentsFolder(): Promise<string | undefined> {
    const cwd = workspaceFolder();
    const gate = agentsGate(
      cwd,
      vscode.workspace.isTrusted,
      isFake(this.context),
      this.confirmedFolder,
    );
    if (!gate.ok || !cwd) {
      if (!gate.ok) this.notice('error', gate.reason);
      return undefined;
    }
    if (gate.consent) {
      const answer = await vscode.window.showWarningMessage(
        consentQuestion(cwd),
        { modal: true },
        'Continue',
      );
      if (answer !== 'Continue') return undefined;
      this.confirmedFolder = cwd;
    }
    return cwd;
  }

  /** The PermissionRequest hook script, run by the editor's own Node (R9). */
  private permissionHook() {
    return {
      nodeExecutable: process.execPath,
      nodeEnv: { ELECTRON_RUN_AS_NODE: '1' },
      hookScript: path.join(this.context.extensionPath, 'dist', 'hooks', 'permission-request.mjs'),
    };
  }

  /** The MCP server of the role handoffs, run by the editor's own Node (ADR 0035). */
  private handoffServer() {
    return {
      command: process.execPath,
      args: [path.join(this.context.extensionPath, 'dist', 'handoff-server.js')],
      env: { ELECTRON_RUN_AS_NODE: '1' },
    };
  }

  /**
   * The reviewer of the settings for the chat (ADR 0029, 0033), or none: off,
   * a choice its CLI does not offer, or a CLI the chat could not start.
   */
  private reviewerFor(): ReviewerConfig | undefined {
    const reviewer = this.services.roles.reviewer();
    if (!reviewer.enabled) return undefined;
    const { choice } = reviewer;
    const problem =
      choice.cli !== 'antigravity' && choice.model === ''
        ? 'no model selected'
        : !this.launched.has(choice.cli)
          ? `${cliLabel(choice.cli)} was not found`
          : this.services.roles.problem(choice);
    if (problem) {
      this.notice(
        'warn',
        `Reviewer unavailable (${problem}). The chat will continue without a reviewer.`,
      );
      return undefined;
    }
    return { choice, rounds: reviewer.rounds };
  }

  private async createChat(cwd: string): Promise<ChatSession | undefined> {
    const settings = vscode.workspace.getConfiguration('onlyOneChat');
    // The chat's own record: a turn that ends after a switch must not write into another chat.
    const record = this.record;
    const { leader, implementer } = this.rolesFor(record);
    const launch = { executable: '', launcherArgs: [] as readonly string[] };
    const launches: Record<Cli, typeof launch> = {
      codex: launch,
      claude: launch,
      antigravity: launch,
    };
    try {
      for (const cli of new Set([leader.cli, implementer.cli])) {
        launches[cli] = await cliLaunch(this.context, cli);
      }
    } catch (error) {
      this.notice('error', error instanceof Error ? error.message : String(error));
      return undefined;
    }
    // The reviewer's CLI too, on or off, so it can be switched on during the chat
    // (ADR 0033); one that cannot be found only leaves the chat without a reviewer.
    const reviewerCli = this.services.roles.reviewer().choice.cli;
    if (launches[reviewerCli].executable === '') {
      try {
        launches[reviewerCli] = await cliLaunch(this.context, reviewerCli);
      } catch {
        // Said when the reviewer is wanted (reviewerFor).
      }
    }
    this.launched = new Set(
      (Object.keys(launches) as Cli[]).filter((cli) => launches[cli].executable !== ''),
    );
    const { codex, claude, antigravity } = launches;
    const reviewer = this.reviewerFor();
    const logDir = vscode.Uri.joinPath(this.context.globalStorageUri, 'logs').fsPath;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    record.roles = { leader, implementer };
    this.chat = new ChatSession(
      {
        cwd,
        leader,
        implementer,
        subagents: this.services.roles.subagents(),
        codexExecutable: codex.executable,
        claudeExecutable: claude.executable,
        handoffServer: this.handoffServer(),
        ...(codex.launcherArgs.length > 0 ? { codexLauncherArgs: codex.launcherArgs } : {}),
        ...(claude.launcherArgs.length > 0 ? { claudeLauncherArgs: claude.launcherArgs } : {}),
        ...(antigravity.executable !== '' ? { antigravityExecutable: antigravity.executable } : {}),
        ...(antigravity.launcherArgs.length > 0
          ? { antigravityLauncherArgs: antigravity.launcherArgs }
          : {}),
        ...(reviewer ? { reviewer } : {}),
        allowedCommands: settings.get<string[]>('allowedCommands') ?? [],
        verifyCommand: settings.get<string[]>('verifyCommand') ?? [],
        permissionHook: this.permissionHook(),
        mode: this.mode,
        // A reopened chat continues the CLIs' own sessions; Codex keeps its threads.
        resume: { ...record.sessions },
        task: record.task ?? undefined,
        taskInvalid: record.taskInvalid === true,
        lastCompletedTask: record.lastCompletedTask,
        implementerHandoff: record.implementerHandoff,
        unseen: record.unseen ?? [],
        ...(record.draft ? { draft: record.draft } : {}),
        checkpoints: new CheckpointStore(
          checkpointsRoot(this.context, record.id),
          cwd,
          ignoredPaths(settings.get<string[]>('ignoredPaths') ?? []),
        ),
        ignoredPaths: settings.get<string[]>('ignoredPaths') ?? [],
        fileNotes: record.fileNotes ?? {},
        persistent: true,
        review: settings.get<string>('leaderReview') === 'deferred' ? 'deferred' : 'always',
        instructions: {
          leader: settings.get<string>('leader.instructions') ?? '',
          implementer: settings.get<string>('implementer.instructions') ?? '',
          reviewer: settings.get<string>('reviewer.instructions') ?? '',
        },
        logPath: path.join(logDir, `chat-${stamp}.jsonl`),
      },
      {
        saveTask: (task) => {
          this.history.saveTask(record, task);
          refreshTask(record.id, task?.id ?? 'task-invalid');
          if (record === this.record) void this.postSession();
        },
        update: (raw) => {
          if (record !== this.record) return;
          // The paths its text names, for the thread's links (ADR 0018).
          const update = withRefs(raw, cwd);
          this.remember(update);
          if (update.type === 'verification') refreshVerification(record.id, update.evidence.id);
          this.services.monitor.apply(update);
          if (update.type === 'question') {
            this.notifyIfAway('waiting', 'The leader has a question for you.');
          }
          if (update.type === 'permission' || update.type === 'approval') {
            this.notifyIfAway(
              'waiting',
              update.type === 'permission'
                ? `${update.role === 'leader' ? 'The leader' : update.role === 'reviewer' ? 'The reviewer' : 'The implementer'} requests permission: ${update.summary}`
                : 'An agent handoff is waiting for your approval.',
            );
          }
          void this.post({ type: 'thread', update });
        },
        sessionId: (role, id) => {
          if (record.sessions[role] === id) return;
          record.sessions[role] = id;
          this.keep(record);
        },
        saveImplementerHandoff: (id, brief) => {
          this.history.saveImplementerHandoff(record, id, brief);
          if (record === this.record) void this.postSession();
        },
        context: (role, context) => {
          record.context = { ...record.context, [role]: context };
          this.keep(record);
          if (record === this.record) this.services.monitor.setContext(record.context);
          if (record === this.record) void this.postSession();
        },
        fileNotes: (notes) => {
          record.fileNotes = notes;
          this.keep(record);
        },
        unseen: (reports) => {
          record.unseen = [...reports];
          this.keep(record);
        },
        draft: (draft) => {
          record.draft = draft;
          this.keep(record);
        },
        busy: (busy) => {
          void this.postSession();
          if (!busy && record === this.record)
            this.notifyIfAway('turnEnd', 'The message has finished.');
        },
        approvals: () => {
          this.postApprovals();
        },
        turnUsage: (identityProvider, _turnUsage, quota) => {
          const provider = providerOf(identityProvider);
          if (provider && quota) this.services.usage.setQuota(provider, quota);
        },
      },
    );
    this.showRoles();
    return this.chat;
  }

  /**
   * Deletes a chat of this folder after the user confirms it: its thread, its
   * nodes' threads and its checkpoints. The chat shown gives way to a new one
   * first; not while it runs. The CLIs keep their own sessions in their history.
   */
  private async deleteChat(id: string): Promise<void> {
    const shown = this.record.id === id;
    const title = shown ? this.record.title : this.history.list().find((c) => c.id === id)?.title;
    if (title === undefined) return;
    if (shown && (this.chat?.busy || [...this.nodes.values()].some((node) => node.busy))) {
      this.notice('warn', 'Stop the current message before deleting the chat.');
      return;
    }
    const answer = await vscode.window.showWarningMessage(
      `Delete chat “${title || 'Untitled'}”?`,
      {
        modal: true,
        detail:
          'This deletes the chat, its node threads, and its checkpoints. Sessions remain in the CLI history.',
      },
      'Delete',
    );
    if (answer !== 'Delete') return;
    if (shown) await this.switchTo(this.emptyRecord());
    this.history.remove(id);
    await this.postSession();
  }

  /** The name a node has until the user gives it an alias: its provider's (ADR 0028). */
  private nodeName(cli: Cli): string {
    return PROVIDERS[cli].name;
  }

  /** A node added on the board (ADR 0023): named after its model, read-only. */
  private async addNode(cli: Cli, model: string): Promise<void> {
    const option = this.services.catalog.find(cli, model);
    const nodes = this.services.roles.nodes();
    const base = this.nodeName(cli);
    const name = nodes.some((n) => n.name === base) ? `${base} ${String(nodes.length + 1)}` : base;
    const added: NodeChoice = {
      id: `n-${Date.now().toString(36)}`,
      name: name.slice(0, NODE_NAME_LENGTH),
      cli,
      model,
      effort: effortFor(option, 'medium'),
      // A new node reads and answers; it writes only once the user says so.
      permission: 'read-only',
    };
    if (!(await this.services.roles.setNodes([...nodes, added]))) void this.postSquad('roles');
  }

  /** A node taken off the board: its session ends and its thread is dropped from the chat. */
  private async removeNode(id: string): Promise<void> {
    const nodes = this.services.roles.nodes();
    await this.services.roles.setNodes(nodes.filter((n) => n.id !== id));
    await this.nodes.get(id)?.close();
    this.nodes.delete(id);
    const threads = this.record.nodes;
    if (threads?.[id]) {
      this.record.nodes = Object.fromEntries(Object.entries(threads).filter(([key]) => key !== id));
      this.keep(this.record);
    }
  }

  /**
   * The user's message to a node of the board (ADR 0023): its session opens
   * on its first message, in the folder the chat's agents use, with the same
   * consent; its updates go to its own thread.
   */
  private async sendToNode(
    id: string,
    text: string,
    skill: string | undefined,
    attachments: readonly string[] | undefined,
  ): Promise<void> {
    if (skill !== undefined) {
      this.notice('warn', 'Message not sent. Nodes do not accept skills.');
      return;
    }
    if (!(await saveBeforeSend(workspaceFolder()))) return;
    const node = await this.ensureNode(id);
    if (!node) return;
    await node.send(text, attachedFiles(attachments));
  }

  /**
   * The composer's +: VS Code's file picker on the open folder; the files it
   * gives that are in the folder go to the composer as attachments (ADR 0026).
   */
  private async pickAttachments(): Promise<void> {
    const cwd = workspaceFolder();
    if (!cwd) return;
    const picked = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: true,
      defaultUri: vscode.Uri.file(cwd),
      openLabel: 'Attach',
    });
    for (const uri of picked ?? []) {
      const relative = path.relative(cwd, uri.fsPath).split(path.sep).join('/');
      if (!insideFolder(cwd, relative)) {
        this.notice('warn', `${uri.fsPath} is outside the agents’ workspace.`);
        continue;
      }
      this.insert(`@${relative} `);
    }
  }

  private async ensureNode(id: string): Promise<NodeSession | undefined> {
    const open = this.nodes.get(id);
    if (open) return open;
    const choice = this.services.roles.nodes().find((n) => n.id === id);
    if (!choice) {
      this.notice('warn', 'This node is no longer on the Squad board.');
      return undefined;
    }
    const cwd = await this.agentsFolder();
    if (!cwd) return undefined;
    let launch;
    try {
      launch = await cliLaunch(this.context, choice.cli);
    } catch (error) {
      this.notice('error', error instanceof Error ? error.message : String(error));
      return undefined;
    }
    const settings = vscode.workspace.getConfiguration('onlyOneChat');
    const record = this.record;
    const args = launch.launcherArgs.length > 0 ? launch.launcherArgs : undefined;
    const node: NodeSession = new NodeSession(
      {
        cwd,
        node: choice,
        codexExecutable: choice.cli === 'codex' ? launch.executable : '',
        claudeExecutable: choice.cli === 'claude' ? launch.executable : '',
        antigravityExecutable: choice.cli === 'antigravity' ? launch.executable : '',
        ...(args && choice.cli === 'codex' ? { codexLauncherArgs: args } : {}),
        ...(args && choice.cli === 'claude' ? { claudeLauncherArgs: args } : {}),
        ...(args && choice.cli === 'antigravity' ? { antigravityLauncherArgs: args } : {}),
        allowedCommands: settings.get<string[]>('allowedCommands') ?? [],
        persistent: true,
        permissionHook: this.permissionHook(),
        ignoredPaths: settings.get<string[]>('ignoredPaths') ?? [],
        ...(record.nodes?.[id]?.session ? { resume: record.nodes[id].session } : {}),
      },
      {
        update: (raw) => {
          if (record !== this.record) return;
          const update = withRefs(raw, cwd);
          this.remember(update, { id, name: choice.name, cli: choice.cli });
          if (update.type === 'permission') {
            this.notifyIfAway('waiting', `${choice.name} requests permission: ${update.summary}`);
          }
          void this.post({ type: 'thread', update, node: id });
        },
        approvals: () => {
          this.postApprovals();
        },
        busy: (busy) => {
          void this.postSession();
          if (!busy && record === this.record) {
            this.notifyIfAway('turnEnd', `${choice.name} finished.`);
          }
          // A node's turn used its provider's quota: read anew, still with no turn (ADR 0023).
          if (!busy && choice.cli === 'antigravity') void this.services.refreshUsage();
        },
        context: (context) => {
          if (record !== this.record) return;
          this.nodeContexts.set(id, context);
          void this.postSession();
        },
        sessionId: (session) => {
          record.nodes ??= {};
          const thread = (record.nodes[id] ??= { updates: [] });
          if (thread.session === session) return;
          thread.session = session;
          this.keep(record);
        },
      },
    );
    this.nodes.set(id, node);
    return node;
  }

  private async closeNodes(): Promise<void> {
    const open = [...this.nodes.values()];
    this.nodes.clear();
    this.nodeContexts.clear();
    await Promise.allSettled(open.map((node) => node.close()));
  }

  /** A CLI's skills for the open folder, read from the CLI the first time (ADR 0019). */
  private async postSkills(cli: Cli, again: boolean): Promise<void> {
    const cwd = workspaceFolder();
    if (!cwd) {
      await this.post({
        type: 'skills',
        cli,
        status: 'unavailable',
        skills: [],
        note: 'No folder open',
      });
      return;
    }
    await this.post({ type: 'skills', cli, status: 'loading', skills: [] });
    const list = await this.services.skills.load(cli, cwd, again);
    await this.post({
      type: 'skills',
      cli,
      status: list.status,
      skills:
        list.status === 'ready'
          ? list.skills.map(({ name, description }) => ({ name, description }))
          : [],
      ...(list.status === 'unavailable' ? { note: list.note } : {}),
    });
  }

  /** The skill a message names, among those of its recipient's CLI. */
  private skillOf(
    to: 'leader' | 'implementer',
    name: string,
  ): { name: string; path?: string } | undefined {
    const cwd = workspaceFolder();
    const cli = (this.chatRoles() ?? this.rolesFor(this.record))[to].cli;
    const found = cwd ? this.services.skills.find(cli, cwd, name) : undefined;
    return found ? { name: found.name, ...(found.path ? { path: found.path } : {}) } : undefined;
  }

  private post(message: HostToWebviewMessage): Thenable<boolean> {
    return this.panel.webview.postMessage(message);
  }

  /** A notification, if its setting is on, while the chat is not in front of the user. */
  private notifyIfAway(kind: 'waiting' | 'turnEnd', text: string): void {
    if (this.panel.active && vscode.window.state.focused) return;
    notifyChat(kind, text, () => {
      this.panel.reveal();
    });
  }

  /** Text for the composer, now or once the webview has loaded. */
  private insert(text: string): void {
    if (this.ready) void this.post({ type: 'insert', text });
    else this.pendingInsert = (this.pendingInsert ?? '') + text;
  }

  /** An update the panel itself adds to the chat shown: kept, and drawn. */
  private emit(update: ThreadUpdate): void {
    this.remember(update);
    void this.post({ type: 'thread', update });
  }

  /** The checkpoints of the chat shown, in the folder open now. */
  private checkpointStore(): CheckpointStore | undefined {
    const cwd = workspaceFolder();
    return cwd
      ? new CheckpointStore(checkpointsRoot(this.context, this.record.id), cwd)
      : undefined;
  }

  /** What the file actions of fileActions.ts need of the chat shown. */
  private fileHost(): FileHost {
    return {
      recordId: this.record.id,
      updates: this.record.updates,
      store: this.checkpointStore(),
      busy: this.chat?.busy ?? false,
      notice: (level, text) => {
        this.notice(level, text);
      },
      emit: (update) => {
        this.emit(update);
      },
      noteFiles: (note) => {
        this.noteFiles(note);
      },
    };
  }

  /** Tells the agents, with their next message, which files the user put back. */
  private noteFiles(note: string): void {
    if (this.chat) {
      this.chat.noteFiles(note);
      return;
    }
    // No agent has started: the note waits in the chat's record, saved with it.
    const notes = this.record.fileNotes;
    this.record.fileNotes = {
      leader: [...(notes?.leader ?? []), note],
      implementer: [...(notes?.implementer ?? []), note],
    };
    this.keep(this.record);
  }

  private dispose(): void {
    clearInterval(this.usageTimer);
    this.saveNow();
    OnlyOneChatPanel.current = undefined;
    void this.chat?.dispose();
    this.chat = undefined;
    void this.closeNodes();
    this.services.monitor.reset();
    OnlyOneChatPanel.rolesEmitter.fire();
    for (const disposable of this.disposables.splice(0)) disposable.dispose();
  }
}
