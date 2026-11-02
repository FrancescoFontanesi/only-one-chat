import * as os from 'node:os';
import * as vscode from 'vscode';
import { checkClaudeBilling, listClaudeModels, listCodexModels } from '@only-one-chat/adapters';
import { cliLaunch } from './clis.js';
import { registerCommands } from './commands/index.js';
import { RoleSettings } from './roles.js';
import { ModelCatalog } from './session/catalog.js';
import { MonitorStore } from './session/monitor.js';
import { UsageStore } from './session/usage.js';
import { usageWarnings } from './notifications.js';
import { CheckpointContentProvider, CHECKPOINT_SCHEME } from './webview/checkpointContent.js';
import { MonitorViewProvider } from './webview/monitorView.js';
import { OnlyOneChatPanel } from './webview/panel.js';
import { RolesViewProvider } from './webview/rolesView.js';
import { UsageViewProvider } from './webview/usageView.js';

/**
 * Value returned by `activate`. Only the integration tests use it; it is not
 * a supported API for other extensions.
 */
export interface OnlyOneChatExports {
  /** Resolves the next time a panel completes the host/webview handshake. */
  whenPanelReady(): Promise<void>;
}

export function activate(context: vscode.ExtensionContext): OnlyOneChatExports {
  const usage = new UsageStore();
  usage.setProviders(['codex', 'claude']);
  const monitor = new MonitorStore();
  // The models are read from the CLIs themselves: no model turn, no quota.
  // Claude starts in a temporary folder, away from the project's own settings.
  const catalog = new ModelCatalog({
    codex: async () => {
      const launch = await cliLaunch(context, 'codex');
      return listCodexModels(launch);
    },
    claude: async () => {
      const launch = await cliLaunch(context, 'claude');
      // Signed in with a subscription, as before a turn: `claude auth status`, no quota.
      await checkClaudeBilling({ ...launch, cwd: os.tmpdir(), prompt: '' });
      return listClaudeModels({ ...launch, cwd: os.tmpdir() });
    },
  });
  const roles = new RoleSettings(catalog);
  const usageView = new UsageViewProvider(context, usage);
  const monitorView = new MonitorViewProvider(context, monitor);
  const rolesView = new RolesViewProvider(context, roles, catalog, OnlyOneChatPanel.chatRoles);
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(
      CHECKPOINT_SCHEME,
      new CheckpointContentProvider(context),
    ),
  );
  context.subscriptions.push(
    roles,
    usageView,
    monitorView,
    rolesView,
    vscode.window.registerWebviewViewProvider(RolesViewProvider.viewType, rolesView),
    vscode.window.registerWebviewViewProvider(MonitorViewProvider.viewType, monitorView),
    vscode.window.registerWebviewViewProvider(UsageViewProvider.viewType, usageView),
  );
  const services = {
    usage,
    monitor,
    roles,
    catalog,
    refreshCodexUsage: () => usageView.refreshCodex(),
  };
  registerCommands(context, services);
  context.subscriptions.push(
    usageWarnings(usage, () => {
      OnlyOneChatPanel.show(context, services);
    }),
  );
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
