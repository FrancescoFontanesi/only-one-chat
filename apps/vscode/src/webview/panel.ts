import * as vscode from 'vscode';
import { getRuntimeInfo } from '@only-one-chat/runtime';
import { createNonce, renderWebviewHtml } from './html.js';
import { parseWebviewMessage, type HostToWebviewMessage } from './protocol.js';

const TITLE = 'Only One Chat';

/** Single editor panel hosting the (future) orchestration chat. */
export class OnlyOneChatPanel {
  static readonly viewType = 'onlyOneChat.panel';

  private static current: OnlyOneChatPanel | undefined;
  private static readonly readyEmitter = new vscode.EventEmitter<void>();

  /** Fires each time a panel's webview has loaded and received its status. */
  static readonly onDidBecomeReady = OnlyOneChatPanel.readyEmitter.event;

  static show(context: vscode.ExtensionContext): void {
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
        localResourceRoots: [webviewRoot, mediaRoot],
      },
    );
    OnlyOneChatPanel.current = new OnlyOneChatPanel(panel, context, webviewRoot, mediaRoot);
  }

  private readonly disposables: vscode.Disposable[] = [];

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly context: vscode.ExtensionContext,
    webviewRoot: vscode.Uri,
    mediaRoot: vscode.Uri,
  ) {
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
        this.handleMessage(raw);
      }),
      panel.onDidDispose(() => {
        this.dispose();
      }),
    );
  }

  private handleMessage(raw: unknown): void {
    const message = parseWebviewMessage(raw);
    if (!message) return;
    switch (message.type) {
      case 'ready':
        void this.post({
          type: 'status',
          status: {
            extensionVersion: (this.context.extension.packageJSON as { version: string }).version,
            vscodeVersion: vscode.version,
            runtime: getRuntimeInfo(),
            workspaceTrusted: vscode.workspace.isTrusted,
          },
        }).then(() => {
          OnlyOneChatPanel.readyEmitter.fire();
        });
        break;
      case 'ping':
        void this.post({ type: 'pong', id: message.id, receivedAt: new Date().toISOString() });
        break;
    }
  }

  private post(message: HostToWebviewMessage): Thenable<boolean> {
    return this.panel.webview.postMessage(message);
  }

  private dispose(): void {
    OnlyOneChatPanel.current = undefined;
    for (const disposable of this.disposables.splice(0)) disposable.dispose();
  }
}
