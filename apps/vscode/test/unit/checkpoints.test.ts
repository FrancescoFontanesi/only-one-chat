import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CheckpointStore, MAX_FILE_BYTES, lineCounts } from '../../src/session/checkpoints.js';

let root: string;
let cwd: string;
let store: CheckpointStore;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'checkpoints '));
  cwd = join(root, 'workspace');
  mkdirSync(join(cwd, 'src'), { recursive: true });
  store = new CheckpointStore(join(root, 'storage'), cwd);
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('line counts', () => {
  it('counts the lines added and removed', () => {
    expect(lineCounts('a\nb\nc', 'a\nB\nc\nd')).toEqual({ added: 2, removed: 1 });
    expect(lineCounts('', 'x\ny')).toEqual({ added: 2, removed: 0 });
    expect(lineCounts('x\r\ny', 'x\ny')).toEqual({ added: 0, removed: 0 });
  });
});

describe('checkpoints (ADR 0014)', () => {
  it('lists what a message changed, and puts each file back as it was', () => {
    writeFileSync(join(cwd, 'calc.py'), 'def add(a, b):\n    return a + b\n');
    writeFileSync(join(cwd, 'src', 'old.py'), 'x = 1\n');
    writeFileSync(join(cwd, 'logo.bin'), Buffer.from([0, 1, 2]));
    const checkpoint = store.take('ckpt-1');
    if (!checkpoint) throw new Error('no checkpoint');

    writeFileSync(
      join(cwd, 'calc.py'),
      'def add(a, b):\n    return a + b\n\ndef sub(a, b):\n    return a - b\n',
    );
    writeFileSync(join(cwd, 'src', 'new.py'), 'y = 2\n');
    rmSync(join(cwd, 'src', 'old.py'));
    writeFileSync(join(cwd, 'logo.bin'), Buffer.from([0, 9]));

    const review = store.review(checkpoint);
    expect(review?.files.map((f) => [f.path, f.kind, f.added, f.removed, f.binary])).toEqual([
      ['calc.py', 'modified', 3, 0, false],
      ['logo.bin', 'modified', 0, 0, true],
      ['src/new.py', 'added', 1, 0, false],
      ['src/old.py', 'deleted', 0, 1, false],
    ]);
    // The contents after the message are recorded too, for the diff.
    const calc = review?.files[0];
    expect(calc?.after && store.content(calc.after).toString()).toContain('def sub');

    const added = review?.files.find((f) => f.path === 'src/new.py');
    store.put('src/new.py', added?.before ?? null);
    expect(existsSync(join(cwd, 'src', 'new.py'))).toBe(false);

    expect(store.restore(checkpoint)).toEqual(['calc.py', 'logo.bin', 'src/old.py']);
    expect(readFileSync(join(cwd, 'calc.py'), 'utf8')).not.toContain('def sub');
    expect(readFileSync(join(cwd, 'src', 'old.py'), 'utf8')).toBe('x = 1\n');
    expect(store.review(checkpoint)?.files).toEqual([]);
  });

  it('keeps each content once, and reads a checkpoint back by its id', () => {
    writeFileSync(join(cwd, 'a.txt'), 'same');
    writeFileSync(join(cwd, 'b.txt'), 'same');
    const checkpoint = store.take('ckpt-2', 42);
    expect(checkpoint?.files['a.txt']).toBe(checkpoint?.files['b.txt']);
    expect(store.load('ckpt-2')).toEqual(checkpoint);
    expect(store.load('../ckpt-2')).toBeUndefined();
  });

  it('names the large files it cannot put back, and never deletes one', () => {
    writeFileSync(join(cwd, 'big.dat'), Buffer.alloc(MAX_FILE_BYTES + 1));
    const checkpoint = store.take('ckpt-3');
    if (!checkpoint) throw new Error('no checkpoint');
    writeFileSync(join(cwd, 'big.dat'), 'small now');
    const review = store.review(checkpoint);
    expect(review?.files).toEqual([]);
    expect(review?.uncovered).toEqual(['big.dat']);
    store.restore(checkpoint);
    expect(readFileSync(join(cwd, 'big.dat'), 'utf8')).toBe('small now');
  });

  it('refuses a path outside the folder', () => {
    expect(() => {
      store.put('../outside.txt', null);
    }).toThrow(/outside the folder/);
    expect(() => store.current('../../etc/passwd')).toThrow(/outside the folder/);
  });
});
