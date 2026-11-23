// A stat cache for the workspace walks (ADR 0047): the content hash of a file,
// by absolute path, kept while its size and modification time stay the same.
// `snapshot()` and the checkpoint store share it. Node only, no `vscode`.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

/** Larger files are never read: checkpoints do not record them, snapshots fingerprint them by metadata. */
export const MAX_FILE_BYTES = 2 * 1024 * 1024;
/** A file modified within this of the scan start may still change at the same mtime (Git's racy rule). */
const RACY_MS = 2_000;
/** shortcut: the whole cache is dropped when full, not pruned; upgrade if the walks start to thrash. */
const MAX_ENTRIES = 50_000;

interface Stat {
  readonly size: number;
  readonly mtimeMs: number;
}

export function sha256(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

export class FileHashes {
  private readonly entries = new Map<string, Stat & { readonly hash: string }>();
  // Explicit field, not a parameter property: the bench runs this with Node's type stripping.
  private readonly read: (path: string) => Buffer;

  /** `read`: how a file is read; injected by the tests to count the reads. */
  constructor(read: (path: string) => Buffer = readFileSync) {
    this.read = read;
  }

  /**
   * The file's hash, and its content when it had to be read now. `scanStart`:
   * `Date.now()` at the start of the walk. It is read again when its size or
   * mtime changed, or when its mtime is too close to (or after) the scan start.
   */
  hash(path: string, stat: Stat, scanStart: number): { hash: string; content?: Buffer } {
    const cached = this.entries.get(path);
    if (
      cached &&
      cached.size === stat.size &&
      cached.mtimeMs === stat.mtimeMs &&
      stat.mtimeMs < scanStart - RACY_MS
    ) {
      return { hash: cached.hash };
    }
    const content = this.read(path);
    const hash = sha256(content);
    if (this.entries.size >= MAX_ENTRIES) this.entries.clear();
    this.entries.set(path, { size: stat.size, mtimeMs: stat.mtimeMs, hash });
    return { hash, content };
  }
}

/** The cache the product uses. */
export const fileHashes = new FileHashes();
