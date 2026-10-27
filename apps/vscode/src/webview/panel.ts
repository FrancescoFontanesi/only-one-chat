import { realpathSync } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { resolveClaudeExecutable, resolveCodexExecutable } from '@only-one-chat/adapters';
import { getRuntimeInfo } from '@only-one-chat/runtime';
import { ChatSession, type AgentChoice, type ChatConfig } from '../session/chat.js';
import { providerOf, type UsageStore } from '../session/usage.js';
import { ChatHistory, forReplay, newChatId, type ChatRecord } from '../session/history.js';
import { createNonce, renderWebviewHtml } from './html.js';
import {
  parseWebviewMessage,
  type ApprovalMode,
  type HostToWebviewMessage,
  type SessionInfo,
  type ThreadUpdate,
  type WebviewToHostMessage,
} from './protocol.js';

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

function agentChoice(settings: vscode.WorkspaceConfiguration, role: string): AgentChoice {
  const cli = settings.get<string>(`${role}.cli`);
  const permission = settings.get<string>(`${role}.permission`);
  return {
    cli: cli === 'claude' ? 'claude' : 'codex',
    model: settings.get<string>(`${role}.model`) ?? '',
    effort: settings.get<string>(`${role}.effort`) ?? 'low',
    permission: permission === 'read-only' || permission === 'ask' ? permission : 'auto',
  };
}

/** Single editor panel hosting the chat with the leader. */
export class OnlyOneChatPanel {
  static readonly viewType = 'onlyOneChat.panel';

  private static current: OnlyOneChatPanel | undefined;
  private static readonly readyEmitter = new vscode.EventEmitter<void>();

  /** Fires each time a panel's webview has loaded and received its status. */
  static readonly onDidBecomeReady = OnlyOneChatPanel.readyEmitter.event;

  static show(
    context: vscode.ExtensionContext,
    usage: UsageStore,
    refreshCodexUsage: () => Promise<void>,
  ): void {
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
      usage,
      refreshCodexUsage,
      webviewRoot,
      mediaRoot,
    );
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
    private readonly usage: UsageStore,
    private readonly refreshCodexUsage: () => Promise<void>,
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
    );
  }

  /** Fake CLIs instead of the real ones: development host only, no quota. */
  private get fake(): boolean {
    return (
      this.context.extensionMode === vscode.ExtensionMode.Development &&
      vscode.workspace.getConfiguration('onlyOneChat').get<boolean>('fake') === true
    );
  }

  private sessionInfo(): SessionInfo {
    const settings = vscode.workspace.getConfiguration('onlyOneChat');
    return {
      workspace: workspaceFolder(),
      trusted: vscode.workspace.isTrusted,
      leader: agentChoice(settings, 'leader'),
      implementer: agentChoice(settings, 'implementer'),
      mode: this.mode,
      fake: this.fake,
      busy: this.chat?.busy ?? false,
      chats: this.history.list(),
      chatId: this.record.id,
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
    if (update.type === 'user' && record.title === '') record.title = update.text.slice(0, 60);
    record.updates.push(update);
    record.updatedAt = Date.now();
    this.scheduleSave();
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
    this.usage.resetChat();
    this.record = record;
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
        const chat = await this.ensureChat();
        if (chat) await chat.send(message.text);
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
      case 'setEffort':
        // The user's choice: kept in the settings for the next chats, and applied
        // to this chat's sessions from their next turn.
        await vscode.workspace
          .getConfiguration('onlyOneChat')
          .update(`${message.role}.effort`, message.effort, vscode.ConfigurationTarget.Global);
        this.chat?.setEffort(message.role, message.effort);
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
        await this.refreshCodexUsage();
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
    if (!this.fake && this.confirmedFolder !== cwd) {
      const answer = await vscode.window.showWarningMessage(
        `Gli agenti lavoreranno in ${cwd} e potranno modificarne i file ed eseguire i comandi consentiti. Continuare?`,
        { modal: true },
        'Continua',
      );
      if (answer !== 'Continua') return undefined;
      this.confirmedFolder = cwd;
    }
    const settings = vscode.workspace.getConfiguration('onlyOneChat');
    const leader = agentChoice(settings, 'leader');
    const implementer = agentChoice(settings, 'implementer');
    const uses = (cli: 'codex' | 'claude') => leader.cli === cli || implementer.cli === cli;
    let codexExecutable = '';
    let claudeExecutable = '';
    let fakeArgs: Pick<ChatConfig, 'codexLauncherArgs' | 'claudeLauncherArgs'> = {};
    try {
      if (this.fake) {
        // The adapters' fake CLIs, from the repository: development only.
        const fixtures = path.join(
          this.context.extensionPath,
          '..',
          '..',
          'packages',
          'adapters',
          'test',
          'fixtures',
        );
        codexExecutable = 'node';
        claudeExecutable = 'node';
        fakeArgs = {
          codexLauncherArgs: [path.join(fixtures, 'fake-app-server.mjs'), '--account=chatgpt'],
          claudeLauncherArgs: [path.join(fixtures, 'fake-claude.mjs'), '--echo'],
        };
      } else {
        if (uses('codex')) {
          codexExecutable = await resolveCodexExecutable({
            configuredPath: settings.get<string>('codexPath') ?? '',
          });
        }
        if (uses('claude')) {
          claudeExecutable = await resolveClaudeExecutable({
            configuredPath: settings.get<string>('claudePath') ?? '',
          });
        }
      }
    } catch (error) {
      this.notice('error', error instanceof Error ? error.message : String(error));
      return undefined;
    }
    const logDir = vscode.Uri.joinPath(this.context.globalStorageUri, 'logs').fsPath;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
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
        codexExecutable,
        claudeExecutable,
        ...fakeArgs,
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
        resume: { ...this.record.sessions },
        persistent: true,
        review: settings.get<string>('leaderReview') === 'deferred' ? 'deferred' : 'always',
        logPath: path.join(logDir, `chat-${stamp}.jsonl`),
      },
      {
        update: (update) => {
          this.remember(update);
          void this.post({ type: 'thread', update });
        },
        sessionId: (role, id) => {
          if (this.record.sessions[role] === id) return;
          this.record.sessions[role] = id;
          this.scheduleSave();
        },
        busy: () => {
          void this.postSession();
        },
        turnUsage: (identityProvider, turnUsage, quota) => {
          const provider = providerOf(identityProvider);
          if (!provider) return;
          if (turnUsage) this.usage.addTurn(provider, turnUsage);
          if (quota) this.usage.setQuota(provider, quota);
        },
      },
    );
    return this.chat;
  }

  private post(message: HostToWebviewMessage): Thenable<boolean> {
    return this.panel.webview.postMessage(message);
  }

  private dispose(): void {
    this.saveNow();
    OnlyOneChatPanel.current = undefined;
    void this.chat?.dispose();
    this.chat = undefined;
    for (const disposable of this.disposables.splice(0)) disposable.dispose();
  }
}
