// Claude's PermissionRequest hook as the extension runs it (R9): the script
// shipped in dist/hooks, run by the editor's own Node (ELECTRON_RUN_AS_NODE)
// through the command line the bridge writes in the settings. No Claude, no quota.

import * as assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { startPermissionBridge } from '@only-one-chat/adapters';

const EXTENSION_ID = 'francesco-fontanesi.only-one-chat';

/** Runs the hook command of the bridge's settings in a shell, as Claude does. */
function runHook(command: string, env: Readonly<Record<string, string>>): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      shell: true,
      env: { ...process.env, ...env },
      stdio: 'pipe',
      windowsHide: true,
    });
    let out = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (out += chunk));
    child.on('error', reject);
    child.on('close', () => {
      resolve(out);
    });
    child.stdin.end(
      JSON.stringify({
        hook_event_name: 'PermissionRequest',
        tool_name: 'Bash',
        tool_input: { command: 'python -m pytest' },
      }),
    );
  });
}

describe('Claude permission hook in the editor', () => {
  it('runs with the editor’s Node and returns the user’s decision', async () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension, `${EXTENSION_ID} is not installed in the test host`);
    // The extension host's Node is the editor's own, as in the panel.
    assert.ok(process.versions.electron, 'not running in the editor');
    const asked: string[] = [];
    const bridge = await startPermissionBridge(
      (request) => {
        asked.push(request.summary);
        return Promise.resolve('accept');
      },
      {
        nodeExecutable: process.execPath,
        nodeEnv: { ELECTRON_RUN_AS_NODE: '1' },
        hookScript: path.join(extension.extensionPath, 'dist', 'hooks', 'permission-request.mjs'),
      },
    );
    try {
      const settings = JSON.parse(bridge.settings) as {
        hooks: { PermissionRequest: { hooks: { command: string }[] }[] };
      };
      const command = settings.hooks.PermissionRequest[0]?.hooks[0]?.command;
      assert.ok(command, 'no hook command in the settings');
      const out = await runHook(command, bridge.env);
      const decision = (
        JSON.parse(out) as {
          hookSpecificOutput: { decision: { behavior: string; updatedInput?: unknown } };
        }
      ).hookSpecificOutput.decision;
      assert.deepEqual(asked, ['Bash: python -m pytest']);
      assert.equal(decision.behavior, 'allow');
      assert.deepEqual(decision.updatedInput, { command: 'python -m pytest' });
    } finally {
      await bridge.close();
    }
  });
});
