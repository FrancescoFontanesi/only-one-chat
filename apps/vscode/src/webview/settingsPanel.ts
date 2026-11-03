import * as vscode from 'vscode';
import { isFake } from '../clis.js';
import type { ChatRoles, RoleSettings } from '../roles.js';
import type { ModelCatalog } from '../session/catalog.js';
import { settingsSections, writeSetting } from '../settings.js';
import { createNonce, renderWebviewHtml, STYLESHEETS } from './html.js';
import { parseWebviewMessage, type WebviewToHostMessage } from './protocol.js';

const EXTENSION_ID = 'francesco-fontanesi.only-one-chat';

/**
 * The settings page (ADR 0013), in an editor tab: the extension's settings,
 * grouped and readable, written back to VS Code's own settings.
 */
export class SettingsPanel {
  static readonly viewType = 'onlyOneChat.settings';
  private static current: SettingsPanel | undefined;

  static show(
    context: vscode.ExtensionContext,
    roles: RoleSettings,
    catalog: ModelCatalog,
    chat: ChatRoles,
  ): void {
    if (SettingsPanel.current) {
      SettingsPanel.current.panel.reveal();
      return;
    }
    const webviewRoot = vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview');
    const mediaRoot = vscode.Uri.joinPath(context.extensionUri, 'media');
    const panel = vscode.window.createWebviewPanel(
      SettingsPanel.viewType,
      'Only One Chat · Impostazioni',
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        enableForms: false,
        enableCommandUris: false,
        localResourceRoots: [webviewRoot, mediaRoot],
      },
    );
    panel.webview.html = renderWebviewHtml({
      cspSource: panel.webview.cspSource,
      nonce: createNonce(),
      scriptUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(webviewRoot, 'main.js')).toString(),
      styleUris: STYLESHEETS.map((file) =>
        panel.webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'cn', file)).toString(),
      ),
      title: 'Impostazioni',
      view: 'settings',
    });
    SettingsPanel.current = new SettingsPanel(panel, context, roles, catalog, chat);
  }

  private readonly disposables: vscode.Disposable[] = [];

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly context: vscode.ExtensionContext,
    private readonly roles: RoleSettings,
    private readonly catalog: ModelCatalog,
    private readonly chat: ChatRoles,
  ) {
    this.disposables.push(
      panel.webview.onDidReceiveMessage((raw: unknown) => {
        const message = parseWebviewMessage(raw);
        if (message) void this.onMessage(message);
      }),
      panel.onDidDispose(() => {
        SettingsPanel.current = undefined;
        for (const disposable of this.disposables.splice(0)) disposable.dispose();
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('onlyOneChat')) this.show();
      }),
      roles.onDidChange(() => {
        this.show();
      }),
      chat.onDidChange(() => {
        this.show();
      }),
    );
  }

  private async onMessage(message: WebviewToHostMessage): Promise<void> {
    switch (message.type) {
      case 'ready':
        this.show();
        await this.catalog.load();
        break;
      case 'refreshModels':
        await this.catalog.load(true);
        break;
      case 'setRole': {
        const { role, cli, model, effort, permission } = message;
        if (!(await this.roles.choose(role, { cli, model, effort, permission }))) this.show();
        break;
      }
      case 'setSetting': {
        const problem = await writeSetting(
          this.context,
          message.key,
          message.value,
          message.target,
        );
        if (problem) {
          void vscode.window.showWarningMessage(problem);
          this.show();
        }
        break;
      }
      case 'showChat':
        await vscode.commands.executeCommand('onlyOneChat.openPanel');
        break;
      case 'openNativeSettings':
        await vscode.commands.executeCommand(
          'workbench.action.openSettings',
          `@ext:${EXTENSION_ID}`,
        );
        break;
      default:
        break;
    }
  }

  private show(): void {
    void this.panel.webview.postMessage({
      type: 'settings',
      settings: {
        roles: this.roles.state(this.chat.current(), isFake(this.context)),
        sections: settingsSections(this.context),
        hasWorkspace: (vscode.workspace.workspaceFolders?.length ?? 0) > 0,
      },
    });
  }
}
