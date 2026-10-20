import * as vscode from 'vscode';
import { AgentWorkspacePanel } from '../webview/panel.js';

/** Command ids; must match `contributes.commands` in package.json. */
export const CommandId = {
  openPanel: 'agentWorkspace.openPanel',
} as const;

export function registerCommands(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(CommandId.openPanel, () => {
      AgentWorkspacePanel.show(context);
    }),
  );
}
