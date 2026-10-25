// Append-only JSONL log of a conversation's events. The runtime refuses a log
// inside the workspace: logs hold whole messages and stay out of the repository.

import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

export interface LoggedEvent {
  readonly seq: number;
  readonly at: string;
  readonly type: string;
  readonly [field: string]: unknown;
}

export interface EventLog {
  append(type: string, fields?: Readonly<Record<string, unknown>>): Promise<LoggedEvent>;
}

function inside(child: string, parent: string): boolean {
  const path = relative(resolve(parent), resolve(child));
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
}

/** Opens a log file; `workspace` is the directory the log must stay out of. */
export async function openEventLog(path: string, workspace: string): Promise<EventLog> {
  if (!isAbsolute(path)) throw new Error(`The event log path must be absolute: ${path}`);
  const insensitive = process.platform === 'win32';
  const [p, w] = insensitive ? [path.toLowerCase(), workspace.toLowerCase()] : [path, workspace];
  if (inside(p, w)) {
    throw new Error(`The event log must be outside the workspace: ${path}`);
  }
  await mkdir(dirname(path), { recursive: true });
  let seq = 0;
  let queue: Promise<unknown> = Promise.resolve();
  return {
    append(type, fields = {}) {
      const event: LoggedEvent = { seq: ++seq, at: new Date().toISOString(), type, ...fields };
      // Serialized, so lines never interleave and keep their order.
      const write = queue.then(() => appendFile(path, `${JSON.stringify(event)}\n`, 'utf8'));
      queue = write.catch(() => undefined);
      return write.then(() => event);
    },
  };
}
