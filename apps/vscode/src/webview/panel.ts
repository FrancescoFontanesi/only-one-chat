import { realpathSync } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { getRuntimeInfo } from '@only-one-chat/runtime';
import { cliLaunch, isFake } from '../clis.js';
import type { RoleSettings, Roles } from '../roles.js';
import { ChatSession } from '../session/chat.js';
import { ChatHistory, forReplay, newChatId, type ChatRecord } from '../session/history.js';
import type { MonitorStore } from '../session/monitor.js';
import { notifyChat } from '../notifications.js';
import { providerOf, type UsageStore } from '../session/usage.js';
import { createNonce, renderWebviewHtml } from './html.js';
import {
  parseWebviewMessage,
  type ApprovalMode,
  type HostToWebviewMessage,
  type SessionInfo,
  type ThreadUpdate,
  type WebviewToHostMessage,
} from './protocol.js';
import type { ChatRoles } from './rolesView.js';

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

/** Shared by the panel and the views it feeds. */
export interface PanelServices {
  readonly usage: UsageStore;
  readonly monitor: MonitorStore;
  readonly roles: RoleSettings;
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
    this.history = new ChatHistory(vscode.Uri.joinPath(storage, 'chats').fsPath);
    // The most recent chat of this folder comes back; otherwise a new one.
    const latest = this.history.list()[0];
    this.record = (latest && this.history.load(latest.id)) ?? this.emptyRecord();
    this.showRoles();
    const webview = panel.webview;
    webview.html = renderWebviewHtml({
      cspSource: webview.cspSource,
      nonce: createNonce(),
      scriptUri: webview.asWebviewUri(vscode.Uri.joinPath(webviewRoot, 'main.js')).toString(),
      styleUri: webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'webview.css')).toString(),
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
    };
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

  /** Redraws the shown chat in the webview, as it was left. */
  private async replay(): Promise<void> {
    await this.post({ type: 'reset' });
    for (const update of forReplay(this.record.updates)) {
      await this.post({ type: 'thread', update });
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
        OnlyOneChatPanel.readyEmitter.fire();
        break;
      case 'ping':
        void this.post({ type: 'pong', id: message.id, receivedAt: new Date().toISOString() });
        break;
      case 'send': {
        if (!(await this.saveBeforeSend())) break;
        const chat = await this.ensureChat();
        if (!chat) break;
        // The composer's recipient and route, written as the commands the chat reads.
        const typed = /^(@impl|\/(fai|delega|chiedi))\b/i.test(message.text);
        const prefix = typed
          ? ''
          : message.to === 'implementer'
            ? '@impl '
            : message.route
              ? `/${message.route} `
              : '';
        await chat.send(`${prefix}${message.text}`);
        break;
      }
      case 'decide':
        this.chat?.decide(message.id, message.action, message.text);
        break;
      case 'permit':
        this.chat?.permit(message.id, message.decision);
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
      case 'refreshUsage':
        await this.services.refreshCodexUsage();
        break;
      case 'openFolder':
        await vscode.commands.executeCommand('workbench.action.files.openFolder');
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
        persistent: true,
        review: settings.get<string>('leaderReview') === 'deferred' ? 'deferred' : 'always',
        instructions: {
          leader: settings.get<string>('leader.instructions') ?? '',
          implementer: settings.get<string>('implementer.instructions') ?? '',
        },
        logPath: path.join(logDir, `chat-${stamp}.jsonl`),
      },
      {
        update: (update) => {
          if (record !== this.record) return;
          this.remember(update);
          this.services.monitor.apply(update);
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
        unseen: (reports) => {
          record.unseen = [...reports];
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
    this.saveNow();
    OnlyOneChatPanel.current = undefined;
    void this.chat?.dispose();
    this.chat = undefined;
    this.services.monitor.reset();
    OnlyOneChatPanel.rolesEmitter.fire();
    for (const disposable of this.disposables.splice(0)) disposable.dispose();
  }
}
