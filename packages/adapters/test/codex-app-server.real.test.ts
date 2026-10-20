// Opt-in check against a real Codex CLI. Runs only when CODEX_EXECUTABLE points
// at a native codex binary; it is not part of the default or CI runs because
// no Codex CLI is installed there. CODEX_HOME is a fresh temporary directory,
// so the user's configuration and credentials are never read or changed, and
// the handshake makes no model call.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveCodexExecutable, startAppServer } from '../src/index.js';

const configuredPath = process.env['CODEX_EXECUTABLE'];

describe.runIf(configuredPath)('real codex app-server (CODEX_EXECUTABLE)', () => {
  it('completes the handshake and shuts down cleanly with an isolated CODEX_HOME', async () => {
    const codexHome = mkdtempSync(join(tmpdir(), 'codex home '));
    try {
      const executable = await resolveCodexExecutable({ configuredPath: configuredPath ?? '' });
      const exits: unknown[] = [];
      const client = await startAppServer({
        executable,
        env: { ...process.env, CODEX_HOME: codexHome },
        clientInfo: { name: 'only-one-chat-real-check', version: '0.0.0' },
        requestTimeoutMs: 30_000,
        onExit: (info) => exits.push(info),
      });
      expect(client.initializeResponse.userAgent).not.toBe('');
      expect(['windows', 'unix']).toContain(client.initializeResponse.platformFamily);

      await client.close();
      expect(exits).toHaveLength(1);
    } finally {
      rmSync(codexHome, { recursive: true, force: true });
    }
  }, 60_000);
});
