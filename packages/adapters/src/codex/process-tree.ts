// Termination of a child's whole process tree, for app-server shutdown.
//
// - Windows: `taskkill.exe /PID <pid> /T /F` from %SystemRoot%\System32, no shell.
//   Once the root has exited its children can no longer be reached through it,
//   so orphans are looked up by ParentProcessId and creation time (PowerShell
//   CIM query, slow path only).
// - POSIX: the child leads its own process group (spawn `detached`), and the
//   group is signalled; it can be signalled even after the leader has exited.
// See docs/codex-app-server.md ("Arresto").

import { execFile } from 'node:child_process';
import { join } from 'node:path';

const windows = process.platform === 'win32';
const SYSTEM_TOOL_TIMEOUT_MS = 15_000;

/** Spawn option that puts the child in its own process group on POSIX. */
export const OWN_PROCESS_GROUP = !windows;

function systemRoot(): string {
  // process.env is case-insensitive on Windows.
  const root = process.env['SystemRoot'];
  if (!root) throw new Error('SystemRoot is not set: cannot locate Windows system tools');
  return root;
}

function run(file: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { windowsHide: true, timeout: SYSTEM_TOOL_TIMEOUT_MS, encoding: 'utf8' },
      (error, stdout, stderr) => {
        if (error) reject(new Error(`${file} failed: ${stderr.trim() || error.message}`));
        else resolve(stdout);
      },
    );
  });
}

function taskkillTree(pid: number): Promise<string> {
  return run(join(systemRoot(), 'System32', 'taskkill.exe'), ['/PID', String(pid), '/T', '/F']);
}

function signalGroup(pgid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pgid, signal);
  } catch (error) {
    // ESRCH: the group is already gone.
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

/**
 * Terminates a process that is still running together with its descendants.
 * On POSIX `signal` is sent to the process group; Windows has no graceful
 * equivalent for a windowless console process, so the tree is always forced.
 */
export async function terminateTree(pid: number, signal: NodeJS.Signals): Promise<void> {
  if (windows) await taskkillTree(pid);
  else signalGroup(pid, signal);
}

export interface ProcessRow {
  readonly pid: number;
  readonly createdAtMs: number;
}

/**
 * Children of an exited process that are really its own: created between its
 * start and its exit. After the exit the PID may be reused, and the children of
 * the new process would match the parent id but were created later.
 */
export function selectOrphans(
  children: readonly ProcessRow[],
  startedAtMs: number,
  exitedAtMs: number,
): number[] {
  return children
    .filter((row) => row.createdAtMs >= startedAtMs && row.createdAtMs <= exitedAtMs)
    .map((row) => row.pid);
}

async function childrenOf(pid: number): Promise<ProcessRow[]> {
  const powershell = join(systemRoot(), 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  // pid is a number from the OS, so it cannot change the meaning of the script.
  const script =
    "$ErrorActionPreference = 'Stop'; " +
    `Get-CimInstance -ClassName Win32_Process -Filter 'ParentProcessId = ${String(pid)}' | ` +
    "ForEach-Object { '{0} {1}' -f $_.ProcessId, ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() }";
  const out = await run(powershell, ['-NoProfile', '-NonInteractive', '-Command', script]);
  return out
    .split(/\r?\n/)
    .map((line) => line.trim().split(' ').map(Number))
    .filter((row): row is [number, number] => row.length === 2 && row.every(Number.isSafeInteger))
    .map(([child, createdAtMs]) => ({ pid: child, createdAtMs }));
}

export interface OrphanCleanup {
  /** Processes terminated on Windows (each with its own subtree); empty on POSIX. */
  readonly terminated: readonly number[];
  readonly errors: readonly string[];
}

/**
 * Terminates what an exited process left behind. `startedAtMs` must be taken
 * before the spawn and `exitedAtMs` once the exit is observed.
 */
export async function terminateOrphans(
  pid: number,
  startedAtMs: number,
  exitedAtMs: number,
): Promise<OrphanCleanup> {
  if (!windows) {
    try {
      signalGroup(pid, 'SIGKILL');
      return { terminated: [], errors: [] };
    } catch (error) {
      return { terminated: [], errors: [error instanceof Error ? error.message : String(error)] };
    }
  }
  const terminated: number[] = [];
  const errors: string[] = [];
  let orphans: number[] = [];
  try {
    orphans = selectOrphans(await childrenOf(pid), startedAtMs, exitedAtMs);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  for (const orphan of orphans) {
    try {
      await taskkillTree(orphan);
      terminated.push(orphan);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  return { terminated, errors };
}
