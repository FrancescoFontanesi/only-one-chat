import * as vscode from 'vscode';
import { isFake } from '../clis.js';
import type { ChatRoles, RoleSettings } from '../roles.js';
import type { ModelCatalog } from '../session/catalog.js';
import { cliLabel, detectCli, findInFolder } from '../detect.js';
import { settingsSections, writeSetting } from '../settings.js';
import { createNonce, renderWebviewHtml, STYLESHEETS } from './html.js';
import { parseWebviewMessage, type WebviewToHostMessage } from './protocol.js';
import { webviewOptions } from './security-gates.js';

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
      'Only One Chat · Settings',
      vscode.ViewColumn.Active,
      webviewOptions([webviewRoot, mediaRoot]),
    );
    panel.webview.html = renderWebviewHtml({
      cspSource: panel.webview.cspSource,
      nonce: createNonce(),
      scriptUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(webviewRoot, 'main.js')).toString(),
      styleUris: STYLESHEETS.map((file) =>
        panel.webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'cn', file)).toString(),
      ),
      title: 'Settings',
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
      case 'setReviewer': {
        const { cli, model, effort } = message;
        if (!(await this.roles.setReviewer({ cli, model, effort }))) this.show();
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
      case 'detectCli':
      case 'pickCli': {
        const { cli } = message;
        let found: string | undefined;
        if (message.type === 'detectCli') {
          found = await detectCli(cli);
          if (!found) {
            void vscode.window.showWarningMessage(
              `${cliLabel(cli)} was not found. Use SELECT to choose its folder or enter its path.`,
            );
          }
        } else {
          const picked = await vscode.window.showOpenDialog({
            canSelectFolders: true,
            canSelectFiles: false,
            canSelectMany: false,
            openLabel: 'Use This Folder',
            title: `${cliLabel(cli)} Folder`,
          });
          const folder = picked?.[0]?.fsPath;
          if (!folder) break;
          found = await findInFolder(cli, folder);
          if (!found) {
            void vscode.window.showWarningMessage(
              `The ${cliLabel(cli)} executable was not found in ${folder} or its bin subfolder.`,
            );
          }
        }
        if (found) {
          // A path is the user's, never a folder's (machine scope).
          const problem = await writeSetting(this.context, `${cli}Path`, found, 'user');
          if (problem) void vscode.window.showWarningMessage(problem);
          else void vscode.window.showInformationMessage(`${cliLabel(cli)}: ${found}`);
        }
        this.show();
        break;
      }
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
