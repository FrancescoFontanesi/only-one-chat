// The risk of a change (ADR 0032): what makes it low, medium or high.

import { describe, expect, it } from 'vitest';
import { assessRisk, fanIn, riskFact } from '../src/risk.js';

const lines = (n: number, text = 'x = x + 1') => Array.from({ length: n }, () => text).join('\n');

describe('assessRisk', () => {
  it('a small change in one file, with its test, is low', () => {
    const risk = assessRisk(
      [
        { path: 'evaluator.py', before: lines(40), after: `${lines(40)}\n${lines(6, 'y = 2')}` },
        {
          path: 'test_calc.py',
          before: 'def test_a(): pass',
          after: 'def test_a(): pass\ndef test_b(): pass',
        },
      ],
      new Map(),
    );
    expect(risk.level).toBe('low');
    expect(risk.reasons[0]).toBe('1 code file, 6 changed lines');
  });

  it('a large change spread over files and folders, with branches and no test, is high', () => {
    const branchy = lines(60, 'if a and b: return c or d');
    const risk = assessRisk(
      ['src/a.py', 'src/b.py', 'lib/c.py', 'lib/d.py', 'tools/e.py'].map((path) => ({
        path,
        before: '',
        after: branchy,
      })),
      new Map(),
    );
    expect(risk.level).toBe('high');
    expect(risk.reasons).toContain('no tests changed');
    expect(risk.reasons).toContain('3 folders');
  });

  it('code that touches what an attacker controls is high, whatever its size', () => {
    const risk = assessRisk(
      [{ path: 'main.py', before: 'a = 1', after: 'a = 1\nsubprocess.run(cmd, shell=True)' }],
      new Map(),
    );
    expect(risk.level).toBe('high');
    expect(risk.reasons).toContain('touches commands');
  });

  it('a shortcut flag lifts a low change to medium', () => {
    const risk = assessRisk(
      [
        {
          path: 'test_calc.py',
          before: 'def test_a(): assert f() == 1',
          after: 'def test_a(): pass',
        },
      ],
      new Map(),
    );
    expect(risk.level).toBe('medium');
    expect(risk.reasons.at(-1)).toBe('1 diff check flag');
  });

  it('counts only the sensitive calls the change adds', () => {
    const before = 'with open(path) as f:\n    pass';
    const risk = assessRisk([{ path: 'io.py', before, after: `${before}\nx = 1` }], new Map());
    expect(risk.level).toBe('low');
  });
});

describe('fanIn', () => {
  it('counts the code files that import a changed file, not itself and not text', () => {
    const files = new Map([
      ['main.py', 'from evaluator import evaluate'],
      ['cli.py', 'import evaluator'],
      ['evaluator.py', 'import evaluator_helpers'],
      ['README.md', 'from evaluator import x'],
      ['web/app.ts', "import { e } from './evaluator.js';"],
    ]);
    expect(fanIn(['evaluator.py'], files)).toBe(3);
    expect(fanIn(['index.ts'], files)).toBe(0);
  });
});

describe('riskFact', () => {
  it('writes the level, the score with a decimal point, and the reasons', () => {
    expect(
      riskFact({ level: 'medium', score: 0.31, reasons: ['2 code files, 50 changed lines'] }),
    ).toBe('Change risk estimated by the runtime: medium (0.31) — 2 code files, 50 changed lines.');
  });
});
