// Checkpoints of the folder and the review of what a message changed (ADR
// 0014). Before each user message the folder's files are recorded: each
// content once, under its SHA-256, in the extension's storage, and a manifest
// of path → hash. After the message the files that differ are listed with the
// lines added and removed; each can be shown in a diff, or put back as it was,
// and the whole folder can go back to the state before any message. Not
// covered: what lies in the skipped folders, files over MAX_FILE_BYTES, and
// anything outside the folder (a shell command's effects there included).
// Node only, no `vscode`.

import { randomBytes } from 'node:crypto';
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
import {
  assessRisk,
  lineCounts,
  riskFact,
  shortcutFacts,
  type TextChange,
} from '@only-one-chat/runtime';
import type { ChangedFile } from '../shared/protocol.js';
import { MAX_FILES, SKIPPED } from './facts.js';
import { MAX_FILE_BYTES, fileHashes, sha256, type FileHashes } from './file-hashes.js';
import { NOTHING_IGNORED, type Ignored } from './ignore.js';

// Larger files are not recorded: their changes cannot be undone.
export { MAX_FILE_BYTES };

export interface Checkpoint {
  readonly incomplete?: boolean;
  readonly id: string;
  readonly at: number;
  /** Relative path → content hash. */
  readonly files: Readonly<Record<string, string>>;
  /** Files seen but too large to record: path → size and modification time. */
  readonly large: Readonly<Record<string, string>>;
}

interface Review {
  readonly files: readonly ChangedFile[];
  /** Files changed that cannot be put back, e.g. too large to record. */
  readonly uncovered: readonly string[];
}

const ID = /^[a-z0-9-]{1,64}$/;
const HASH = /^[0-9a-f]{64}$/;

function isBinary(content: Buffer): boolean {
  return content.subarray(0, 8000).includes(0);
}

export class CheckpointStore {
  private readonly blobs: string;
  private readonly manifests: string;
  // Explicit fields, not parameter properties: the bench runs this file with Node's type stripping.
  private readonly cwd: string;
  /** Paths left out of every checkpoint (ADR 0021). */
  private readonly ignored: Ignored;
  private readonly hashes: FileHashes;
  /** Blobs known to be on disk, written or verified by this instance (ADR 0047). */
  private readonly known = new Set<string>();

  /** `root`: this chat's folder in the extension's storage; `cwd`: the folder the agents work in. */
  constructor(
    root: string,
    cwd: string,
    ignored: Ignored = NOTHING_IGNORED,
    hashes: FileHashes = fileHashes,
  ) {
    this.cwd = cwd;
    this.ignored = ignored;
    this.hashes = hashes;
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
    const id = sha256(content);
    if (!this.has(id)) {
      const path = this.blobPath(id);
      mkdirSync(dirname(path), { recursive: true });
      const temporary = `${path}.${randomBytes(4).toString('hex')}.tmp`;
      writeFileSync(temporary, content);
      renameSync(temporary, path);
      this.known.add(id);
    }
    return id;
  }

  /**
   * Forgets the known blobs when their folder is gone (the chat's checkpoints
   * deleted, storage cleaned), so they are written again instead of referenced.
   */
  private forgetIfGone(): void {
    if (this.known.size > 0 && !existsSync(this.blobs)) this.known.clear();
  }

  /** Whether the blob is on disk; asked of the disk once per blob and instance. */
  private has(id: string): boolean {
    if (this.known.has(id)) return true;
    if (!existsSync(this.blobPath(id))) return false;
    this.known.add(id);
    return true;
  }

  /** A file of the folder as it is now; null when it vanished since the walk. */
  private fileContent(path: string): Buffer | null {
    try {
      return readFileSync(resolve(this.cwd, path));
    } catch {
      return null;
    }
  }

  /** A content recorded earlier. */
  content(id: string): Buffer {
    try {
      return readFileSync(this.blobPath(id));
    } catch (error) {
      // Still an error here; the next checkpoint writes the blob again instead of trusting it.
      this.known.delete(id);
      throw error;
    }
  }

  keepArtifact(content: string): string {
    this.forgetIfGone();
    return this.keep(Buffer.from(content, 'utf8'));
  }

  /**
   * The folder's files now: path → hash (and the content, when it was read to
   * hash it), the large ones apart. Null when it cannot be read.
   */
  private read(): {
    files: Map<string, { hash: string; content?: Buffer | undefined }>;
    large: Map<string, string>;
    incomplete: boolean;
  } | null {
    const scanStart = Date.now();
    const files = new Map<string, { hash: string; content?: Buffer | undefined }>();
    const large = new Map<string, string>();
    let incomplete = false;
    const walk = (folder: string): boolean => {
      for (const entry of readdirSync(folder, { withFileTypes: true })) {
        const full = join(folder, entry.name);
        const path = relative(this.cwd, full).split(sep).join('/');
        if (entry.isDirectory()) {
          if (SKIPPED.has(entry.name) || this.ignored(path, true)) continue;
          if (!walk(full)) return false;
        } else if (entry.isFile()) {
          if (this.ignored(path, false)) continue;
          if (files.size + large.size >= MAX_FILES) return false;
          const stat = statSync(full);
          if (stat.size > MAX_FILE_BYTES)
            large.set(path, `${String(stat.size)}:${String(stat.mtimeMs)}`);
          else files.set(path, this.hashes.hash(full, stat, scanStart));
        } else incomplete = true;
      }
      return true;
    };
    try {
      return walk(this.cwd) ? { files, large, incomplete } : null;
    } catch {
      return null;
    }
  }

  /** Records the folder as it is; null when it cannot (too many files, unreadable). */
  take(id: string, at = Date.now()): Checkpoint | null {
    if (!ID.test(id)) throw new Error(`invalid checkpoint id ${JSON.stringify(id)}`);
    const now = this.read();
    if (!now) return null;
    this.forgetIfGone();
    const files: Record<string, string> = {};
    for (const [path, file] of now.files) {
      if (file.content) files[path] = this.keep(file.content);
      else if (this.has(file.hash)) files[path] = file.hash;
      else {
        // Unchanged since it was hashed, but this store has no blob of it yet.
        const content = this.fileContent(path);
        if (!content) return null;
        files[path] = this.keep(content);
      }
    }
    const checkpoint: Checkpoint = {
      id,
      at,
      files,
      large: Object.fromEntries(now.large),
      incomplete: now.incomplete,
    };
    mkdirSync(this.manifests, { recursive: true });
    const path = join(this.manifests, `${id}.json`);
    writeFileSync(`${path}.tmp`, JSON.stringify(checkpoint));
    renameSync(`${path}.tmp`, path);
    return checkpoint;
  }

  load(id: string): Checkpoint | undefined {
    if (!ID.test(id)) return undefined;
    try {
      const checkpoint = JSON.parse(
        readFileSync(join(this.manifests, `${id}.json`), 'utf8'),
      ) as Partial<Checkpoint> | null;
      if (
        !checkpoint ||
        checkpoint.id !== id ||
        !Number.isFinite(checkpoint.at) ||
        !checkpoint.files ||
        typeof checkpoint.files !== 'object' ||
        Array.isArray(checkpoint.files) ||
        !checkpoint.large ||
        typeof checkpoint.large !== 'object' ||
        Array.isArray(checkpoint.large) ||
        (checkpoint.incomplete !== undefined && typeof checkpoint.incomplete !== 'boolean') ||
        Object.keys(checkpoint.files).length + Object.keys(checkpoint.large).length > MAX_FILES
      )
        return undefined;
      for (const [path, content] of Object.entries(checkpoint.files)) {
        if (isAbsolute(path) || typeof content !== 'string' || !HASH.test(content))
          return undefined;
        this.inside(path);
      }
      for (const [path, signature] of Object.entries(checkpoint.large)) {
        if (isAbsolute(path) || typeof signature !== 'string' || signature.length > 128)
          return undefined;
        this.inside(path);
      }
      return checkpoint as Checkpoint;
    } catch {
      return undefined;
    }
  }

  /** Reconstruct recorded regular files in a fresh, extension-owned directory. */
  materialize(checkpoint: Checkpoint, destination: string): void {
    if (checkpoint.incomplete || Object.keys(checkpoint.large).length > 0) {
      throw new Error('Checkpoint has unrecorded files or symbolic links');
    }
    for (const [path, id] of Object.entries(checkpoint.files)) {
      const target = resolve(destination, path);
      const rel = relative(destination, target);
      if (!rel || rel.startsWith('..') || isAbsolute(rel))
        throw new Error('Invalid checkpoint path');
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, this.content(id));
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
    for (const [path, file] of now.files) {
      // Too large to record before: it existed, so it is neither added nor revertible.
      if (checkpoint.large[path] !== undefined) uncovered.add(path);
      else if (checkpoint.files[path] !== file.hash) {
        // Only a file whose hash changed is read, if it was not already.
        const content = file.content ?? this.fileContent(path);
        if (!content) return null;
        change(path, checkpoint.files[path] ?? null, content);
      }
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

  /** The folder's text files now, by path, for who depends on what (ADR 0032); empty when unreadable. */
  texts(): Map<string, string> {
    const now = this.read();
    const out = new Map<string, string>();
    for (const [path, file] of now?.files ?? []) {
      const content = file.content ?? this.fileContent(path);
      if (content && !isBinary(content)) out.set(path, content.toString('utf8'));
    }
    return out;
  }

  /**
   * The runtime's checks on what changed since the checkpoint (ADR 0030, 0032),
   * as the facts' text; null when the folder cannot be read.
   */
  diffChecks(checkpoint: Checkpoint): string | null {
    const review = this.review(checkpoint);
    if (!review) return null;
    const text = (hash: string | null) =>
      hash === null ? null : this.content(hash).toString('utf8');
    const changed: TextChange[] = review.files
      .filter((file) => !file.binary)
      .map((file) => ({ path: file.path, before: text(file.before), after: text(file.after) }));
    return [
      shortcutFacts(changed, review.uncovered),
      riskFact(assessRisk(changed, this.texts())),
    ].join('\n');
  }

  /** The file's content hash now; null when it does not exist. */
  current(path: string): string | null {
    const full = this.inside(path);
    return existsSync(full) ? sha256(readFileSync(full)) : null;
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
