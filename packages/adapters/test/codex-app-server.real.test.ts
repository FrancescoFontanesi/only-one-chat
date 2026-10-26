// Opt-in check against a real Codex CLI. Runs only when CODEX_EXECUTABLE points
// at a native codex binary; it is not part of the default or CI runs because
// no Codex CLI is installed there. The dedicated profile is a fresh temporary
// directory, so the user's configuration and credentials are never read or
// changed, no login is started and no model call is made.

import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { connectCodex, resolveCodexExecutable, startAppServer } from '../src/index.js';
import { prepareCodexLaunch } from '../src/codex/session.js';
import { ISOLATED_PROFILE_OVERRIDES } from '../dev/isolated-profile.js';
import { testEnv } from './env.js';

const configuredPath = process.env['CODEX_EXECUTABLE'];
const RECORDED_VERSIONS = readdirSync(join(import.meta.dirname, 'fixtures', 'codex'));

describe.runIf(configuredPath)('real codex app-server (CODEX_EXECUTABLE)', () => {
  it('handshakes in a fresh throwaway profile, reports login_required and shuts down', async () => {
    const codexHome = mkdtempSync(join(tmpdir(), 'codex home '));
    try {
      const executable = await resolveCodexExecutable({ configuredPath: configuredPath ?? '' });
      const exits: unknown[] = [];
      const session = await connectCodex({
        executable,
        baseEnv: testEnv({ CODEX_HOME: codexHome }),
        configOverrides: ISOLATED_PROFILE_OVERRIDES,
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

  // A different version is not a failure, but the contract tests then describe
  // another Codex: re-record the fixtures (pnpm record:codex) and compare.
  it('runs the Codex version the fixtures were recorded with', async (context) => {
    const codexHome = mkdtempSync(join(tmpdir(), 'codex home '));
    try {
      const executable = await resolveCodexExecutable({ configuredPath: configuredPath ?? '' });
      const launch = prepareCodexLaunch(
        testEnv({ CODEX_HOME: codexHome }),
        [],
        ISOLATED_PROFILE_OVERRIDES,
      );
      const client = await startAppServer({
        executable,
        args: launch.args,
        env: launch.env,
        clientInfo: { name: 'only-one-chat-real-check', version: '0.0.0' },
      });
      const { userAgent } = client.initializeResponse;
      await client.close();
      const installed = /\/(\d+\.\d+\.\d+[\w.-]*)/.exec(userAgent)?.[1] ?? userAgent;
      if (!RECORDED_VERSIONS.includes(installed)) {
        const note =
          `Installed Codex ${installed} differs from the recorded fixtures ` +
          `(${RECORDED_VERSIONS.join(', ')}): re-record with pnpm record:codex`;
        console.warn(`\n!!! ${note}\n`);
        context.skip(note);
      }
    } finally {
      rmSync(codexHome, { recursive: true, force: true });
    }
  }, 60_000);
});
