// Whether a test's processes are still running. kill(pid, 0) succeeds for a
// zombie too: a process already killed but not yet reaped, which in a
// container without an init stays so for good. On Linux a process in state Z
// (or X) in /proc/<pid>/stat is therefore dead. Termination is waited for with
// a timeout, never checked once, so the tests do not depend on timing.

import { readFileSync } from 'node:fs';

/**
 * The state field of a /proc/<pid>/stat line, "pid (comm) S …". comm may
 * contain spaces and parentheses, so the state is read after the last ")".
 */
export function stateFromStat(stat: string): string | undefined {
  const end = stat.lastIndexOf(')');
  if (end < 0) return undefined;
  return /^\s+(\S)/.exec(stat.slice(end + 1))?.[1];
}

/** Linux process state, or undefined elsewhere and when it cannot be read. */
function linuxState(pid: number): string | undefined {
  if (process.platform !== 'linux') return undefined;
  try {
    return stateFromStat(readFileSync(`/proc/${String(pid)}/stat`, 'utf8'));
  } catch {
    return undefined;
  }
}

export function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  const state = linuxState(pid);
  return state !== 'Z' && state !== 'X';
}

/** Resolves true once `pid` is no longer running, false after `timeoutMs`. */
export async function exited(pid: number, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (!isRunning(pid)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
