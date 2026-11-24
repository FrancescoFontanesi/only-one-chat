import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CheckpointStore, MAX_FILE_BYTES } from '../../src/session/checkpoints.js';

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

  it('writes the diff checks of what changed since a checkpoint (ADR 0030, 0046)', () => {
    writeFileSync(join(cwd, 'calc.py'), 'def f(x):\n    return x\n');
    const checkpoint = store.take('ckpt-1');
    if (!checkpoint) throw new Error('no checkpoint');
    expect(store.diffChecks(checkpoint)).toContain('- no flags');

    mkdirSync(join(cwd, 'tests'));
    writeFileSync(join(cwd, 'tests', 'test_calc.py'), 'self.assertEqual(f(1), f(1))\n');
    const checks = store.diffChecks(checkpoint);
    expect(checks).toContain(
      '- tests/test_calc.py: assertions that compare an expression with itself: 1',
    );
    expect(checks).toContain('Change risk estimated by the runtime:');
  });

  it('refuses a path outside the folder', () => {
    expect(() => {
      store.put('../outside.txt', null);
    }).toThrow(/outside the folder/);
    expect(() => store.current('../../etc/passwd')).toThrow(/outside the folder/);
  });

  it('never writes or removes through a junction that leads out of the folder', () => {
    const outside = join(root, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'kept.txt'), 'theirs');
    writeFileSync(join(cwd, 'a.txt'), 'ours');
    const checkpoint = store.take('ckpt-1');
    const content = checkpoint?.files['a.txt'] ?? '';
    // A junction needs no privileges on Windows; elsewhere it is a plain directory link.
    symlinkSync(outside, join(cwd, 'link'), 'junction');
    expect(() => {
      store.put('link/pwn.txt', content);
    }).toThrow(/outside the folder/);
    expect(() => {
      store.put('link/kept.txt', null);
    }).toThrow(/outside the folder/);
    // The link itself is not followed nor replaced.
    expect(() => {
      store.put('link', content);
    }).toThrow(/outside the folder/);
    expect(existsSync(join(outside, 'pwn.txt'))).toBe(false);
    expect(readFileSync(join(outside, 'kept.txt'), 'utf8')).toBe('theirs');
    // A link that stays inside the folder still works.
    symlinkSync(join(cwd, 'src'), join(cwd, 'inner'), 'junction');
    store.put('inner/b.txt', content);
    expect(readFileSync(join(cwd, 'src', 'b.txt'), 'utf8')).toBe('ours');
  });
});
