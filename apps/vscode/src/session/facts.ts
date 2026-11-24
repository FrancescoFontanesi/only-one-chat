// What the runtime verifies itself after an implementer's turn (ADR 0010): the
// files changed since the request started and, when configured, the
// verification command run again. No model writes these facts. Node only, no
// `vscode`, so it can be unit-tested.

import { spawn } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { withoutApiKeys } from '@only-one-chat/adapters';
import {
  CONFIGURED_COMMAND_PREFIX,
  FAILED_TESTS_HEADER,
  NO_CONFIGURED_COMMAND,
  FILES_HEADER,
  FILES_UNAVAILABLE,
  OUTPUT_HEADER,
  TURN_FILES_HEADER,
  VERIFY_PREFIX,
} from '@only-one-chat/runtime';
import { MAX_FILE_BYTES, fileHashes, type FileHashes } from './file-hashes.js';
import { NOTHING_IGNORED, type Ignored } from './ignore.js';

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
type Snapshot = ReadonlyMap<string, string> | 'unavailable';

/**
 * Content hash of every file under `dir`, by relative path; `ignored` paths left out (ADR 0021).
 * A file over 2 MiB is not read: its size and mtime stand for it (ADR 0047).
 */
export function snapshot(
  dir: string,
  ignored: Ignored = NOTHING_IGNORED,
  hashes: FileHashes = fileHashes,
): Snapshot {
  try {
    return walkFolder(dir, ignored, hashes);
  } catch {
    return 'unavailable';
  }
}

function walkFolder(dir: string, ignored: Ignored, hashes: FileHashes): Snapshot {
  const scanStart = Date.now();
  const out = new Map<string, string>();
  const walk = (folder: string): boolean => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      // With '/' on every platform, as the checkpoints and the contract checks write it.
      const rel = relative(dir, path).split(sep).join('/');
      if (entry.isDirectory()) {
        if (SKIPPED.has(entry.name) || ignored(rel, true)) continue;
        if (!walk(path)) return false;
      } else if (entry.isFile()) {
        if (ignored(rel, false)) continue;
        if (out.size >= MAX_FILES) return false;
        const stat = statSync(path);
        out.set(
          rel,
          stat.size > MAX_FILE_BYTES
            ? `large:${String(stat.size)}:${String(stat.mtimeMs)}`
            : hashes.hash(path, stat, scanStart).hash,
        );
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

interface CommandRun {
  readonly code: number | null;
  readonly output: string;
  readonly timedOut: boolean;
}

/** Runs a command without a shell; stdout and stderr together. */
function runCommand(
  command: readonly string[],
  cwd: string,
  timeoutMs = 120_000,
): Promise<CommandRun> {
  const [program = '', ...args] = command;
  return new Promise((resolve) => {
    const child = spawn(program, args, {
      cwd,
      env: { ...withoutApiKeys(process.env), PYTHONDONTWRITEBYTECODE: '1' },
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
  ignored: Ignored = NOTHING_IGNORED,
  /** The workspace just before the implementer's last turn: lists what that turn changed (ADR 0041). */
  turnBase?: Snapshot,
): Promise<string> {
  const now = snapshot(dir, ignored);
  const changed = changes(baseline, now);
  const lines = [FILES_HEADER];
  if (changed === 'unknown') lines.push(FILES_UNAVAILABLE);
  else lines.push(...(changed.length > 0 ? changed.map((c) => `- ${c}`) : ['- none']));
  const turn = turnBase ? changes(turnBase, now) : 'unknown';
  if (turn !== 'unknown') {
    lines.push(
      '',
      TURN_FILES_HEADER,
      ...(turn.length > 0 ? turn.map((c) => `- ${c}`) : ['- none']),
    );
  }
  if (verify.length > 0) {
    const run = await runCommand(verify, dir);
    const output = run.output.replace(/\r\n/g, '\n').trim();
    // unittest and pytest name each failure on a "FAIL: ..." or "ERROR: ..." line.
    const failed = output.split('\n').filter((line) => /^(FAIL|ERROR)[: ]/.test(line));
    lines.push(
      '',
      `${VERIFY_PREFIX}${verify.join(' ')} → exit ${String(run.code)}${run.timedOut ? ' (timeout)' : ''}`,
      ...(failed.length > 0 ? [FAILED_TESTS_HEADER, ...failed.map((line) => `- ${line}`)] : []),
      OUTPUT_HEADER,
      output.split('\n').slice(-15).join('\n') || '(no output)',
    );
  }
  return lines.join('\n');
}

/** The line the facts carry about the configured verification command. */
export function configuredCommandFact(verify: readonly string[]): string {
  return verify.length > 0
    ? `${CONFIGURED_COMMAND_PREFIX}${JSON.stringify(verify)}. The {junit} placeholder receives an extension-owned report path.`
    : NO_CONFIGURED_COMMAND;
}
