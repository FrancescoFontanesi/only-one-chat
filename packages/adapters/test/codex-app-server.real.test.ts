// Opt-in check against a real Codex CLI. Runs only when CODEX_EXECUTABLE points
// at a native codex binary; it is not part of the default or CI runs because
// no Codex CLI is installed there. The dedicated profile is a fresh temporary
// directory, so the user's configuration and credentials are never read or
// changed, no login is started and no model call is made.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { connectCodex, resolveCodexExecutable } from '../src/index.js';

const configuredPath = process.env['CODEX_EXECUTABLE'];

describe.runIf(configuredPath)('real codex app-server (CODEX_EXECUTABLE)', () => {
  it('handshakes in a fresh dedicated profile, reports login_required and shuts down', async () => {
    const codexHome = mkdtempSync(join(tmpdir(), 'codex home '));
    try {
      const executable = await resolveCodexExecutable({ configuredPath: configuredPath ?? '' });
      const exits: unknown[] = [];
      const session = await connectCodex({
        executable,
        codexHome,
        clientInfo: { name: 'only-one-chat-real-check', version: '0.0.0' },
        requestTimeoutMs: 30_000,
        onExit: (info) => exits.push(info),
      });
      expect(session.auth).toEqual({ status: 'login_required' });

      await session.close();
      expect(exits).toHaveLength(1);
    } finally {
      rmSync(codexHome, { recursive: true, force: true });
    }
  }, 60_000);
});
