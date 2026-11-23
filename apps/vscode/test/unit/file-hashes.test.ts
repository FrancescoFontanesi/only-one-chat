import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CheckpointStore } from '../../src/session/checkpoints.js';
import { changes, snapshot } from '../../src/session/facts.js';
import { FileHashes, MAX_FILE_BYTES } from '../../src/session/file-hashes.js';

let root: string;
let cwd: string;
let reads: string[];
let hashes: FileHashes;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'file-hashes '));
  cwd = join(root, 'workspace');
  mkdirSync(cwd);
  reads = [];
  hashes = new FileHashes((path) => {
    reads.push(path);
    return readFileSync(path);
  });
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A file last modified an hour ago, so the cache may trust it. */
function oldFile(name: string, content: string | Buffer): string {
  const path = join(cwd, name);
  writeFileSync(path, content);
  const past = Date.now() / 1000 - 3600;
  utimesSync(path, past, past);
  return path;
}

describe('stat cache (ADR 0047)', () => {
  it('does not read an unchanged old file again, and reads it when its size changes', () => {
    const path = oldFile('a.txt', 'one');
    const first = snapshot(cwd, undefined, hashes);
    expect(snapshot(cwd, undefined, hashes)).toEqual(first);
    expect(reads).toEqual([path]);
    writeFileSync(path, 'three');
    expect(changes(first, snapshot(cwd, undefined, hashes))).toEqual(['modified a.txt']);
    expect(reads).toEqual([path, path]);
  });

  it('detects an edit of the same size made within 2 seconds', () => {
    const path = join(cwd, 'a.txt');
    writeFileSync(path, 'aaaa');
    const before = snapshot(cwd, undefined, hashes);
    writeFileSync(path, 'bbbb');
    expect(changes(before, snapshot(cwd, undefined, hashes))).toEqual(['modified a.txt']);
  });

  it('hashes again a file whose mtime lies in the future', () => {
    const path = join(cwd, 'a.txt');
    const future = Date.now() / 1000 + 3600;
    writeFileSync(path, 'aaaa');
    utimesSync(path, future, future);
    const before = snapshot(cwd, undefined, hashes);
    writeFileSync(path, 'bbbb');
    utimesSync(path, future, future);
    expect(changes(before, snapshot(cwd, undefined, hashes))).toEqual(['modified a.txt']);
    expect(reads).toHaveLength(2);
  });

  it('never reads a file over 2 MiB: its size and mtime stand for it', () => {
    const path = oldFile('big.dat', Buffer.alloc(MAX_FILE_BYTES + 1));
    const before = snapshot(cwd, undefined, hashes);
    expect(before === 'unavailable' ? '' : before.get('big.dat')).toMatch(/^large:/);
    writeFileSync(path, Buffer.alloc(MAX_FILE_BYTES + 2));
    expect(changes(before, snapshot(cwd, undefined, hashes))).toEqual(['modified big.dat']);
    rmSync(path);
    expect(changes(before, snapshot(cwd, undefined, hashes))).toEqual(['deleted big.dat']);
    expect(reads).toEqual([]);
  });

  it('sees a file removed and a file renamed', () => {
    oldFile('a.txt', 'one');
    oldFile('b.txt', 'two');
    const before = snapshot(cwd, undefined, hashes);
    rmSync(join(cwd, 'a.txt'));
    renameSync(join(cwd, 'b.txt'), join(cwd, 'c.txt'));
    expect(changes(before, snapshot(cwd, undefined, hashes))).toEqual([
      'deleted a.txt',
      'deleted b.txt',
      'added c.txt',
    ]);
  });

  it('is shared with the checkpoints: a warm take reads nothing, a review reads what changed', () => {
    const a = oldFile('a.txt', 'one');
    const b = oldFile('b.txt', 'two');
    const store = new CheckpointStore(join(root, 'storage'), cwd, undefined, hashes);
    const first = store.take('ckpt-1');
    if (!first) throw new Error('no checkpoint');
    expect(reads.sort()).toEqual([a, b]);
    reads.length = 0;
    const second = store.take('ckpt-2');
    expect(second?.files).toEqual(first.files);
    expect(reads).toEqual([]);
    writeFileSync(b, 'twelve');
    const review = store.review(first);
    expect(review?.files.map((file) => [file.path, file.kind])).toEqual([['b.txt', 'modified']]);
    expect(reads).toEqual([b]);
  });

  it('writes again the blobs it remembered once they are gone from disk', () => {
    oldFile('a.txt', 'one');
    const storage = join(root, 'storage');
    const store = new CheckpointStore(storage, cwd, undefined, hashes);
    const checkpoint = store.take('ckpt-1');
    const id = checkpoint?.files['a.txt'] ?? '';
    // The whole blob folder removed (the chat's checkpoints deleted, storage cleaned).
    rmSync(join(storage, 'blobs'), { recursive: true });
    expect(store.take('ckpt-2')?.files).toEqual(checkpoint?.files);
    expect(store.content(id).toString()).toBe('one');
    // A single blob removed: the read fails, and the next checkpoint writes it again.
    rmSync(join(storage, 'blobs', id.slice(0, 2), id));
    expect(() => store.content(id)).toThrow();
    store.take('ckpt-3');
    expect(store.content(id).toString()).toBe('one');
  });
});
