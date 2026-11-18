// The checks on the diff (ADR 0030): what shows as a shortcut, and what does not.

import { describe, expect, it } from 'vitest';
import { shortcutFacts, shortcutFlags } from '../../src/session/shortcuts.js';

const tests = (cases: number, asserts = cases) =>
  [
    ...Array.from({ length: cases }, (_, i) => `it('caso ${String(i)}', () => {`),
    ...Array.from({ length: asserts }, () => '  expect(f()).toBe(1);'),
  ].join('\n');

describe('shortcutFlags', () => {
  it('flags a test file removed, and test cases or assertions that went down', () => {
    expect(
      shortcutFlags([
        { path: 'test/a.test.ts', before: tests(3), after: null },
        { path: 'test/b.test.ts', before: tests(4, 8), after: tests(3, 8) },
        { path: 'test/c.test.ts', before: tests(4, 8), after: tests(4, 5) },
        { path: 'tests/test_d.py', before: 'def test_a(): assert 1', after: 'def test_a(): pass' },
      ]),
    ).toEqual([
      'test eliminato: test/a.test.ts',
      'test/b.test.ts: casi di test da 4 a 3',
      'test/c.test.ts: asserzioni da 8 a 5',
      'tests/test_d.py: asserzioni da 1 a 0',
    ]);
  });

  it('flags tests skipped or isolated, only the ones added', () => {
    const skipped = "it.skip('x', () => {});\nxit('y', () => {});\ndescribe.only('z', () => {});";
    expect(
      shortcutFlags([
        { path: 'src/a.test.ts', before: "it('x', () => {});", after: skipped },
        {
          path: 'src/b.test.ts',
          before: 'it.skip("old", () => {});',
          after: 'it.skip("old", () => {});',
        },
        { path: 'src/c_test.py', before: null, after: '@pytest.mark.skip\ndef test_c(): pass' },
      ]),
    ).toEqual([
      'src/a.test.ts: test saltati o isolati (skip, only) aggiunti: 3',
      'src/c_test.py: test saltati o isolati (skip, only) aggiunti: 1',
    ]);
  });

  it('flags checks switched off in any file, only the ones added', () => {
    expect(
      shortcutFlags([
        {
          path: 'src/a.ts',
          before: 'const a = 1;',
          after: '// eslint-disable-next-line\nconst a = x as any;',
        },
        { path: 'src/b.ts', before: '// @ts-ignore\nx();', after: '// @ts-ignore\nx();' },
        { path: 'src/c.py', before: null, after: 'import y  # type: ignore' },
      ]),
    ).toEqual([
      'src/a.ts: controlli disattivati o tipi forzati aggiunti: 2',
      'src/c.py: controlli disattivati o tipi forzati aggiunti: 1',
    ]);
  });

  it('flags the lockfile and the files that set what is checked', () => {
    expect(
      shortcutFlags([
        { path: 'pnpm-lock.yaml', before: 'a', after: 'b' },
        { path: 'apps/vscode/tsconfig.json', before: '{}', after: '{"strict": false}' },
        { path: '.github/workflows/ci.yml', before: 'a', after: 'b' },
        { path: 'eslint.config.mjs', before: 'a', after: 'b' },
        { path: 'src/main.ts', before: 'a', after: 'b' },
      ]),
    ).toEqual([
      'lockfile cambiato: pnpm-lock.yaml',
      'configurazione dei controlli cambiata: apps/vscode/tsconfig.json',
      'configurazione dei controlli cambiata: .github/workflows/ci.yml',
      'configurazione dei controlli cambiata: eslint.config.mjs',
    ]);
  });

  it('has nothing to say about a new test, tests added, or ordinary code', () => {
    expect(
      shortcutFlags([
        { path: 'test/new.test.ts', before: null, after: tests(2) },
        { path: 'test/old.test.ts', before: tests(2), after: tests(3) },
        { path: 'src/main.ts', before: 'a', after: 'b' },
        { path: 'README.md', before: null, after: 'x' },
      ]),
    ).toEqual([]);
  });
});

describe('shortcutFacts', () => {
  it('says so when there is nothing to flag, and what it could not check', () => {
    expect(shortcutFacts([])).toBe(
      'Controlli sul diff, fatti dal runtime (segnalazioni da verificare, non prove):\n- nessuna segnalazione',
    );
    expect(shortcutFacts([{ path: 'pnpm-lock.yaml', before: 'a', after: 'b' }], ['big.log'])).toBe(
      [
        'Controlli sul diff, fatti dal runtime (segnalazioni da verificare, non prove):',
        '- lockfile cambiato: pnpm-lock.yaml',
        'Non controllati, troppo grandi: big.log',
      ].join('\n'),
    );
  });
});
