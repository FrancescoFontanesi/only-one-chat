// Checkpoints of the folder and the review of what a message changed (ADR
// 0014). Before each user message the folder's files are recorded: each
// content once, under its SHA-256, in the extension's storage, and a manifest
// of path → hash. After the message the files that differ are listed with the
// lines added and removed; each can be shown in a diff, or put back as it was,
// and the whole folder can go back to the state before any message. Not
// covered: what lies in the skipped folders, files over MAX_FILE_BYTES, and
// anything outside the folder (a shell command's effects there included).
// Node only, no `vscode`.

import { createHash, randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { ChangedFile } from '../webview/protocol.js';
import { MAX_FILES, SKIPPED } from './facts.js';

/** Larger files are not recorded: their changes cannot be undone. */
export const MAX_FILE_BYTES = 2 * 1024 * 1024;
/** A diff longer than this many edits is not computed line by line. */
const MAX_EDITS = 20_000;

export interface Checkpoint {
  readonly id: string;
  readonly at: number;
  /** Relative path → content hash. */
  readonly files: Readonly<Record<string, string>>;
  /** Files seen but too large to record: path → size and modification time. */
  readonly large: Readonly<Record<string, string>>;
}

export interface Review {
  readonly files: readonly ChangedFile[];
  /** Files changed that cannot be put back, e.g. too large to record. */
  readonly uncovered: readonly string[];
}

const ID = /^[a-z0-9-]{1,64}$/;
const HASH = /^[0-9a-f]{64}$/;

function hash(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

function isBinary(content: Buffer): boolean {
  return content.subarray(0, 8000).includes(0);
}

/** Lines added and removed between two texts (Myers' shortest edit script, lengths only). */
export function lineCounts(before: string, after: string): { added: number; removed: number } {
  // A final newline ends the last line; it does not start another.
  const lines = (text: string) => (text === '' ? [] : text.replace(/\r?\n$/, '').split(/\r?\n/));
  const a = lines(before);
  const b = lines(after);
  const n = a.length;
  const m = b.length;
  const max = Math.min(n + m, MAX_EDITS);
  const v = new Map<number, number>([[1, 0]]);
  for (let d = 0; d <= max; d++) {
    for (let k = -d; k <= d; k += 2) {
      const down = k === -d || (k !== d && (v.get(k - 1) ?? -1) < (v.get(k + 1) ?? -1));
      let x = down ? (v.get(k + 1) ?? 0) : (v.get(k - 1) ?? 0) + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v.set(k, x);
      if (x >= n && y >= m) return { added: (d + m - n) / 2, removed: (d - m + n) / 2 };
    }
  }
  return { added: m, removed: n };
}

export class CheckpointStore {
  private readonly blobs: string;
  private readonly manifests: string;

  /** `root`: this chat's folder in the extension's storage; `cwd`: the folder the agents work in. */
  constructor(
    root: string,
    private readonly cwd: string,
  ) {
    this.blobs = join(root, 'blobs');
    this.manifests = join(root, 'checkpoints');
  }

  /** The path of a file of the folder, refused if it leads outside it. */
  private inside(path: string): string {
    const full = resolve(this.cwd, path);
    const rel = relative(this.cwd, full);
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
      throw new Error(`path outside the folder: ${path}`);
    }
    return full;
  }

  private blobPath(id: string): string {
    if (!HASH.test(id)) throw new Error(`invalid content hash ${JSON.stringify(id)}`);
    return join(this.blobs, id.slice(0, 2), id);
  }

  /** Stores a content once, atomically. */
  private keep(content: Buffer): string {
    const id = hash(content);
    const path = this.blobPath(id);
    if (!existsSync(path)) {
      mkdirSync(dirname(path), { recursive: true });
      const temporary = `${path}.${randomBytes(4).toString('hex')}.tmp`;
      writeFileSync(temporary, content);
      renameSync(temporary, path);
    }
    return id;
  }

  /** A content recorded earlier. */
  content(id: string): Buffer {
    return readFileSync(this.blobPath(id));
  }

  /** The folder's files now: path → content, the large ones apart. Null when it cannot be read. */
  private read(): { files: Map<string, Buffer>; large: Map<string, string> } | null {
    const files = new Map<string, Buffer>();
    const large = new Map<string, string>();
    const walk = (folder: string): boolean => {
      for (const entry of readdirSync(folder, { withFileTypes: true })) {
        const full = join(folder, entry.name);
        if (entry.isDirectory()) {
          if (SKIPPED.has(entry.name)) continue;
          if (!walk(full)) return false;
        } else if (entry.isFile()) {
          if (files.size + large.size >= MAX_FILES) return false;
          const path = relative(this.cwd, full).split(sep).join('/');
          const stat = statSync(full);
          if (stat.size > MAX_FILE_BYTES)
            large.set(path, `${String(stat.size)}:${String(stat.mtimeMs)}`);
          else files.set(path, readFileSync(full));
        }
      }
      return true;
    };
    try {
      return walk(this.cwd) ? { files, large } : null;
    } catch {
      return null;
    }
  }

  /** Records the folder as it is; null when it cannot (too many files, unreadable). */
  take(id: string, at = Date.now()): Checkpoint | null {
    if (!ID.test(id)) throw new Error(`invalid checkpoint id ${JSON.stringify(id)}`);
    const now = this.read();
    if (!now) return null;
    const files: Record<string, string> = {};
    for (const [path, content] of now.files) files[path] = this.keep(content);
    const checkpoint: Checkpoint = { id, at, files, large: Object.fromEntries(now.large) };
    mkdirSync(this.manifests, { recursive: true });
    const path = join(this.manifests, `${id}.json`);
    writeFileSync(`${path}.tmp`, JSON.stringify(checkpoint));
    renameSync(`${path}.tmp`, path);
    return checkpoint;
  }

  load(id: string): Checkpoint | undefined {
    if (!ID.test(id)) return undefined;
    try {
      return JSON.parse(readFileSync(join(this.manifests, `${id}.json`), 'utf8')) as Checkpoint;
    } catch {
      return undefined;
    }
  }

  /**
   * What changed since the checkpoint: each file with its lines, and the
   * contents after it recorded too, so the diff stays what the message did.
   */
  review(checkpoint: Checkpoint): Review | null {
    const now = this.read();
    if (!now) return null;
    const files: ChangedFile[] = [];
    const change = (path: string, before: string | null, content: Buffer | undefined) => {
      const after = content ? this.keep(content) : null;
      if (before === after) return;
      const old = before ? this.content(before) : Buffer.alloc(0);
      const binary = isBinary(old) || (content ? isBinary(content) : false);
      const counts = binary
        ? { added: 0, removed: 0 }
        : lineCounts(old.toString('utf8'), content?.toString('utf8') ?? '');
      files.push({
        path,
        kind: before === null ? 'added' : after === null ? 'deleted' : 'modified',
        ...counts,
        binary,
        before,
        after,
      });
    };
    const uncovered = new Set<string>();
    for (const [path, content] of now.files) {
      // Too large to record before: it existed, so it is neither added nor revertible.
      if (checkpoint.large[path] !== undefined) uncovered.add(path);
      else change(path, checkpoint.files[path] ?? null, content);
    }
    for (const path of Object.keys(checkpoint.files)) {
      if (!now.files.has(path) && !now.large.has(path)) {
        change(path, checkpoint.files[path] ?? null, undefined);
      }
    }
    // Large files: changed, grown past the limit, or gone; none can be put back.
    for (const [path, signature] of now.large) {
      if (checkpoint.large[path] !== signature) uncovered.add(path);
    }
    for (const path of Object.keys(checkpoint.large)) {
      if (!now.large.has(path) && !now.files.has(path)) uncovered.add(path);
    }
    return {
      files: files.sort((x, y) => x.path.localeCompare(y.path)),
      uncovered: [...uncovered].sort(),
    };
  }

  /** The file's content hash now; null when it does not exist. */
  current(path: string): string | null {
    const full = this.inside(path);
    return existsSync(full) ? hash(readFileSync(full)) : null;
  }

  /** Puts a file back to a recorded content, or removes it (null). */
  put(path: string, content: string | null): void {
    const full = this.inside(path);
    if (content === null) {
      rmSync(full, { force: true });
      return;
    }
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, this.content(content));
  }

  /** Brings the folder back to the checkpoint; the paths put back. */
  restore(checkpoint: Checkpoint): string[] {
    const review = this.review(checkpoint);
    if (!review) throw new Error('the folder cannot be read');
    for (const file of review.files) this.put(file.path, file.before);
    return review.files.map((file) => file.path);
  }
}
