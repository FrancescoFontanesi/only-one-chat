import * as vscode from 'vscode';
import { createNonce, renderWebviewHtml, type WebviewKind } from './html.js';
import {
  parseWebviewMessage,
  type HostToWebviewMessage,
  type WebviewToHostMessage,
} from './protocol.js';

/**
 * A view of the Only One Chat container (ADR 0012): the same webview bundle
 * and CSP as the chat, rendering one of the side views. Messages from the
 * webview are validated before the subclass sees them.
 */
export abstract class SidebarView implements vscode.WebviewViewProvider, vscode.Disposable {
  protected view: vscode.WebviewView | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    protected readonly context: vscode.ExtensionContext,
    private readonly kind: WebviewKind,
    private readonly title: string,
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
      title: this.title,
      view: this.kind,
    });
    const subscriptions = [
      view.webview.onDidReceiveMessage((raw: unknown) => {
        const message = parseWebviewMessage(raw);
        if (message) void this.onMessage(message);
      }),
      view.onDidChangeVisibility(() => {
        this.onVisibility?.(view.visible);
      }),
    ];
    view.onDidDispose(() => {
      for (const subscription of subscriptions) subscription.dispose();
      this.view = undefined;
      this.onVisibility?.(false);
    });
    this.onVisibility?.(view.visible);
  }

  /** Sends the view its state; nothing while it is closed. */
  protected post(message: HostToWebviewMessage): void {
    void this.view?.webview.postMessage(message);
  }

  /** Subscriptions released with the view provider. */
  protected own(...disposables: vscode.Disposable[]): void {
    this.disposables.push(...disposables);
  }

  protected abstract onMessage(message: WebviewToHostMessage): void | Promise<void>;

  /** Called when the view is shown or hidden: most views have nothing to start or stop. */
  protected onVisibility?(visible: boolean): void;

  dispose(): void {
    for (const disposable of this.disposables.splice(0)) disposable.dispose();
  }
}
