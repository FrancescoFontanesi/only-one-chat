import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CheckpointStore } from '../../src/session/checkpoints.js';
import { snapshot } from '../../src/session/facts.js';
import { ignoredPaths } from '../../src/session/ignore.js';

describe('paths left out, written as in a .gitignore (ADR 0021)', () => {
  it('matches a name at any depth, a folder only with a trailing slash', () => {
    const ignored = ignoredPaths(['graft/', '*.log', '# a comment', '']);
    expect(ignored('graft', true)).toBe(true);
    expect(ignored('tools/graft', true)).toBe(true);
    expect(ignored('graft', false)).toBe(false);
    expect(ignored('build/out.log', false)).toBe(true);
    expect(ignored('src/app.ts', false)).toBe(false);
  });

  it('anchors a pattern with a slash to the folder; ** spans folders', () => {
    const ignored = ignoredPaths(['/cache', 'docs/*.tmp', 'a/**/z.txt', '!keep']);
    expect(ignored('cache', true)).toBe(true);
    expect(ignored('src/cache', true)).toBe(false);
    expect(ignored('docs/x.tmp', false)).toBe(true);
    expect(ignored('docs/sub/x.tmp', false)).toBe(false);
    expect(ignored('a/z.txt', false)).toBe(true);
    expect(ignored('a/b/c/z.txt', false)).toBe(true);
    expect(ignored('keep', false)).toBe(false);
  });

  it('ignores nothing without patterns, or with only a slash', () => {
    expect(ignoredPaths([])('anything', false)).toBe(false);
    expect(ignoredPaths(['/', '  '])('anything', true)).toBe(false);
  });
});

describe('the facts and the checkpoints leave them out', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('records neither a tool’s cache folder nor an ignored file', () => {
    dir = mkdtempSync(join(tmpdir(), 'ooc-ignore-'));
    const cwd = join(dir, 'work');
    mkdirSync(join(cwd, 'graft', '.cache'), { recursive: true });
    writeFileSync(join(cwd, 'graft', '.cache', 'index'), 'x');
    writeFileSync(join(cwd, 'calc.py'), 'print(1)');
    writeFileSync(join(cwd, 'run.log'), 'log');
    const ignored = ignoredPaths(['graft/', '*.log']);

    const files = snapshot(cwd, ignored);
    expect(files === 'unavailable' ? [] : [...files.keys()]).toEqual(['calc.py']);

    const store = new CheckpointStore(join(dir, 'store'), cwd, ignored);
    expect(Object.keys(store.take('c1')?.files ?? {})).toEqual(['calc.py']);
  });
});
