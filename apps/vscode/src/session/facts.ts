// What the runtime verifies itself after an implementer's turn (ADR 0010): the
// files changed since the request started and, when configured, the
// verification command run again. No model writes these facts. Node only, no
// `vscode`, so it can be unit-tested.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

/** Folders never walked: dependencies, caches, version control. */
export const SKIPPED = new Set([
  '.git',
  'node_modules',
  '__pycache__',
  '.venv',
  'venv',
  'dist',
  'out',
]);
/** A workspace larger than this is not hashed: the facts say so instead. */
export const MAX_FILES = 5_000;

/** `unavailable`: too many files, or the folder could not be read. */
export type Snapshot = ReadonlyMap<string, string> | 'unavailable';

/** Content hash of every file under `dir`, by relative path. */
export function snapshot(dir: string): Snapshot {
  try {
    return walkFolder(dir);
  } catch {
    return 'unavailable';
  }
}

function walkFolder(dir: string): Snapshot {
  const out = new Map<string, string>();
  const walk = (folder: string): boolean => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (SKIPPED.has(entry.name)) continue;
        if (!walk(join(folder, entry.name))) return false;
      } else if (entry.isFile()) {
        if (out.size >= MAX_FILES) return false;
        const path = join(folder, entry.name);
        out.set(relative(dir, path), createHash('sha256').update(readFileSync(path)).digest('hex'));
      }
    }
    return true;
  };
  return walk(dir) ? out : 'unavailable';
}

export function changes(before: Snapshot, after: Snapshot): string[] | 'unknown' {
  if (before === 'unavailable' || after === 'unavailable') return 'unknown';
  const out: string[] = [];
  for (const [path, hash] of after) {
    if (!before.has(path)) out.push(`added ${path}`);
    else if (before.get(path) !== hash) out.push(`modified ${path}`);
  }
  for (const path of before.keys()) if (!after.has(path)) out.push(`deleted ${path}`);
  return out.sort((a, b) => a.slice(a.indexOf(' ')).localeCompare(b.slice(b.indexOf(' '))));
}

export interface CommandRun {
  readonly code: number | null;
  readonly output: string;
  readonly timedOut: boolean;
}

/** Runs a command without a shell; stdout and stderr together. */
export function runCommand(
  command: readonly string[],
  cwd: string,
  timeoutMs = 120_000,
): Promise<CommandRun> {
  const [program = '', ...args] = command;
  return new Promise((resolve) => {
    const child = spawn(program, args, {
      cwd,
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let output = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (output += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (output += chunk));
    child.on('error', (error) => (output += String(error)));
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, output, timedOut });
    });
  });
}

/** The facts as text for the leader, and for the panel. */
export async function verifiedFacts(
  dir: string,
  baseline: Snapshot,
  verify: readonly string[],
): Promise<string> {
  const changed = changes(baseline, snapshot(dir));
  const lines = ['File cambiati dall’inizio della richiesta:'];
  if (changed === 'unknown') {
    lines.push('- non calcolati: la cartella ha troppi file o non si può leggere');
  } else lines.push(...(changed.length > 0 ? changed.map((c) => `- ${c}`) : ['- nessuno']));
  if (verify.length > 0) {
    const run = await runCommand(verify, dir);
    const output = run.output.replace(/\r\n/g, '\n').trim();
    // unittest and pytest name each failure on a "FAIL: ..." or "ERROR: ..." line.
    const failed = output.split('\n').filter((line) => /^(FAIL|ERROR)[: ]/.test(line));
    lines.push(
      '',
      `Verifica eseguita dal runtime: ${verify.join(' ')} → exit ${String(run.code)}${run.timedOut ? ' (timeout)' : ''}`,
      ...(failed.length > 0 ? ['Test falliti:', ...failed.map((line) => `- ${line}`)] : []),
      'Ultime righe dell’output:',
      output.split('\n').slice(-15).join('\n') || '(nessun output)',
    );
  }
  return lines.join('\n');
}
