import * as path from 'node:path';
import * as vscode from 'vscode';
import { resolveCodexExecutable } from '@only-one-chat/adapters';
import { readCodexQuota, type UsageStore } from '../session/usage.js';
import { createNonce, renderWebviewHtml } from './html.js';
import { parseWebviewMessage, type HostToWebviewMessage } from './protocol.js';

/** How often Codex's usage windows are read while the view is visible. */
const CODEX_INTERVAL_MS = 120_000;

/** The usage view (ADR 0011): the subscriptions in use, in its own small panel. */
export class UsageViewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = 'onlyOneChat.usage';

  private view: vscode.WebviewView | undefined;
  private timer: NodeJS.Timeout | undefined;
  private reading = false;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly usage: UsageStore,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const webviewRoot = vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview');
    const mediaRoot = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    view.webview.options = {
      enableScripts: true,
      enableForms: false,
      enableCommandUris: false,
      localResourceRoots: [webviewRoot, mediaRoot],
    };
    view.webview.html = renderWebviewHtml({
      cspSource: view.webview.cspSource,
      nonce: createNonce(),
      scriptUri: view.webview.asWebviewUri(vscode.Uri.joinPath(webviewRoot, 'main.js')).toString(),
      styleUri: view.webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'webview.css')).toString(),
      title: 'Utilizzo',
      view: 'usage',
    });
    const unsubscribe = this.usage.onChange(() => {
      void this.post();
    });
    view.webview.onDidReceiveMessage((raw: unknown) => {
      const message = parseWebviewMessage(raw);
      if (message?.type === 'ready') {
        void this.post();
        void this.refreshCodex();
      } else if (message?.type === 'refreshUsage') {
        void this.refreshCodex();
      }
    });
    view.onDidChangeVisibility(() => {
      this.schedule();
    });
    view.onDidDispose(() => {
      unsubscribe();
      this.view = undefined;
      this.schedule();
    });
    this.schedule();
  }

  /** Codex is read on a timer only while the view is visible. */
  private schedule(): void {
    clearInterval(this.timer);
    this.timer = undefined;
    if (this.view?.visible) {
      this.timer = setInterval(() => void this.refreshCodex(), CODEX_INTERVAL_MS);
    }
  }

  /** Reads Codex's usage windows: no model turn, no quota. */
  async refreshCodex(): Promise<void> {
    const shown = this.usage.snapshot().some((p) => p.provider === 'codex');
    if (!shown || this.reading) return;
    this.reading = true;
    try {
      const settings = vscode.workspace.getConfiguration('onlyOneChat');
      const fake =
        this.context.extensionMode === vscode.ExtensionMode.Development &&
        settings.get<boolean>('fake') === true;
      const quota = fake
        ? await readCodexQuota('node', [
            path.join(
              this.context.extensionPath,
              '..',
              '..',
              'packages',
              'adapters',
              'test',
              'fixtures',
              'fake-app-server.mjs',
            ),
            '--account=chatgpt',
          ])
        : await readCodexQuota(
            await resolveCodexExecutable({
              configuredPath: settings.get<string>('codexPath') ?? '',
            }),
          );
      if (quota) this.usage.setQuota('codex', quota);
      else this.usage.setNote('codex', 'Codex non ha riportato limiti di utilizzo.');
    } catch (error) {
      this.usage.setNote(
        'codex',
        `Lettura non riuscita: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.reading = false;
    }
  }

  private post(): Thenable<boolean> | undefined {
    const message: HostToWebviewMessage = { type: 'usage', providers: this.usage.snapshot() };
    return this.view?.webview.postMessage(message);
  }

  dispose(): void {
    clearInterval(this.timer);
  }
}
