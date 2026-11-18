// The risk of a change (ADR 0032): what makes it low, medium or high.

import { describe, expect, it } from 'vitest';
import { assessRisk, fanIn, riskFact } from '../../src/session/risk.js';

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
    expect(risk.level).toBe('basso');
    expect(risk.reasons[0]).toBe('1 file di codice, 6 righe cambiate');
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
    expect(risk.level).toBe('alto');
    expect(risk.reasons).toContain('nessun test cambiato');
    expect(risk.reasons).toContain('3 cartelle');
  });

  it('code that touches what an attacker controls is high, whatever its size', () => {
    const risk = assessRisk(
      [{ path: 'main.py', before: 'a = 1', after: 'a = 1\nsubprocess.run(cmd, shell=True)' }],
      new Map(),
    );
    expect(risk.level).toBe('alto');
    expect(risk.reasons).toContain('tocca comandi');
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
    expect(risk.level).toBe('medio');
    expect(risk.reasons.at(-1)).toBe('1 segnalazioni dei controlli sul diff');
  });

  it('counts only the sensitive calls the change adds', () => {
    const before = 'with open(path) as f:\n    pass';
    const risk = assessRisk([{ path: 'io.py', before, after: `${before}\nx = 1` }], new Map());
    expect(risk.level).toBe('basso');
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
  it('writes the level, the score with a comma, and the reasons', () => {
    expect(
      riskFact({ level: 'medio', score: 0.31, reasons: ['2 file di codice, 50 righe cambiate'] }),
    ).toBe(
      'Rischio della modifica, stimato dal runtime: medio (0,31) — 2 file di codice, 50 righe cambiate.',
    );
  });
});
