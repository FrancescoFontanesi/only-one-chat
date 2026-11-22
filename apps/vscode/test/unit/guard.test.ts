// The reviewer never changes the code it judges (ADR 0029): what it changes
// outside the tests is put back after its turn.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CheckpointStore } from '../../src/session/checkpoints.js';
import { guardReviewerTurn } from '../../src/session/guard.js';

let root: string;
let cwd: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'guard '));
  cwd = join(root, 'workspace');
  mkdirSync(join(cwd, 'tests'), { recursive: true });
  writeFileSync(join(cwd, 'main.py'), 'def f():\n    return 1\n');
  writeFileSync(join(cwd, 'tests', 'test_main.py'), 'def test_f(): assert f() == 1\n');
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('guardReviewerTurn', () => {
  it('keeps the tests the reviewer wrote and puts back the code it changed', () => {
    const store = new CheckpointStore(join(root, 'checkpoints'), cwd);
    const undo = guardReviewerTurn(store, 'rev-1');
    // The reviewer's turn: a new test, a case added, and a "fix" it had no right to make.
    writeFileSync(join(cwd, 'tests', 'test_nul.py'), 'def test_nul(): ...\n');
    writeFileSync(
      join(cwd, 'tests', 'test_main.py'),
      'def test_f(): assert f() == 1\ndef test_g(): ...\n',
    );
    writeFileSync(join(cwd, 'main.py'), 'def f():\n    return 2\n');
    writeFileSync(join(cwd, 'scratch.txt'), 'appunti');
    expect(undo?.()).toBe(
      [
        'The runtime restored non-test files changed by the reviewer: main.py, scratch.txt.',
        'The reviewer kept test files: tests/test_main.py, tests/test_nul.py.',
      ].join('\n'),
    );
    expect(readFileSync(join(cwd, 'main.py'), 'utf8')).toBe('def f():\n    return 1\n');
    expect(existsSync(join(cwd, 'scratch.txt'))).toBe(false);
    expect(existsSync(join(cwd, 'tests', 'test_nul.py'))).toBe(true);
    expect(readFileSync(join(cwd, 'tests', 'test_main.py'), 'utf8')).toContain('test_g');
  });

  it('names the tests it kept when the reviewer only wrote tests', () => {
    const store = new CheckpointStore(join(root, 'checkpoints'), cwd);
    const undo = guardReviewerTurn(store, 'rev-2');
    writeFileSync(join(cwd, 'tests', 'test_more.py'), 'def test_more(): ...\n');
    expect(undo?.()).toBe('The reviewer kept test files: tests/test_more.py.');
  });
});
