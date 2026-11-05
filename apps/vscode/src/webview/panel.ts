import { realpathSync, rmSync } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { getRuntimeInfo } from '@only-one-chat/runtime';
import { cliLaunch, isFake } from '../clis.js';
import type { ChatRoles, RoleSettings, Roles } from '../roles.js';
import { ChatSession } from '../session/chat.js';
import { CheckpointStore } from '../session/checkpoints.js';
import { SKIPPED } from '../session/facts.js';
import { expandMentions, inside, withRefs } from '../session/mentions.js';
import { ChatHistory, forReplay, newChatId, type ChatRecord } from '../session/history.js';
import { checkpointUri, checkpointsRoot } from './checkpointContent.js';
import type { ModelCatalog } from '../session/catalog.js';
import type { SkillCatalog } from '../session/skills.js';
import type { MonitorStore } from '../session/monitor.js';
import { notifyChat } from '../notifications.js';
import { providerOf, type UsageStore } from '../session/usage.js';
import { createNonce, renderWebviewHtml, STYLESHEETS } from './html.js';
import {
  parseWebviewMessage,
  type ApprovalMode,
  type HostToWebviewMessage,
  type SessionInfo,
  type ThreadUpdate,
  type WebviewToHostMessage,
} from './protocol.js';
import { CODEX_INTERVAL_MS } from '../usageReader.js';

const TITLE = 'Only One Chat';

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
  readonly refreshCodexUsage: () => Promise<void>;
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

  /** Stops what the chat is running (command palette). */
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
      void vscode.window.showWarningMessage(
        'Il file non è nella cartella in cui lavorano gli agenti.',
      );
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
      {
        enableScripts: true,
        enableForms: false,
        enableCommandUris: false,
        retainContextWhenHidden: true,
        localResourceRoots: [webviewRoot, mediaRoot],
      },
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
        if (message) void this.handleMessage(message);
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
    const chat = this.chat;
    if (chat) {
      const next = this.services.roles.get();
      for (const role of ['leader', 'implementer'] as const) chat.setRole(role, next[role]);
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
      workspace: workspaceFolder(),
      trusted: vscode.workspace.isTrusted,
      leader: this.services.roles.info(roles.leader),
      implementer: this.services.roles.info(roles.implementer),
      mode: this.mode,
      fake: isFake(this.context),
      busy: this.chat?.busy ?? false,
      title: this.record.title,
      chats: this.history.list(),
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
      ? setInterval(() => void this.services.refreshCodexUsage(), CODEX_INTERVAL_MS)
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

  /** Keeps an update of the shown chat; written to disk shortly after (R5). */
  private remember(update: ThreadUpdate): void {
    const record = this.record;
    if (update.type === 'user' && record.title === '') {
      record.title = update.text.replace(/^(@impl|\/(fai|delega|chiedi))\b\s*/i, '').slice(0, 60);
      void this.postSession();
    }
    record.updates.push(update);
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
      if (record.updates.length > 0) this.history.save(record);
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
    if (this.record.updates.length === 0) return;
    try {
      this.history.save(this.record);
    } catch (error) {
      this.notice(
        'warn',
        `La chat non è stata salvata: ${error instanceof Error ? error.message : String(error)}`,
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
    for (const update of updates) {
      await this.post({ type: 'thread', update });
    }
    if (draft && !updates.some((u) => u.type === 'approval' && u.id === draft.id)) {
      const cwd = workspaceFolder();
      const card: ThreadUpdate = { type: 'approval', kind: 'delegation', ...draft };
      await this.post({ type: 'thread', update: cwd ? withRefs(card, cwd) : card });
    }
  }

  /** Shows another chat: the current one is saved and its agents closed. */
  private async switchTo(record: ChatRecord): Promise<void> {
    this.saveNow();
    await this.chat?.dispose();
    this.chat = undefined;
    this.services.monitor.reset();
    this.record = record;
    this.showRoles();
    await this.replay();
    void this.postSession();
  }

  private postSession(): Thenable<boolean> {
    return this.post({ type: 'session', session: this.sessionInfo() });
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
        OnlyOneChatPanel.readyEmitter.fire();
        // The models and Codex's usage windows are read when the chat opens: no turn, no quota.
        void this.services.catalog.load();
        void this.services.refreshCodexUsage();
        this.watchUsage();
        break;
      case 'ping':
        void this.post({ type: 'pong', id: message.id, receivedAt: new Date().toISOString() });
        break;
      case 'send': {
        if (!(await this.saveBeforeSend())) break;
        const chat = await this.ensureChat();
        if (!chat) break;
        // `@` is for files only: the recipient comes from the composer's control.
        const to = message.to ?? 'leader';
        // A skill named with `$` must be one the recipient's CLI listed for this folder.
        const skill = message.skill !== undefined ? this.skillOf(to, message.skill) : undefined;
        if (message.skill !== undefined && !skill) {
          this.notice(
            'warn',
            `La skill ${message.skill} non è tra quelle del destinatario: messaggio non inviato.`,
          );
          break;
        }
        // Files named with `@` reach the agents as paths (ADR 0015).
        const cwd = workspaceFolder();
        const expanded = cwd ? expandMentions(message.text, cwd) : undefined;
        await chat.send(
          message.text,
          expanded && expanded.mentions.length > 0
            ? {
                text: expanded.attachments,
                paths: expanded.mentions.map(
                  (m) =>
                    `${m.path}${m.lines ? `#L${String(m.lines.from)}-${String(m.lines.to)}` : ''}`,
                ),
              }
            : undefined,
          to,
          skill,
        );
        break;
      }
      case 'decide': {
        // A delegation kept with a reopened chat starts the chat's agents (ADR 0018).
        const chat =
          this.chat ?? (this.record.draft?.id === message.id ? await this.ensureChat() : undefined);
        chat?.decide(message.id, message.action, message.text);
        break;
      }
      case 'openFile':
        await this.openFile(message.path, message.from, message.to);
        break;
      case 'permit':
        this.chat?.permit(message.id, message.decision);
        break;
      case 'answer':
        this.chat?.answer(message.id, message.answers);
        break;
      case 'stop':
        await this.chat?.stop();
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
      case 'setRole': {
        const { role, cli, model, effort, permission } = message;
        if (!(await this.services.roles.choose(role, { cli, model, effort, permission }))) {
          void this.postSquad('roles');
        }
        break;
      }
      case 'refreshModels':
        await this.services.catalog.load(true);
        break;
      case 'refreshUsage':
        await this.services.refreshCodexUsage();
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
        await this.reviewFile(message.id, message.path, message.action);
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
          this.notice('info', 'La chat non è ancora partita: l’implementatore parte già da zero.');
        break;
      case 'restoreCheckpoint':
        await this.restoreCheckpoint(message.checkpoint);
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
    const cwd = workspaceFolder();
    if (!cwd) {
      this.notice('error', 'Apri la cartella in cui gli agenti devono lavorare.');
      return undefined;
    }
    if (!vscode.workspace.isTrusted) {
      this.notice(
        'error',
        'La cartella non è attendibile (Workspace Trust): gli agenti non partono.',
      );
      return undefined;
    }
    const fake = isFake(this.context);
    if (!fake && this.confirmedFolder !== cwd) {
      const answer = await vscode.window.showWarningMessage(
        `Gli agenti lavoreranno in ${cwd} e potranno modificarne i file ed eseguire i comandi consentiti. Continuare?`,
        { modal: true },
        'Continua',
      );
      if (answer !== 'Continua') return undefined;
      this.confirmedFolder = cwd;
    }
    const settings = vscode.workspace.getConfiguration('onlyOneChat');
    // The chat's own record: a turn that ends after a switch must not write into another chat.
    const record = this.record;
    const { leader, implementer } = this.rolesFor(record);
    const uses = (cli: 'codex' | 'claude') => leader.cli === cli || implementer.cli === cli;
    let codex = { executable: '', launcherArgs: [] as readonly string[] };
    let claude = { executable: '', launcherArgs: [] as readonly string[] };
    try {
      if (uses('codex')) codex = await cliLaunch(this.context, 'codex');
      if (uses('claude')) claude = await cliLaunch(this.context, 'claude');
    } catch (error) {
      this.notice('error', error instanceof Error ? error.message : String(error));
      return undefined;
    }
    const logDir = vscode.Uri.joinPath(this.context.globalStorageUri, 'logs').fsPath;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    record.roles = { leader, implementer };
    this.chat = new ChatSession(
      {
        cwd,
        leader,
        implementer,
        subagents: {
          codex: {
            model: settings.get<string>('subagents.codexModel') ?? 'gpt-6-luna',
            effort: settings.get<string>('subagents.effort') ?? 'low',
          },
          claude: {
            model: settings.get<string>('subagents.claudeModel') ?? 'claude-haiku-5-5',
            effort: settings.get<string>('subagents.effort') ?? 'low',
          },
        },
        codexExecutable: codex.executable,
        claudeExecutable: claude.executable,
        ...(codex.launcherArgs.length > 0 ? { codexLauncherArgs: codex.launcherArgs } : {}),
        ...(claude.launcherArgs.length > 0 ? { claudeLauncherArgs: claude.launcherArgs } : {}),
        allowedCommands: settings.get<string[]>('allowedCommands') ?? [],
        verifyCommand: settings.get<string[]>('verifyCommand') ?? [],
        // The editor's own Node runs the PermissionRequest hook script (R9).
        permissionHook: {
          nodeExecutable: process.execPath,
          nodeEnv: { ELECTRON_RUN_AS_NODE: '1' },
          hookScript: path.join(
            this.context.extensionPath,
            'dist',
            'hooks',
            'permission-request.mjs',
          ),
        },
        mode: this.mode,
        // A reopened chat continues the CLIs' own sessions; Codex keeps its threads.
        resume: { ...record.sessions },
        unseen: record.unseen ?? [],
        ...(record.draft ? { draft: record.draft } : {}),
        checkpoints: new CheckpointStore(checkpointsRoot(this.context, record.id), cwd),
        fileNotes: record.fileNotes ?? {},
        persistent: true,
        review: settings.get<string>('leaderReview') === 'deferred' ? 'deferred' : 'always',
        instructions: {
          leader: settings.get<string>('leader.instructions') ?? '',
          implementer: settings.get<string>('implementer.instructions') ?? '',
        },
        logPath: path.join(logDir, `chat-${stamp}.jsonl`),
      },
      {
        update: (raw) => {
          if (record !== this.record) return;
          // The paths its text names, for the thread's links (ADR 0018).
          const update = withRefs(raw, cwd);
          this.remember(update);
          this.services.monitor.apply(update);
          if (update.type === 'question') {
            this.notifyIfAway('waiting', 'Il leader ti fa una domanda.');
          }
          if (update.type === 'permission' || update.type === 'approval') {
            this.notifyIfAway(
              'waiting',
              update.type === 'permission'
                ? `${update.role === 'leader' ? 'Il leader' : 'L’implementatore'} chiede il permesso: ${update.summary}`
                : 'Un messaggio fra gli agenti aspetta la tua approvazione.',
            );
          }
          void this.post({ type: 'thread', update });
        },
        sessionId: (role, id) => {
          if (record.sessions[role] === id) return;
          record.sessions[role] = id;
          this.keep(record);
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
            this.notifyIfAway('turnEnd', 'Il messaggio è concluso.');
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

  /** A CLI's skills for the open folder, read from the CLI the first time (ADR 0019). */
  private async postSkills(cli: 'codex' | 'claude', again: boolean): Promise<void> {
    const cwd = workspaceFolder();
    if (!cwd) {
      await this.post({
        type: 'skills',
        cli,
        status: 'unavailable',
        skills: [],
        note: 'Nessuna cartella aperta',
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

  /**
   * The agents read and change the files on disk: the folder's unsaved files
   * are saved first, or not, as onlyOneChat.saveBeforeSend says. False: the
   * user cancelled the message.
   */
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

  /**
   * A path the thread links (ADR 0018), at its lines: only inside the folder,
   * after its links are resolved; a folder is shown in the explorer.
   */
  private async openFile(file: string, from?: number, to?: number): Promise<void> {
    const cwd = workspaceFolder();
    const found = cwd ? inside(cwd, file.replace(/\/+$/, '')) : undefined;
    if (!found) {
      this.notice('warn', `${file} non è un percorso della cartella aperta.`);
      return;
    }
    const uri = vscode.Uri.file(found.full);
    if (found.folder) {
      await vscode.commands.executeCommand('revealInExplorer', uri);
      return;
    }
    const start = from !== undefined ? from - 1 : undefined;
    const end = to !== undefined ? to - 1 : start;
    await vscode.window.showTextDocument(uri, {
      preview: true,
      ...(start !== undefined && end !== undefined
        ? { selection: new vscode.Range(start, 0, end, Number.MAX_SAFE_INTEGER) }
        : {}),
    });
  }

  /**
   * A file of a changes card (ADR 0014). The file is looked up in the card the
   * chat recorded: the webview names it, but only a recorded path is touched.
   */
  private async reviewFile(
    id: string,
    file: string,
    action: 'diff' | 'accept' | 'reject',
  ): Promise<void> {
    const card = this.record.updates.find(
      (u): u is Extract<ThreadUpdate, { type: 'changes' }> => u.type === 'changes' && u.id === id,
    );
    const change = card?.files.find((f) => f.path === file);
    const store = this.checkpointStore();
    if (!change || !store) return;
    if (action === 'diff') {
      await vscode.commands.executeCommand(
        'vscode.diff',
        checkpointUri(this.record.id, change.before, change.path),
        checkpointUri(this.record.id, change.after, change.path),
        `${change.path} · prima ↔ dopo il messaggio`,
        { preview: true },
      );
      return;
    }
    if (action === 'accept') {
      this.emit({ type: 'change_decided', id, path: file, decision: 'accepted' });
      return;
    }
    if (this.chat?.busy) {
      this.notice('warn', 'Un messaggio è in corso: rifiuta il file quando è concluso.');
      return;
    }
    try {
      if (store.current(change.path) !== change.after) {
        const answer = await vscode.window.showWarningMessage(
          `${change.path} è cambiato ancora dopo il messaggio. Rimetterlo com’era prima del messaggio, perdendo anche quei cambiamenti?`,
          { modal: true },
          'Rimetti com’era',
        );
        if (!answer) return;
      }
      store.put(change.path, change.before);
    } catch (error) {
      this.notice(
        'error',
        `Il file non è stato rimesso: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }
    this.emit({ type: 'change_decided', id, path: file, decision: 'rejected' });
    this.noteFiles(
      `${change.path}: ${change.kind === 'added' ? 'tolto (era nuovo)' : 'rimesso com’era prima del messaggio'}`,
    );
  }

  /** Brings the folder back to before a message; the conversation stays as it is. */
  private async restoreCheckpoint(id: string): Promise<void> {
    const store = this.checkpointStore();
    const checkpoint = store?.load(id);
    if (!store || !checkpoint) {
      this.notice('error', 'Il checkpoint di questo messaggio non c’è più.');
      return;
    }
    if (this.chat?.busy) {
      this.notice('warn', 'Un messaggio è in corso: ripristina quando è concluso.');
      return;
    }
    const answer = await vscode.window.showWarningMessage(
      'Riportare i file della cartella a com’erano prima di questo messaggio? Ciò che è cambiato dopo, anche a mano, si perde. La conversazione resta com’è; i comandi eseguiti fuori dalla cartella non si annullano.',
      { modal: true },
      'Ripristina',
    );
    if (!answer) return;
    let paths: string[];
    try {
      paths = store.restore(checkpoint);
    } catch (error) {
      this.notice(
        'error',
        `Ripristino non riuscito: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }
    this.emit({
      type: 'notice',
      level: 'info',
      text:
        paths.length === 0
          ? 'Ripristino: la cartella era già com’era prima di quel messaggio.'
          : ['Cartella riportata a prima del messaggio:', ...paths.map((p) => `- ${p}`)].join('\n'),
    });
    if (paths.length > 0) {
      this.noteFiles(
        `la cartella è tornata a prima di un messaggio precedente (${paths.join(', ')})`,
      );
    }
  }

  private async saveBeforeSend(): Promise<boolean> {
    const cwd = workspaceFolder();
    if (!cwd) return true;
    const policy = vscode.workspace.getConfiguration('onlyOneChat').get<string>('saveBeforeSend');
    if (policy === 'never') return true;
    const inside = (file: string) => {
      const relative = path.relative(cwd, file);
      return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
    };
    const dirty = vscode.workspace.textDocuments.filter(
      (document) =>
        document.isDirty && document.uri.scheme === 'file' && inside(document.uri.fsPath),
    );
    if (dirty.length === 0) return true;
    if (policy !== 'always') {
      const answer = await vscode.window.showWarningMessage(
        `${String(dirty.length)} file della cartella non sono salvati: gli agenti vedono i file su disco.`,
        { modal: true },
        'Salva e invia',
        'Invia senza salvare',
      );
      if (answer === undefined) return false;
      if (answer === 'Invia senza salvare') return true;
    }
    await Promise.all(dirty.map((document) => document.save()));
    return true;
  }

  private dispose(): void {
    clearInterval(this.usageTimer);
    this.saveNow();
    OnlyOneChatPanel.current = undefined;
    void this.chat?.dispose();
    this.chat = undefined;
    this.services.monitor.reset();
    OnlyOneChatPanel.rolesEmitter.fire();
    for (const disposable of this.disposables.splice(0)) disposable.dispose();
  }
}
