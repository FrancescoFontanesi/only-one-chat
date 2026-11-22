// Integration smoke test, run inside an isolated Extension Development Host
// by @vscode/test-cli (see .vscode-test.mjs). No account or network AI access.

import * as assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { ChatHistory } from '../../src/session/history.js';
import { VerificationContentProvider } from '../../src/webview/verificationContent.js';
import { TaskContentProvider, taskUri } from '../../src/webview/taskContent.js';
import { CheckpointStore } from '../../src/session/checkpoints.js';
import { checkpointsRoot, CheckpointContentProvider } from '../../src/webview/checkpointContent.js';
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
  it('opens saved task recovery context through a native read-only document', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ooc-task-evidence-'));
    const context = { storageUri: vscode.Uri.file(root) } as vscode.ExtensionContext;
    const history = new ChatHistory(join(root, 'chats'));
    history.save({
      version: 1,
      id: 'chat-task',
      title: 'Task',
      createdAt: 1,
      updatedAt: 1,
      sessions: {},
      updates: [],
      task: {
        version: 1,
        id: 'task-1',
        configuration: '{}',
        checkpoint: null,
        progress: {
          brief: 'Approved synthetic work',
          direct: true,
          step: 'review',
          inFlight: false,
          limit: 2,
          used: 1,
          work: { text: 'Latest committed report', data: null },
          findings: 'R1 remains',
        },
      },
    });
    const provider = new TaskContentProvider(context);
    const scheme = 'ooc-test-task';
    const registration = vscode.workspace.registerTextDocumentContentProvider(scheme, provider);
    try {
      const document = await vscode.workspace.openTextDocument(
        taskUri('chat-task', 'task-1').with({ scheme }),
      );
      assert.match(document.getText(), /Corrections: 1\/2/);
      assert.match(document.getText(), /Latest committed report/);
      assert.match(document.getText(), /R1 remains/);
      assert.notEqual(vscode.workspace.fs.isWritableFileSystem(scheme), true);
      assert.throws(
        () =>
          provider.provideTextDocumentContent(
            vscode.Uri.from({ scheme, path: '/chat-task/../../outside.txt' }),
          ),
        /Invalid task reference/,
      );
    } finally {
      registration.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });
  it('opens persisted verification evidence in a native read-only document', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ooc-evidence-'));
    const context = { storageUri: vscode.Uri.file(root) } as vscode.ExtensionContext;
    const history = new ChatHistory(join(root, 'chats'));
    const reports = new CheckpointStore(checkpointsRoot(context, 'chat-evidence'), root);
    const report = '<testsuite><testcase name="synthetic"/></testsuite>';
    const reportHash = reports.keepArtifact(report);
    history.save({
      version: 1,
      id: 'chat-evidence',
      title: 'Evidence',
      createdAt: 1,
      updatedAt: 1,
      sessions: {},
      updates: [
        {
          type: 'verification',
          evidence: {
            id: 'v-1',
            reportHash,
            origin: 'reviewer',
            status: 'passed',
            comparison: 'confirmed',
            reviewVerdict: 'approved',
            summary: 'Final verification passed',
            detail: 'Synthetic recorded output',
          },
        },
      ],
    });
    const scheme = 'ooc-test-evidence';
    const provider = new VerificationContentProvider(context);
    const registration = vscode.workspace.registerTextDocumentContentProvider(scheme, provider);
    try {
      const document = await vscode.workspace.openTextDocument(
        vscode.Uri.from({
          scheme,
          path: '/chat-evidence/v-1/verification.txt',
        }),
      );
      assert.match(document.getText(), /Red-green: confirmed/);
      assert.match(document.getText(), /Reviewer verdict: approved/);
      assert.notEqual(vscode.workspace.fs.isWritableFileSystem(scheme), true);
      const links = provider.provideDocumentLinks(document);
      assert.equal(links.length, 1);
      assert.ok(links[0]?.target);
      assert.equal(
        new CheckpointContentProvider(context).provideTextDocumentContent(links[0].target),
        report,
      );
      assert.throws(
        () =>
          provider.provideTextDocumentContent(
            vscode.Uri.from({
              scheme,
              path: '/outside/v-1/secret.txt',
            }),
          ),
        /Invalid verification reference/,
      );
    } finally {
      registration.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });
  it('activates and registers its commands', async () => {
    await activate();
    const commands = await vscode.commands.getCommands(true);
    for (const id of [
      OPEN_PANEL,
      'onlyOneChat.openSettings',
      'onlyOneChat.addSelection',
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

  it('serves the recorded contents the diff of a change opens', async () => {
    await activate();
    const document = await vscode.workspace.openTextDocument(
      vscode.Uri.from({ scheme: 'only-one-chat-checkpoint', path: '/chat-x/empty/calc.py' }),
    );
    assert.equal(document.getText(), '');
    assert.equal(document.languageId, 'python');
  });

  it('reuses the existing panel instead of opening a second one', async () => {
    await vscode.commands.executeCommand(OPEN_PANEL);
    assert.equal(panelTabs().length, 1);
  });
});
