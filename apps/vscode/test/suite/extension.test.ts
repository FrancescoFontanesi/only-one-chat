// Integration smoke test, run inside an isolated Extension Development Host
// by @vscode/test-cli (see .vscode-test.mjs). No account or network AI access.

import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import type { AgentWorkspaceExports } from '../../src/extension.js';

const EXTENSION_ID = 'ffontanesi.agent-workspace';
const OPEN_PANEL = 'agentWorkspace.openPanel';

async function activate(): Promise<AgentWorkspaceExports> {
  const extension = vscode.extensions.getExtension<AgentWorkspaceExports>(EXTENSION_ID);
  assert.ok(extension, `${EXTENSION_ID} is not installed in the test host`);
  return extension.activate();
}

function panelTabs(): vscode.Tab[] {
  return vscode.window.tabGroups.all
    .flatMap((group) => group.tabs)
    .filter(
      (tab) =>
        tab.input instanceof vscode.TabInputWebview &&
        tab.input.viewType.endsWith('agentWorkspace.panel'),
    );
}

describe('Agent Workspace extension', () => {
  it('activates and registers its commands', async () => {
    await activate();
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes(OPEN_PANEL), `${OPEN_PANEL} is not registered`);
  });

  it('opens the panel and completes the host/webview handshake', async () => {
    const api = await activate();
    const ready = api.whenPanelReady();
    await vscode.commands.executeCommand(OPEN_PANEL);
    await ready;
    assert.equal(panelTabs().length, 1);
  });

  it('reuses the existing panel instead of opening a second one', async () => {
    await vscode.commands.executeCommand(OPEN_PANEL);
    assert.equal(panelTabs().length, 1);
  });
});
