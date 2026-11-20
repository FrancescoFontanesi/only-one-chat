// The handoff server (ADR 0035) as the extension launches it: the bundle shipped in
// dist, run by the editor's own Node (ELECTRON_RUN_AS_NODE), as the CLIs start it.
// It answers `initialize` and lists the tools it was given. No CLI, no quota.

import * as assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import * as path from 'node:path';
import { handoffTools } from '@only-one-chat/runtime';
import * as vscode from 'vscode';

const EXTENSION_ID = 'francesco-fontanesi.only-one-chat';

describe('Handoff server in the editor', () => {
  it('starts with the editor’s Node and answers initialize and tools/list', async () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension, `${EXTENSION_ID} is not installed in the test host`);
    assert.ok(process.versions.electron, 'not running in the editor');
    const tools = handoffTools('implementer', { command: process.execPath, args: [] }).tools;
    const child = spawn(
      process.execPath,
      [path.join(extension.extensionPath, 'dist', 'handoff-server.js')],
      {
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: '1',
          OOC_HANDOFF_TOOLS: JSON.stringify(tools),
        },
        stdio: ['pipe', 'pipe', 'inherit'],
        windowsHide: true,
      },
    );
    const replies: { id: number; result: Record<string, unknown> }[] = [];
    const answered = new Promise<void>((resolve, reject) => {
      createInterface({ input: child.stdout }).on('line', (line) => {
        replies.push(JSON.parse(line) as (typeof replies)[number]);
        if (replies.length === 4) resolve();
      });
      child.on('error', reject);
      child.on('exit', () => {
        reject(new Error('the server exited before answering'));
      });
    });
    try {
      const send = (id: number, method: string, params: object = {}) =>
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      const report = (commands: unknown) => ({
        name: 'report',
        arguments: {
          outcome: 'done',
          summary: 'Local test.',
          changes: [],
          criteria: [{ id: 'C1', status: 'verified', evidence: 'A command.', commands }],
        },
      });
      send(1, 'initialize');
      send(2, 'tools/list');
      send(3, 'tools/call', report(['fake-check']));
      send(4, 'tools/call', report([{ command: 'fake-check', exitCode: 0 }]));
      await answered;
    } finally {
      child.removeAllListeners('exit');
      child.kill();
    }
    assert.deepEqual(replies[0]?.result['serverInfo'], { name: 'ooc', version: '1' });
    assert.deepEqual(replies[1]?.result['tools'], tools);
    assert.equal(replies[2]?.result['isError'], undefined);
    assert.equal(replies[3]?.result['isError'], true);
  });
});
