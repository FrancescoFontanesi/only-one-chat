// The permission bridge and its PermissionRequest hook, run as Claude would run
// it: a Node process reading the hook input on stdin. No Claude, no quota.

import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  claudeTurnArgs,
  startPermissionBridge,
  summarizeToolCall,
  type PermissionBridge,
  type PermissionDecision,
  type PermissionRequest,
} from '../src/index.js';

const HOOK = join(import.meta.dirname, '..', 'hooks', 'permission-request.mjs');

let bridge: PermissionBridge | undefined;
afterEach(async () => {
  await bridge?.close();
  bridge = undefined;
});

/** Runs the hook with Claude's input and the given environment; its decision. */
function runHook(
  input: Record<string, unknown>,
  env: Readonly<Record<string, string>>,
): Promise<{ behavior: string; updatedInput?: unknown; message?: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HOOK], {
      env: { PATH: process.env['PATH'] ?? '', ...env },
      stdio: 'pipe',
    });
    let out = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (out += chunk));
    child.on('error', reject);
    child.on('close', () => {
      const parsed = JSON.parse(out) as {
        hookSpecificOutput: {
          hookEventName: string;
          decision: { behavior: string; updatedInput?: unknown; message?: string };
        };
      };
      expect(parsed.hookSpecificOutput.hookEventName).toBe('PermissionRequest');
      resolve(parsed.hookSpecificOutput.decision);
    });
    child.stdin.end(JSON.stringify({ hook_event_name: 'PermissionRequest', ...input }));
  });
}

async function start(decide: (request: PermissionRequest) => PermissionDecision) {
  const asked: PermissionRequest[] = [];
  bridge = await startPermissionBridge(
    (request) => {
      asked.push(request);
      return Promise.resolve(decide(request));
    },
    { nodeExecutable: process.execPath, hookScript: HOOK },
  );
  return { bridge, asked };
}

describe('permission bridge and hook', () => {
  it('asks the user and allows with the input unchanged', async () => {
    const { bridge, asked } = await start(() => 'accept');
    const input = { command: 'npm test' };
    expect(await runHook({ tool_name: 'Bash', tool_input: input }, bridge.env)).toEqual({
      behavior: 'allow',
      updatedInput: input,
    });
    expect(asked).toEqual([{ tool: 'Bash', input, summary: 'Bash: npm test' }]);
  });

  it('denies when the user declines', async () => {
    const { bridge } = await start(() => 'decline');
    const decision = await runHook(
      { tool_name: 'Edit', tool_input: { file_path: '/etc/hosts' } },
      bridge.env,
    );
    expect(decision.behavior).toBe('deny');
  });

  it('remembers "for the session" for the same tool and input only', async () => {
    const { bridge, asked } = await start(() => 'acceptForSession');
    const env = bridge.env;
    await runHook({ tool_name: 'Bash', tool_input: { command: 'git status' } }, env);
    // Same request, keys in another order: allowed without asking again.
    expect(
      (await runHook({ tool_name: 'Bash', tool_input: { command: 'git status' } }, env)).behavior,
    ).toBe('allow');
    // Same program, another command: asked again (threat T5).
    await runHook({ tool_name: 'Bash', tool_input: { command: 'git push --force' } }, env);
    expect(asked.map((r) => r.summary)).toEqual(['Bash: git status', 'Bash: git push --force']);
  });

  it('denies a caller without the token, and a hook without a bridge', async () => {
    const { bridge, asked } = await start(() => 'accept');
    const wrongToken = { ...bridge.env, OOC_PERMISSION_TOKEN: 'x'.repeat(64) };
    expect((await runHook({ tool_name: 'Bash', tool_input: {} }, wrongToken)).behavior).toBe(
      'deny',
    );
    expect((await runHook({ tool_name: 'Bash', tool_input: {} }, {})).behavior).toBe('deny');
    expect(asked).toEqual([]);
  });

  it('puts the hook in the run’s settings, and asks for everything with askAll', async () => {
    const { bridge } = await start(() => 'accept');
    const settings = JSON.parse(bridge.settings) as {
      hooks: { PermissionRequest: { hooks: { command: string }[] }[] };
    };
    expect(settings.hooks.PermissionRequest[0]?.hooks[0]?.command).toContain(
      'permission-request.mjs',
    );
    const base = { executable: 'claude', cwd: '.', prompt: 'x', sandbox: { commands: ['python'] } };
    const auto = claudeTurnArgs({
      ...base,
      permissionHook: { settings: bridge.settings, env: {} },
    });
    expect(auto).toContain('--settings');
    expect(auto).toContain('--allowedTools');
    const ask = claudeTurnArgs({
      ...base,
      permissionHook: { settings: bridge.settings, env: {}, askAll: true },
    });
    expect(ask).not.toContain('--allowedTools');
    expect(summarizeToolCall('Write', { file_path: 'a.py' })).toBe('Write: a.py');
  });
});
