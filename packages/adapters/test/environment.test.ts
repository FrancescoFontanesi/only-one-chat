import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { longPath } from '../src/environment.js';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'long-path '));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('longPath (ADR 0046)', () => {
  it('resolves another form of the same folder to the one the system names', () => {
    mkdirSync(join(root, 'sub'));
    const other = join(root, 'sub', '..');
    expect(longPath(other)).toBe(realpathSync.native(root));
    expect(longPath(other)).not.toContain('..');
  });

  it('gives back a path that does not exist as it was given', () => {
    const missing = join(root, 'missing', 'folder');
    expect(longPath(missing)).toBe(missing);
  });
});
