import * as vscode from 'vscode';
import type { ModelCatalog } from '../session/catalog.js';
import { OnlyOneChatPanel, type PanelServices } from '../webview/panel.js';
import { SettingsPanel } from '../webview/settingsPanel.js';

/** Command ids; must match `contributes.commands` in package.json. */
export const CommandId = {
  openPanel: 'onlyOneChat.openPanel',
  openSettings: 'onlyOneChat.openSettings',
  addSelection: 'onlyOneChat.addSelection',
  newChat: 'onlyOneChat.newChat',
  stop: 'onlyOneChat.stop',
  refreshUsage: 'onlyOneChat.refreshUsage',
  refreshModels: 'onlyOneChat.refreshModels',
} as const;

export function registerCommands(
  context: vscode.ExtensionContext,
  services: PanelServices & { readonly catalog: ModelCatalog },
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(CommandId.openPanel, () => {
      OnlyOneChatPanel.show(context, services);
    }),
    vscode.commands.registerCommand(CommandId.openSettings, () => {
      SettingsPanel.show(context, services.roles, services.catalog, OnlyOneChatPanel.chatRoles);
    }),
    vscode.commands.registerCommand(CommandId.newChat, async () => {
      OnlyOneChatPanel.show(context, services);
      await OnlyOneChatPanel.newChat();
    }),
    vscode.commands.registerCommand(CommandId.stop, () => OnlyOneChatPanel.stop()),
    vscode.commands.registerCommand(CommandId.addSelection, () => {
      OnlyOneChatPanel.insertFromEditor(context, services);
    }),
    vscode.commands.registerCommand(CommandId.refreshUsage, () => services.refreshCodexUsage()),
    vscode.commands.registerCommand(CommandId.refreshModels, () => services.catalog.load(true)),
  );
}
