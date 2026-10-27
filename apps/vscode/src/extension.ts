import * as vscode from 'vscode';
import { registerCommands } from './commands/index.js';
import { UsageStore } from './session/usage.js';
import { OnlyOneChatPanel } from './webview/panel.js';
import { UsageViewProvider } from './webview/usageView.js';

/**
 * Value returned by `activate`. Only the integration tests use it; it is not
 * a supported API for other extensions.
 */
export interface OnlyOneChatExports {
  /** Resolves the next time a panel completes the host/webview handshake. */
  whenPanelReady(): Promise<void>;
}

/** The subscriptions shown in the usage view: the CLIs of the configured roles. */
function configuredProviders(): ('codex' | 'claude')[] {
  const settings = vscode.workspace.getConfiguration('onlyOneChat');
  const clis = ['leader', 'implementer'].map((role) =>
    settings.get<string>(`${role}.cli`) === 'claude' ? 'claude' : 'codex',
  );
  return [...new Set(clis)];
}

export function activate(context: vscode.ExtensionContext): OnlyOneChatExports {
  const usage = new UsageStore();
  usage.setProviders(configuredProviders());
  const usageView = new UsageViewProvider(context, usage);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(UsageViewProvider.viewType, usageView),
    {
      dispose: () => {
        usageView.dispose();
      },
    },
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('onlyOneChat')) usage.setProviders(configuredProviders());
    }),
  );
  registerCommands(context, usage, () => usageView.refreshCodex());
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
