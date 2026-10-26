// Turns real Claude Code stream-json output into a redacted fixture for the
// fake Claude CLI (test/fixtures/fake-claude.mjs). Dev tooling only.
//
// Two sources:
// - CLAUDE_RECORD_FROM=<capture.jsonl>: imports an existing raw capture, one
//   `{ "atMs": n, "line": "<stdout line>" }` per line (no new turn);
// - CLAUDE_RECORD_LIVE=1 with CLAUDE_EXECUTABLE: runs ONE real turn with the
//   adapter's own arguments and the prompt "Rispondi solo OK". It uses model
//   quota: only on purpose.
// Either way the output is redacted in memory and not written if the leak
// scanner still finds something.
//
// Usage (PowerShell):
//   $env:CLAUDE_RECORD_FROM = 'C:\...\capture.jsonl'; $env:CLAUDE_RECORD_ARGS = '<args as JSON>'
//   $env:CLAUDE_RECORD_SCENARIO = 'turn-usage-limit'   # optional, default turn-ok
//   pnpm record:claude

import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'vitest';
import { claudeTurnArgs } from '../src/claude/turn.js';
import { withoutApiKeys } from '../src/environment.js';
import {
  findLeaks,
  homeLiteral,
  localNameLiterals,
  localNames,
  redactTranscript,
  type RedactionLiterals,
} from './redact.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures', 'claude');
const PROMPT = 'Rispondi solo OK';

interface Captured {
  readonly atMs: number;
  readonly line: string;
}

function literals(): RedactionLiterals {
  const out = new Map<string, string>();
  const home = homeLiteral();
  const paths: [string, string][] = [[tmpdir(), '<TMP>']];
  if (home) paths.push([home, '<HOME>']);
  for (const [path, placeholder] of paths) {
    out.set(path, placeholder);
    out.set(path.replaceAll('\\', '/'), placeholder);
  }
  for (const [name, placeholder] of localNameLiterals()) out.set(name, placeholder);
  return [...out];
}

async function liveCapture(executable: string, args: readonly string[]): Promise<Captured[]> {
  const child = spawn(executable, args, {
    env: withoutApiKeys(process.env),
    stdio: 'pipe',
    windowsHide: true,
  });
  const started = Date.now();
  const lines: Captured[] = [];
  createInterface({ input: child.stdout }).on('line', (line) => {
    lines.push({ atMs: Date.now() - started, line });
  });
  child.stderr.resume();
  child.stdin.write(
    `${JSON.stringify({ type: 'user', message: { role: 'user', content: PROMPT } })}\n`,
  );
  child.stdin.end();
  await new Promise((resolve) => child.once('close', resolve));
  return lines;
}

const from = process.env['CLAUDE_RECORD_FROM'];
/** Fixture name: turn-ok, or turn-usage-limit for a capture rejected with 429. */
const scenario = process.env['CLAUDE_RECORD_SCENARIO'] ?? 'turn-ok';
const live =
  process.env['CLAUDE_RECORD_LIVE'] === '1' ? process.env['CLAUDE_EXECUTABLE'] : undefined;

describe.runIf(from ?? live)('record a Claude stream-json fixture', () => {
  it('writes a redacted fixture', async () => {
    const args = from
      ? (JSON.parse(process.env['CLAUDE_RECORD_ARGS'] ?? '[]') as string[])
      : claudeTurnArgs({ executable: '', cwd: '', prompt: PROMPT, model: 'haiku', effort: 'low' });
    const captured = from
      ? readFileSync(from, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line) as Captured)
      : await liveCapture(live ?? '', args);

    const messages = captured.map(({ atMs, line }) => ({
      type: 'message',
      dir: 'server',
      atMs,
      message: JSON.parse(line) as unknown,
    }));
    const init = messages.find((m) => {
      const message = m.message as Record<string, unknown>;
      return message['type'] === 'system' && message['subtype'] === 'init';
    })?.message as Record<string, unknown> | undefined;
    const version =
      typeof init?.['claude_code_version'] === 'string' ? init['claude_code_version'] : 'unknown';
    const meta = {
      type: 'meta',
      scenario,
      claudeVersion: version,
      recordedAt: new Date().toISOString(),
      platform: `${process.platform}-${process.arch}`,
      commands: { claude: ['<CLAUDE_EXECUTABLE>', ...args] },
    };
    const input = {
      type: 'message',
      dir: 'client',
      atMs: 0,
      message: { type: 'user', message: { role: 'user', content: PROMPT } },
    };
    const text = `${redactTranscript([meta, input, ...messages], literals())
      .map((entry) => JSON.stringify(entry))
      .join('\n')}\n`;
    const leaks = findLeaks(text, localNames());
    if (leaks.length > 0) {
      throw new Error(
        `Fixture not written, possible leaks: ${leaks.map((l) => `${l.kind} ${l.match}`).join('; ')}`,
      );
    }
    const out = join(FIXTURES, version, `${scenario}.jsonl`);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, text);
    console.log(`wrote ${out}`);
  }, 120_000);
});
