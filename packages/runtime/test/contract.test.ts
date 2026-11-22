// The contract between the roles (ADR 0031, 0035), on the structured handoffs.

import { describe, expect, it } from 'vitest';
import {
  TURN_FILES_HEADER,
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

  it('holds a turn’s report to that turn’s files only when the facts list them (ADR 0041)', () => {
    const perTurn = [
      facts,
      '',
      TURN_FILES_HEADER,
      '- modified evaluator.py',
      '',
      'Verification run by the runtime: python -m unittest → exit 0',
    ].join('\n');
    const only = report({ changes: [{ path: 'evaluator.py', change: 'x' }] });
    expect(changedFiles(perTurn)).toEqual(['evaluator.py', 'tests/test_round.py']);
    expect(checkReport(brief, only, perTurn)).toEqual([]);
    expect(checkReport(brief, only, facts).map((i) => i.code)).toEqual(['files-undeclared']);
    expect(
      checkReport(brief, only, perTurn.replace('- modified evaluator.py\n\nVer', '- none\n\nVer')),
    ).toEqual([]);
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

describe('checkReview, coherence of every verdict (ADR 0040)', () => {
  const blocking = [{ id: 'R1', severity: 'blocking' as const, issue: 'null byte' }];
  const raised = { items: [{ severity: 'blocking' }] };

  it('lowers with_reservations to rejected with a blocking finding open or an axis failed', () => {
    const lowered = checkReview(
      brief,
      review({ verdict: 'with_reservations', open_findings: blocking }),
    );
    expect(lowered.verdict).toBe('rejected');
    expect(lowered.issues.map((i) => i.code)).toEqual(['verdict-lowered']);
    const failedAxis = review({
      verdict: 'with_reservations',
      axes: { honesty: 'clean', security: 'flaw', currency: 'clean' },
    });
    expect(checkReview(brief, failedAxis).verdict).toBe('rejected');
    const minor = [{ id: 'R2', severity: 'minor' as const, issue: 'a name' }];
    expect(
      checkReview(brief, review({ verdict: 'with_reservations', open_findings: minor })),
    ).toEqual({ verdict: 'with_reservations', issues: [] });
  });

  it('calls a rejection with no blocking finding and no failed axis incoherent, unless the turn has one', () => {
    const bare = review({ verdict: 'rejected' });
    expect(checkReview(brief, bare).issues.map((i) => i.code)).toEqual(['verdict-incoherent']);
    expect(checkReview(brief, bare, undefined, { findings: raised, roundsLeft: 1 }).issues).toEqual(
      [],
    );
    expect(
      checkReview(brief, review({ verdict: 'rejected', open_findings: blocking })).issues,
    ).toEqual([]);
  });

  it('says when a rejection with rounds left has no findings, and when findings are dropped', () => {
    const rejected = review({ verdict: 'rejected', open_findings: blocking });
    const codes = (r: Review, turn: Parameters<typeof checkReview>[3]) =>
      checkReview(brief, r, undefined, turn).issues.map((i) => i.code);
    expect(codes(rejected, { roundsLeft: 1 })).toEqual(['findings-missing']);
    expect(codes(rejected, { findings: raised, roundsLeft: 0 })).toEqual(['findings-dropped']);
    expect(codes(review(), { findings: raised, roundsLeft: 2 })).toEqual(['findings-dropped']);
  });
});

describe('references to what the runtime issued', () => {
  it('flags a criterion the brief does not number, in a report and a review', () => {
    const criteria = verified(['C1', 'C2', 'C3', 'C4', 'C7']);
    expect(checkReport(brief, report({ criteria }), facts).map((i) => i.code)).toEqual([
      'criteria-unknown',
    ]);
    expect(checkReview(brief, review({ criteria })).issues[0]?.message).toBe(
      'the review cites criteria the brief does not number: C7.',
    );
    // A brief that numbers none has nothing to compare with.
    expect(checkReport('## Goal\nx', report({ criteria }), '')).toEqual([]);
  });

  it('flags a finding id that no findings call issued, and skips the check without a list', () => {
    const resolutions = [{ id: 'R2', resolution: 'fixed' as const, note: 'x' }];
    expect(checkReport(brief, report({ findings: resolutions }), facts)).toEqual([]);
    expect(checkReport(brief, report({ findings: resolutions }), facts, ['R1'])[0]?.code).toBe(
      'findings-unknown',
    );
    expect(checkReport(brief, report({ findings: resolutions }), facts, [])[0]?.code).toBe(
      'findings-unknown',
    );
    const open = [{ id: 'R5', severity: 'blocking' as const, issue: 'x' }];
    const closed = [{ id: 'R6', note: 'x' }];
    const r = review({ verdict: 'rejected', open_findings: open, closed_findings: closed });
    expect(checkReview(brief, r).issues).toEqual([]);
    expect(checkReview(brief, r, ['R5', 'R6']).issues).toEqual([]);
    expect(checkReview(brief, r, ['R5']).issues).toEqual([
      {
        code: 'findings-unknown',
        message: 'the review cites findings this task did not issue: R6.',
      },
    ]);
    // A minor finding goes straight into the review (reviewer.md): open, it may be new.
    const minor = [{ id: 'R1', severity: 'minor' as const, issue: 'x' }];
    const reserved = review({ verdict: 'with_reservations', open_findings: minor });
    expect(checkReview(brief, reserved, []).issues).toEqual([]);
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

describe('checkReport against the brief’s paths (ADR 0042)', () => {
  const withPaths = (...paths: string[]) =>
    `${brief}\n## Paths\n${paths.map((p) => `- ${p}`).join('\n')}`;
  const filesFacts = (...lines: string[]) =>
    ['Files changed since the start of the request:', ...lines].join('\n');
  const scope = (b: string, f: string) =>
    checkReport(
      b,
      report({ changes: changedFiles(f).map((path) => ({ path, change: 'x' })) }),
      f,
    ).filter((i) => i.code === 'scope-exceeded');

  it('checks nothing without a Paths section', () => {
    expect(scope(brief, filesFacts('- modified anywhere/else.py'))).toEqual([]);
  });

  it('flags the files outside the entries, folders with or without the slash', () => {
    const f = filesFacts('- modified src/a.py', '- modified lib/b.py', '- modified srcx/c.py');
    for (const entry of ['src/', 'src', './src/', '@src']) {
      expect(scope(withPaths(entry), f)).toEqual([
        {
          code: 'scope-exceeded',
          message: "files changed outside the brief's paths: lib/b.py, srcx/c.py.",
        },
      ]);
    }
    expect(scope(withPaths('src/a.py', 'lib/'), f)[0]?.message).toContain('srcx/c.py');
    expect(scope(withPaths('src/', 'lib/b.py', 'srcx/c.py'), f)).toEqual([]);
  });

  it('allows a new test file anywhere, and flags a modified or deleted one', () => {
    expect(scope(withPaths('src/'), filesFacts('- added tests/test_x.py'))).toEqual([]);
    expect(
      scope(
        withPaths('src/'),
        filesFacts('- modified a.py', '- modified tests/test_x.py', '- deleted tests/test_y.py'),
      ),
    ).toEqual([
      {
        code: 'scope-exceeded',
        message:
          "files changed outside the brief's paths: a.py, tests/test_x.py (modified test), tests/test_y.py (deleted test).",
      },
    ]);
  });

  it('uses the turn’s list over the cumulative one', () => {
    const f = [
      filesFacts('- modified lib/old.py', '- modified src/new.py'),
      '',
      TURN_FILES_HEADER,
      '- modified src/new.py',
    ].join('\n');
    expect(scope(withPaths('src/'), f)).toEqual([]);
  });
});
