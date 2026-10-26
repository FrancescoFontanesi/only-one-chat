// Redacted transcripts of real CLI traffic, for the dev tools (demo, sub-agent
// check). Entries stay in memory until they are redacted like the recorded
// fixtures; raw traffic is never written, and nothing is if the leak scanner
// still finds something.

import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  findLeaks,
  homeLiteral,
  localNameLiterals,
  localNames,
  projectCodexConfig,
  redactTranscript,
} from '../packages/adapters/dev/redact.js';

export interface TraceEntry {
  readonly type: 'message';
  readonly dir: 'client' | 'server';
  readonly atMs: number;
  readonly message: unknown;
}

export class Trace {
  readonly entries: TraceEntry[] = [];
  private readonly started = Date.now();

  add(dir: 'client' | 'server', message: unknown): void {
    this.entries.push({ type: 'message', dir, atMs: Date.now() - this.started, message });
  }

  /**
   * Writes the redacted transcript; returns false (and writes nothing) when the
   * leak scanner finds something. `meta` is the first line, as in the fixtures.
   */
  write(path: string, meta: Record<string, unknown>, workspace: string): boolean {
    const init = this.entries
      .map(
        (entry) =>
          (entry.message as { result?: { codexHome?: unknown } } | null)?.result?.codexHome,
      )
      .find((value): value is string => typeof value === 'string');
    const literals = new Map<string, string>();
    const addPath = (value: string, placeholder: string) => {
      for (const form of [value, value.replaceAll('\\', '/')]) literals.set(form, placeholder);
    };
    addPath(workspace, '<WORKSPACE>');
    if (init) addPath(init, '<CODEX_HOME>');
    addPath(tmpdir(), '<TMP>');
    const home = homeLiteral();
    if (home) addPath(home, '<HOME>');
    for (const [name, placeholder] of localNameLiterals()) literals.set(name, placeholder);
    const entries = this.entries.map((entry) => ({
      ...entry,
      message: projectCodexConfig(entry.message),
    }));
    const text = `${redactTranscript(
      [{ type: 'meta', ...meta, recordedAt: new Date().toISOString() }, ...entries],
      [...literals],
    )
      .map((entry) => JSON.stringify(entry))
      .join('\n')}\n`;
    const leaks = findLeaks(text, localNames());
    if (leaks.length > 0) {
      process.stderr.write(
        `trace not written, possible leaks: ${leaks.map((leak) => leak.kind).join(', ')}\n`,
      );
      return false;
    }
    writeFileSync(path, text);
    return true;
  }
}

/** Codex version from an initialize userAgent ("only-one-chat/0.164.0 (…)"). */
export function codexVersion(trace: Trace): { codexVersion: string; userAgent: string } {
  const userAgent =
    trace.entries
      .map(
        (entry) =>
          (entry.message as { result?: { userAgent?: unknown } } | null)?.result?.userAgent,
      )
      .find((value): value is string => typeof value === 'string') ?? 'unknown';
  return {
    codexVersion: /\/(\d+\.\d+\.\d+[\w.-]*)/.exec(userAgent)?.[1] ?? 'unknown',
    userAgent,
  };
}
