// Integration smoke test, run inside an isolated Extension Development Host
// by @vscode/test-cli (see .vscode-test.mjs). No account or network AI access.

import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import type { OnlyOneChatExports } from '../../src/extension.js';

const EXTENSION_ID = 'francesco-fontanesi.only-one-chat';
const OPEN_PANEL = 'onlyOneChat.openPanel';

async function activate(): Promise<OnlyOneChatExports> {
  const extension = vscode.extensions.getExtension<OnlyOneChatExports>(EXTENSION_ID);
  assert.ok(extension, `${EXTENSION_ID} is not installed in the test host`);
  return extension.activate();
}

function panelTabs(): vscode.Tab[] {
  return vscode.window.tabGroups.all
    .flatMap((group) => group.tabs)
    .filter(
      (tab) =>
        tab.input instanceof vscode.TabInputWebview &&
        tab.input.viewType.endsWith('onlyOneChat.panel'),
    );
}

describe('Only One Chat extension', () => {
  it('activates and registers its commands', async () => {
    await activate();
    const commands = await vscode.commands.getCommands(true);
    for (const id of [
      OPEN_PANEL,
      'onlyOneChat.openSettings',
      'onlyOneChat.newChat',
      'onlyOneChat.stop',
      'onlyOneChat.refreshUsage',
      'onlyOneChat.refreshModels',
    ]) {
      assert.ok(commands.includes(id), `${id} is not registered`);
    }
  });

  it('opens the panel and completes the host/webview handshake', async () => {
    const api = await activate();
    const ready = api.whenPanelReady();
    await vscode.commands.executeCommand(OPEN_PANEL);
    await ready;
    assert.equal(panelTabs().length, 1);
  });

  it('opens the settings page in its own tab', async () => {
    await vscode.commands.executeCommand('onlyOneChat.openSettings');
    const settingsTabs = () =>
      vscode.window.tabGroups.all
        .flatMap((group) => group.tabs)
        .filter(
          (tab) =>
            tab.input instanceof vscode.TabInputWebview &&
            tab.input.viewType.endsWith('onlyOneChat.settings'),
        );
    // The tab model follows the new panel shortly after.
    for (let i = 0; i < 50 && settingsTabs().length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(settingsTabs().length, 1);
  });

  it('reuses the existing panel instead of opening a second one', async () => {
    await vscode.commands.executeCommand(OPEN_PANEL);
    assert.equal(panelTabs().length, 1);
  });
});
