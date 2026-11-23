import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MAX_EXCERPT_LINES,
  expandMentions,
  insideFolder,
  plainRefs,
  referenceKind,
  resolveRefs,
  withRefs,
} from '../../src/session/mentions.js';
import { ignoredPaths } from '../../src/session/ignore.js';
import { linkPath, pathCandidates, refTokens } from '../../src/shared/refs.js';
import type { ThreadUpdate } from '../../src/webview/protocol.js';
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
    expect(expanded.attachments).toContain('- src/calc.py, lines 2-3:\n```py\nb = 2\nc = 3\n```');
    expect(expanded.attachments).toContain('- src/ (folder)');
  });

  it('names a long range without copying it', () => {
    const lines = Array.from({ length: MAX_EXCERPT_LINES + 10 }, (_, i) => `x${String(i)}`);
    writeFileSync(join(cwd, 'big.py'), lines.join('\n'));
    const expanded = expandMentions(`@big.py#L1-${String(MAX_EXCERPT_LINES + 5)}`, cwd);
    expect(expanded.attachments).toContain('too many lines to include');
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

describe('@ paths in any text (ADR 0018)', () => {
  it('finds the tokens outside code, with their lines, and a closing full stop left out', () => {
    const text = [
      'Vedi @src/calc.py#L2-3 e @src/.',
      '`@param` resta testo, come in',
      '```ts',
      '@Component()',
      '```',
      'e una mail a@b.it.',
    ].join('\n');
    expect(refTokens(text).map((t) => [t.path, t.lines ?? null])).toEqual([
      ['src/calc.py', { from: 2, to: 3 }],
      ['src/', null],
    ]);
  });

  it('links what exists in the folder; a missing file is pointed out, a scoped package is not', () => {
    expect(
      resolveRefs('@src/calc.py, @src/nuovo.ts, @only-one-chat/runtime e @../secret.txt', cwd),
    ).toEqual({ found: ['src/calc.py'], missing: ['src/nuovo.ts'] });
  });

  it('turns the paths into plain paths between agents, and leaves the rest as written', () => {
    expect(
      plainRefs(
        'Cambia @src/calc.py#L2-3 e @src/calc.py#L4, non @src/nuovo.ts né `@src/calc.py`.',
        cwd,
      ),
    ).toBe(
      'Cambia src/calc.py (lines 2-3) e src/calc.py (line 4), non @src/nuovo.ts né `@src/calc.py`.',
    );
  });

  it('annotates a done turn and a delegation; a running turn is left as it is', () => {
    expect(
      withRefs(
        {
          type: 'turn',
          id: 't',
          role: 'leader',
          agent: 'C',
          status: 'done',
          text: 'Vedi @src/calc.py',
        },
        cwd,
      ),
    ).toMatchObject({ refs: ['src/calc.py'] });
    // The paths of a handoff card, in the turn that made it, are links too.
    expect(
      withRefs(
        {
          type: 'turn',
          id: 't',
          role: 'implementer',
          agent: 'C',
          status: 'done',
          text: 'Fatto.',
          handoff: { tool: 'report', text: '- @src/calc.py - round' },
        },
        cwd,
      ),
    ).toMatchObject({ refs: ['src/calc.py'] });
    const running: ThreadUpdate = {
      type: 'turn',
      id: 't',
      role: 'leader',
      agent: 'C',
      status: 'running',
      text: '@src/calc.py',
    };
    expect(withRefs(running, cwd)).toBe(running);
    expect(
      withRefs(
        {
          type: 'approval',
          id: 'a',
          kind: 'delegation',
          from: 'L',
          to: 'I',
          text: '@src/calc.py e @src/x.ts',
        },
        cwd,
      ),
    ).toMatchObject({ refs: ['src/calc.py'], missing: ['src/x.ts'] });
  });
});

describe('files an agent names without @ (ADR 0018)', () => {
  it('reads link targets and inline paths, never a web address', () => {
    expect(linkPath('file:///C:/a%20b/src/calc.py#L2-3')).toEqual({
      path: 'C:/a b/src/calc.py',
      lines: { from: 2, to: 3 },
    });
    expect(linkPath('src/calc.py:12:4')).toEqual({
      path: 'src/calc.py',
      lines: { from: 12, to: 12 },
    });
    expect(linkPath('C:\\x\\y.py')).toEqual({ path: 'C:\\x\\y.py' });
    expect(linkPath('https://example.com/a.py')).toBeNull();
    expect(linkPath('vscode:extension/x')).toBeNull();
    expect(
      pathCandidates(
        'Vedi [calc](src/calc.py), `src/calc.py:2`, `round(x)`, `cv2.inpaint` e [sito](https://x.y).',
      ),
    ).toEqual(['src/calc.py', 'src/calc.py:2', 'cv2.inpaint']);
  });

  it('links in a turn only the files of the folder, absolute paths included', () => {
    const full = join(cwd, 'src', 'calc.py').replace(/\\/g, '/');
    // As the agents write it: a URL, its spaces encoded.
    const url = `file:///${encodeURI(full)}`;
    const turn: ThreadUpdate = {
      type: 'turn',
      id: 't',
      role: 'leader',
      agent: 'a',
      status: 'done',
      text: `[calc](${url}) e \`src/calc.py\`, non [fuori](${join(root, 'secret.txt')}) né \`cv2.inpaint\`.`,
    };
    expect((withRefs(turn, cwd) as { refs?: string[] }).refs).toEqual([url, 'src/calc.py']);
    expect(insideFolder(cwd, join(root, 'secret.txt'))).toBeUndefined();
    expect(insideFolder(cwd, join(cwd, 'src'))?.folder).toBe(true);
  });
});

describe('the kind of a brief reference (ADR 0044)', () => {
  it('tells files, folders, missing and ignored paths; outside the folder is missing', () => {
    mkdirSync(join(cwd, 'vendor', 'lib'), { recursive: true });
    writeFileSync(join(cwd, 'vendor', 'lib', 'x.js'), 'x');
    writeFileSync(join(cwd, 'notes.log'), 'x');
    const kind = referenceKind(cwd, ignoredPaths(['vendor/', '*.log']));
    expect(kind('src/calc.py')).toBe('file');
    expect(kind('src')).toBe('folder');
    expect(kind('src/none.py')).toBe('missing');
    expect(kind('../secret.txt')).toBe('missing');
    expect(kind(join(root, 'secret.txt'))).toBe('missing');
    expect(kind('notes.log')).toBe('ignored');
    expect(kind('vendor/lib/x.js')).toBe('ignored');
    expect(kind('vendor')).toBe('ignored');
  });
});
