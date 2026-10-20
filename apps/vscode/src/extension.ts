import * as vscode from 'vscode';
import { registerCommands } from './commands/index.js';
import { OnlyOneChatPanel } from './webview/panel.js';

/**
 * Value returned by `activate`. Only the integration tests use it; it is not
 * a supported API for other extensions.
 */
export interface OnlyOneChatExports {
  /** Resolves the next time a panel completes the host/webview handshake. */
  whenPanelReady(): Promise<void>;
}

export function activate(context: vscode.ExtensionContext): OnlyOneChatExports {
  registerCommands(context);
  return {
    whenPanelReady: () =>
      new Promise<void>((resolve) => {
        const subscription = OnlyOneChatPanel.onDidBecomeReady(() => {
          subscription.dispose();
          resolve();
        });
      }),
  };
}

export function deactivate(): void {
  // Nothing to release yet: all disposables are owned by the extension context.
}
