import * as vscode from 'vscode';
import type { UsageStore } from '../session/usage.js';
import { OnlyOneChatPanel } from '../webview/panel.js';

/** Command ids; must match `contributes.commands` in package.json. */
export const CommandId = {
  openPanel: 'onlyOneChat.openPanel',
} as const;

export function registerCommands(
  context: vscode.ExtensionContext,
  usage: UsageStore,
  refreshCodexUsage: () => Promise<void>,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(CommandId.openPanel, () => {
      OnlyOneChatPanel.show(context, usage, refreshCodexUsage);
    }),
  );
}
