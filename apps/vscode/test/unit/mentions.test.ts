import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_EXCERPT_LINES, expandMentions } from '../../src/session/mentions.js';
import { matchPaths, mentionAt, pickMention } from '../../webview/mentions.js';

let root: string;
let cwd: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mentions '));
  cwd = join(root, 'workspace');
  mkdirSync(join(cwd, 'src'), { recursive: true });
  writeFileSync(join(cwd, 'src', 'calc.py'), ['a = 1', 'b = 2', 'c = 3', 'd = 4'].join('\n'));
  writeFileSync(join(root, 'secret.txt'), 'outside');
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('mentions in a message (ADR 0015)', () => {
  it('names files and folders as paths, and includes a short range of lines', () => {
    const expanded = expandMentions('guarda @src/calc.py#L2-3 e la cartella @src/, grazie', cwd);
    expect(expanded.mentions).toEqual([
      { path: 'src/calc.py', kind: 'file', lines: { from: 2, to: 3 } },
      { path: 'src/', kind: 'folder' },
    ]);
    expect(expanded.attachments).toContain('- src/calc.py, righe 2-3:\n```py\nb = 2\nc = 3\n```');
    expect(expanded.attachments).toContain('- src/ (cartella)');
  });

  it('names a long range without copying it', () => {
    const lines = Array.from({ length: MAX_EXCERPT_LINES + 10 }, (_, i) => `x${String(i)}`);
    writeFileSync(join(cwd, 'big.py'), lines.join('\n'));
    const expanded = expandMentions(`@big.py#L1-${String(MAX_EXCERPT_LINES + 5)}`, cwd);
    expect(expanded.attachments).toContain('troppe per includerle');
    expect(expanded.attachments).not.toContain('x3');
  });

  it('leaves alone what is not a file of the folder: @impl, outside paths, other words', () => {
    const expanded = expandMentions(
      '@impl aggiungi @../secret.txt e scrivi a mario@example.com, poi @nonesiste.py',
      cwd,
    );
    expect(expanded.mentions).toEqual([]);
    expect(expanded.attachments).toBe('');
  });
});

describe('the composer’s @ list', () => {
  it('finds the @ word at the caret', () => {
    expect(mentionAt('vedi @src/ca', 12)).toEqual({ start: 5, query: 'src/ca' });
    expect(mentionAt('mail a@b', 8)).toBeNull();
    expect(mentionAt('@', 1)).toEqual({ start: 0, query: '' });
  });

  it('ranks the file name first, then the path', () => {
    const paths = ['docs/calc-notes.md', 'src/', 'src/calc.py', 'tests/test_calc.py'];
    expect(matchPaths(paths, 'calc')).toEqual([
      'src/calc.py',
      'docs/calc-notes.md',
      'tests/test_calc.py',
    ]);
    expect(matchPaths(paths, 'src')).toEqual(['src/', 'src/calc.py']);
  });

  it('replaces the @ word with the chosen path', () => {
    expect(pickMention('vedi @ca e poi', { start: 5, query: 'ca' }, 'src/calc.py')).toEqual({
      text: 'vedi @src/calc.py e poi',
      caret: 18,
    });
    // A folder leaves the caret after the slash, to go on with a file in it.
    expect(pickMention('@sr', { start: 0, query: 'sr' }, 'src/')).toEqual({
      text: '@src/',
      caret: 5,
    });
  });
});
