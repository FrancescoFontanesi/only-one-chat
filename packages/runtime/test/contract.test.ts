// The contract between the roles (ADR 0031, 0035), on the structured handoffs.

import { describe, expect, it } from 'vitest';
import {
  changedFiles,
  checkReport,
  checkReview,
  contractFacts,
  criteriaOf,
  type Report,
  type Review,
} from '../src/index.js';

const brief = [
  '## Goal',
  'round(x) and round(x, n).',
  '## Acceptance criteria',
  'Input → expected result:',
  '- C1. `round(2.4)` → `2`',
  '- C2. `round(2.5)` → `2`',
  'C3. Error for `round(1, -1)`; see also C1.',
  '- **C4.** `python -m unittest` passes.',
  '## Scope',
  'C9 is not a criterion here.',
].join('\n');

const facts = [
  'Files changed since the start of the request:',
  '- modified evaluator.py',
  '- added tests\\test_round.py',
  '',
  'Verification run by the runtime: python -m unittest → exit 0',
].join('\n');

const verified = (ids: string[]) =>
  ids.map((id) => ({ id, status: 'verified' as const, evidence: 'test_round' }));

const report = (over: Partial<Report> = {}): Report => ({
  outcome: 'done',
  summary: 'round added.',
  changes: [
    { path: 'evaluator.py', change: 'round' },
    { path: 'tests/test_round.py', change: 'tests' },
  ],
  criteria: verified(['C1', 'C2', 'C3', 'C4']),
  ...over,
});

describe('the criteria of a brief', () => {
  it('reads them as each line of the acceptance criteria opens, and only there', () => {
    expect(criteriaOf(brief)).toEqual(['C1', 'C2', 'C3', 'C4']);
    expect(criteriaOf('## Acceptance criteria\n1. C1 nothing\nC2. ok')).toEqual(['C2']);
    expect(criteriaOf('## Goal\nC1. x')).toEqual([]);
  });

  it('reads the numbering the runtime writes, and a draft kept in Italian', () => {
    expect(criteriaOf('## Acceptance criteria\n\n- C1 — a\n  more of a\n- C2 — b')).toEqual([
      'C1',
      'C2',
    ]);
    expect(criteriaOf('## Criteri di accettazione\nC1. x')).toEqual(['C1']);
  });

  it('reads the files the runtime saw change, with forward slashes', () => {
    expect(changedFiles(facts)).toEqual(['evaluator.py', 'tests/test_round.py']);
  });
});

describe('checkReport', () => {
  it('has nothing to say about a report that keeps the contract', () => {
    expect(checkReport(brief, report(), facts)).toEqual([]);
  });

  it('says there is no report when there is none', () => {
    expect(checkReport(brief, null, facts)).toEqual([
      { code: 'no-report', message: 'the implementer did not call the report tool.' },
    ]);
  });

  it('names the criteria the report leaves out, and the files it leaves out', () => {
    expect(
      checkReport(
        brief,
        report({
          criteria: verified(['C1', 'C2']),
          changes: [{ path: 'evaluator.py', change: 'x' }],
        }),
        facts,
      ),
    ).toEqual([
      { code: 'criteria-missing', message: 'the report does not say how C3, C4 went.' },
      {
        code: 'files-undeclared',
        message: 'files changed that the report does not list in changes: tests/test_round.py.',
      },
    ]);
  });

  it('matches the paths however the report writes them', () => {
    const changes = [
      { path: '@evaluator.py', change: 'x' },
      { path: 'F:\\work\\tests\\test_round.py', change: 'y' },
    ];
    expect(checkReport(brief, report({ changes }), facts)).toEqual([]);
  });

  it('finds an outcome that its own criteria contradict', () => {
    const criteria = [
      ...verified(['C1', 'C2', 'C3']),
      { id: 'C4', status: 'not_verified' as const, evidence: 'no commands' },
    ];
    expect(checkReport(brief, report({ criteria }), facts)).toEqual([
      {
        code: 'outcome-incoherent',
        message: 'the outcome is "done" but these criteria are not verified: C4.',
      },
    ]);
    // "partial" with something unverified is what it should be.
    expect(checkReport(brief, report({ criteria, outcome: 'partial' }), facts)).toEqual([]);
  });

  it('finds a done outcome that still blocks on a decision, and accepts "none" for that', () => {
    expect(checkReport(brief, report({ blocked_on: 'Which rounding mode?' }), facts)).toEqual([
      {
        code: 'outcome-incoherent',
        message: 'the outcome is "done" but "blocked_on" asks for a decision.',
      },
    ]);
    for (const none of ['', 'None', 'none.', 'nessuno', 'n/a']) {
      expect(checkReport(brief, report({ blocked_on: none }), facts)).toEqual([]);
    }
  });
});

const review = (over: Partial<Review> = {}): Review => ({
  verdict: 'approved',
  summary: 'one round.',
  criteria: verified(['C1', 'C2', 'C3', 'C4']),
  axes: { honesty: 'clean', security: 'clean', currency: 'clean' },
  ...over,
});

describe('checkReview', () => {
  it('keeps an approval that rests on every criterion verified and every axis clean', () => {
    expect(checkReview(brief, review())).toEqual({ verdict: 'approved', issues: [] });
  });

  it('lowers an approval with a criterion not verified, or an axis in doubt, to with_reservations', () => {
    const checked = checkReview(
      brief,
      review({
        criteria: [
          ...verified(['C1', 'C2', 'C3']),
          { id: 'C4', status: 'not_verified', evidence: 'read-only session' },
        ],
        axes: { honesty: 'clean', security: 'doubtful', currency: 'clean' },
      }),
    );
    expect(checked.verdict).toBe('with_reservations');
    expect(checked.issues).toEqual([
      {
        code: 'verdict-lowered',
        message:
          'the reviewer wrote "approved", the runtime keeps it as "with_reservations": C4 not verified; doubtful on security.',
      },
    ]);
  });

  it('lowers an approval to rejected with an axis failed or a blocking finding open', () => {
    expect(
      checkReview(
        brief,
        review({ axes: { honesty: 'bypassed', security: 'clean', currency: 'clean' } }),
      ).verdict,
    ).toBe('rejected');
    expect(
      checkReview(
        brief,
        review({ axes: { honesty: 'clean', security: 'clean', currency: 'outdated' } }),
      ).verdict,
    ).toBe('rejected');
    expect(
      checkReview(
        brief,
        review({ open_findings: [{ id: 'R1', severity: 'blocking', issue: 'null byte' }] }),
      ).verdict,
    ).toBe('rejected');
    expect(
      checkReview(
        brief,
        review({ open_findings: [{ id: 'R2', severity: 'minor', issue: 'a name' }] }),
      ).verdict,
    ).toBe('with_reservations');
  });

  it('names the criteria a review leaves out, lowers an approval for them, and keeps other verdicts', () => {
    expect(
      checkReview(brief, review({ verdict: 'with_reservations', criteria: verified(['C1']) })),
    ).toEqual({
      verdict: 'with_reservations',
      issues: [
        { code: 'criteria-missing', message: 'the review does not say how C2, C3, C4 went.' },
      ],
    });
    const lowered = checkReview(brief, review({ criteria: verified(['C1', 'C2', 'C3']) }));
    expect(lowered.verdict).toBe('with_reservations');
    expect(lowered.issues.map((i) => i.code)).toEqual(['criteria-missing', 'verdict-lowered']);
    expect(lowered.issues[1]?.message).toContain('C4 not cited');
  });
});

describe('contractFacts', () => {
  it('is empty with nothing to say, a list of facts otherwise', () => {
    expect(contractFacts('Checks on the report', [])).toBe('');
    expect(
      contractFacts('Checks on the report', [{ code: 'no-report', message: 'missing.' }]),
    ).toBe('Checks on the report, made by the runtime:\n- missing.');
  });
});
