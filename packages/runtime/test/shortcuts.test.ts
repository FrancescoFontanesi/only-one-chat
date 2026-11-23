// The checks on the diff (ADR 0030): what shows as a shortcut, and what does not.

import { describe, expect, it } from 'vitest';
import { shortcutFacts, shortcutFlags } from '../src/shortcuts.js';

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
      'test removed: test/a.test.ts',
      'test/b.test.ts: test cases reduced from 4 to 3',
      'test/c.test.ts: assertions reduced from 8 to 5',
      'tests/test_d.py: assertions reduced from 1 to 0',
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
      'src/a.test.ts: new skipped or isolated tests (skip, only): 3',
      'src/c_test.py: new skipped or isolated tests (skip, only): 1',
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
      'src/a.ts: new check suppressions or type overrides: 2',
      'src/c.py: new check suppressions or type overrides: 1',
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
      'lockfile changed: pnpm-lock.yaml',
      'check configuration changed: apps/vscode/tsconfig.json',
      'check configuration changed: .github/workflows/ci.yml',
      'check configuration changed: eslint.config.mjs',
    ]);
  });

  it('flags assertions that compare an expression with itself, only the ones added', () => {
    const flagged = (before: string | null, after: string, path = 'tests/test_a.py') =>
      shortcutFlags([{ path, before, after }]);
    const message = (n: number, path = 'tests/test_a.py') =>
      `${path}: assertions that compare an expression with itself: ${String(n)}`;
    expect(flagged(null, 'self.assertEqual(total(a, 2), total(a, 2))')).toEqual([message(1)]);
    expect(flagged('x = 1', 'self.assertIs( f(x) ,f(x) )\nassert g(1) == g(1), "same"')).toEqual([
      message(2),
    ]);
    expect(flagged(null, 'expect(f(1, [2])).toBe(f(1, [2]));', 'src/a.test.ts')).toEqual([
      message(1, 'src/a.test.ts'),
    ]);
    expect(
      flagged(null, 'expect(x).toEqual(x);\nexpect(y).toStrictEqual( y );', 'a.spec.ts'),
    ).toEqual([message(2, 'a.spec.ts')]);
    expect(
      flagged('self.assertEqual(x, x)', 'self.assertEqual(x, x)\nself.assertEqual(y, y)'),
    ).toEqual([message(1)]);
  });

  it('has nothing to say about assertions that compare different things', () => {
    const after = [
      'self.assertEqual(total(a), "0.05")',
      'self.assertEqual(f(a, b), f(a, c), "message")',
      'self.assertIn(total(a), ("0.05", "0.06"))',
      'self.assertIn(x, (x, y))',
      'self.assertEqual(f((1, 2)), f((1, 3)))',
      'self.assertEqual(f(","), f(")"))',
      'assert a == b',
      'assert a == b, "a == a"',
      'expect(f(1)).toBe(f(2));',
      'expect(x).not.toBe(x);',
      'expect(x).toBeDefined();',
      `x = 1; self.assertEqual(${'a'.repeat(500)}, ${'a'.repeat(500)})`,
    ].join('\n');
    expect(shortcutFlags([{ path: 'tests/test_a.py', before: null, after }])).toEqual([]);
    // Not a test file.
    expect(shortcutFlags([{ path: 'src/a.py', before: null, after: 'assert x == x' }])).toEqual([]);
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
    expect(shortcutFacts([])).toBe('Runtime diff checks (flags for review):\n- no flags');
    expect(shortcutFacts([{ path: 'pnpm-lock.yaml', before: 'a', after: 'b' }], ['big.log'])).toBe(
      [
        'Runtime diff checks (flags for review):',
        '- lockfile changed: pnpm-lock.yaml',
        'Skipped because they were too large: big.log',
      ].join('\n'),
    );
  });
});
