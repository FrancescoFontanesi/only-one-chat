// The contract between the roles, checked by the runtime and not by a model
// (ADR 0031): a report says how each criterion of the brief went, its outcome
// agrees with that, it names the files the runtime saw change; a review covers
// the criteria, and an approval rests on nothing left unverified, dubious or
// open. The runtime does not ask again: it tells the leader what does not
// hold, and lowers an approval that its own review contradicts. The checks are
// comparisons between the fields of the handoffs (ADR 0035); only the brief
// stays text, because the user can edit it before it is sent.

import type { Report, Review, ReviewVerdict } from './handoff.js';

/** A point where a report or a review does not keep the contract. */
interface ContractIssue {
  readonly code:
    | 'no-report'
    | 'criteria-missing'
    | 'outcome-incoherent'
    | 'files-undeclared'
    | 'criteria-unknown'
    | 'findings-unknown'
    | 'findings-missing'
    | 'findings-dropped'
    | 'verdict-incoherent'
    | 'verdict-lowered';
  readonly message: string;
}

/** The body of a `## name` section, up to the next `## ` heading. */
function section(text: string, name: string): string | null {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const at = lines.findIndex((line) => line.trim().toLowerCase() === `## ${name.toLowerCase()}`);
  if (at < 0) return null;
  const end = lines.findIndex((line, index) => index > at && /^##\s/.test(line));
  return lines
    .slice(at + 1, end < 0 ? undefined : end)
    .join('\n')
    .trim();
}

/** The criteria of a brief, `C1`, `C2`…, as each line of its acceptance criteria opens. */
export function criteriaOf(brief: string): string[] {
  // The runtime's briefs and the web app's are in English (ADR 0009, 0035); a draft kept from before is Italian.
  const body =
    section(brief, 'Acceptance criteria') ?? section(brief, 'Criteri di accettazione') ?? '';
  const ids = new Set<string>();
  for (const match of body.matchAll(/^\s*(?:[-*]\s*)?(?:\*\*)?C(\d+)\b/gm)) {
    ids.add(`C${match[1] ?? ''}`);
  }
  return [...ids];
}

/** The files the runtime saw change, from its facts (`- modified path`). */
export function changedFiles(facts: string): string[] {
  return [...facts.matchAll(/^- (?:added|modified|deleted) (.+)$/gm)].map((match) =>
    (match[1] ?? '').trim().replaceAll('\\', '/'),
  );
}

const listed = (ids: readonly string[]) => ids.join(', ');

/** A path as a report names it: forward slashes, no `@`, no leading `./`. */
const normalized = (path: string) =>
  path.trim().replaceAll('\\', '/').replace(/^@/, '').replace(/^\.\//, '');

/** True when a free-text field says there is nothing ("", "none", "nessuno"). */
const saysNone = (text: string | undefined) =>
  text === undefined || text.trim() === '' || /^(none|nessun[oa]|n\/?a|-)\.?$/i.test(text.trim());

/** The status of each criterion; ids are unique, the handoff schema enforces it. */
const statusesOf = (criteria: readonly { id: string; status: string }[]) =>
  new Map(criteria.map((c) => [c.id, c.status]));

/** The ids missing from `known`; none when there is no list to compare. */
const unknownOf = (ids: readonly string[], known: readonly string[] | undefined) =>
  known === undefined ? [] : ids.filter((id) => !known.includes(id));

/**
 * What does not hold in an implementer's report on a brief; none when it keeps
 * the contract. `report` is null when the implementer made no valid call.
 */
export function checkReport(
  brief: string,
  report: Report | null,
  facts: string,
  issued?: readonly string[],
): ContractIssue[] {
  if (report === null) {
    return [{ code: 'no-report', message: 'the implementer did not call the report tool.' }];
  }
  const issues: ContractIssue[] = [];
  const statuses = statusesOf(report.criteria);
  const numbered = criteriaOf(brief);
  const missing = numbered.filter((id) => !statuses.has(id));
  const strange = unknownOf([...statuses.keys()], numbered.length > 0 ? numbered : undefined);
  if (strange.length > 0) {
    issues.push({
      code: 'criteria-unknown',
      message: `the report cites criteria the brief does not number: ${listed(strange)}.`,
    });
  }
  const strayFindings =
    issued &&
    unknownOf(
      (report.findings ?? []).map((f) => f.id),
      issued,
    );
  if (strayFindings && strayFindings.length > 0) {
    issues.push({
      code: 'findings-unknown',
      message: `the report answers findings this task did not issue: ${listed(strayFindings)}.`,
    });
  }
  if (missing.length > 0) {
    issues.push({
      code: 'criteria-missing',
      message: `the report does not say how ${listed(missing)} went.`,
    });
  }
  const open = [...statuses].filter(([, status]) => status !== 'verified').map(([id]) => id);
  if (report.outcome === 'done' && open.length > 0) {
    issues.push({
      code: 'outcome-incoherent',
      message: `the outcome is "done" but these criteria are not verified: ${listed(open)}.`,
    });
  } else if (report.outcome === 'done' && !saysNone(report.blocked_on)) {
    issues.push({
      code: 'outcome-incoherent',
      message: 'the outcome is "done" but "blocked_on" asks for a decision.',
    });
  }
  const declared = report.changes.map((change) => normalized(change.path));
  const undeclared = changedFiles(facts).filter(
    (path) => !declared.some((d) => d === path || d.endsWith(`/${path}`)),
  );
  if (undeclared.length > 0) {
    issues.push({
      code: 'files-undeclared',
      message: `files changed that the report does not list in changes: ${undeclared.join(', ')}.`,
    });
  }
  return issues;
}

/**
 * A review checked against the brief: the criteria it covers, and its verdict
 * as the runtime keeps it (ADR 0040). An approval with a criterion not
 * verified, an axis not clean or a finding open is lowered; any verdict with a
 * blocking finding open or an axis failed is at least `rejected`; a `rejected`
 * with neither is incoherent. `turn` is what the same turn also called:
 * `findings` and the correction rounds left. The leader is told every change.
 */
export function checkReview(
  brief: string,
  review: Review,
  issued?: readonly string[],
  turn: {
    readonly findings?: { readonly items: readonly { readonly severity: string }[] } | null;
    readonly roundsLeft?: number;
  } = {},
): { verdict: ReviewVerdict; issues: ContractIssue[] } {
  const issues: ContractIssue[] = [];
  const statuses = statusesOf(review.criteria);
  const numbered = criteriaOf(brief);
  const missing = numbered.filter((id) => !statuses.has(id));
  const strange = unknownOf([...statuses.keys()], numbered.length > 0 ? numbered : undefined);
  if (strange.length > 0) {
    issues.push({
      code: 'criteria-unknown',
      message: `the review cites criteria the brief does not number: ${listed(strange)}.`,
    });
  }
  // Only closed ones: an open finding may be new, as the minor ones that go straight into the review.
  const strayFindings =
    issued &&
    unknownOf(
      (review.closed_findings ?? []).map((f) => f.id),
      issued,
    );
  if (strayFindings && strayFindings.length > 0) {
    issues.push({
      code: 'findings-unknown',
      message: `the review cites findings this task did not issue: ${listed(strayFindings)}.`,
    });
  }
  if (missing.length > 0) {
    issues.push({
      code: 'criteria-missing',
      message: `the review does not say how ${listed(missing)} went.`,
    });
  }
  const { honesty, security, currency } = review.axes;
  const failed = [
    ...(honesty === 'bypassed' ? ['honesty'] : []),
    ...(security === 'flaw' ? ['security'] : []),
    ...(currency === 'outdated' ? ['currency'] : []),
  ];
  const open = review.open_findings ?? [];
  const blocking = failed.length > 0 || open.some((f) => f.severity === 'blocking');
  let verdict: ReviewVerdict = review.verdict;
  if (review.verdict === 'approved') {
    const unverified = [...statuses].filter(([, s]) => s !== 'verified').map(([id]) => id);
    const dubious = [
      ...(honesty === 'doubtful' ? ['honesty'] : []),
      ...(security === 'doubtful' ? ['security'] : []),
      ...(currency === 'doubtful' ? ['currency'] : []),
    ];
    const reasons = [
      ...(unverified.length > 0 ? [`${listed(unverified)} not verified`] : []),
      ...(missing.length > 0 ? [`${listed(missing)} not cited`] : []),
      ...(dubious.length > 0 ? [`doubtful on ${dubious.join(', ')}`] : []),
      ...(failed.length > 0 ? [`negative on ${failed.join(', ')}`] : []),
      ...(open.length > 0 ? ['findings still open'] : []),
    ];
    if (reasons.length > 0) {
      verdict = blocking ? 'rejected' : 'with_reservations';
      issues.push({
        code: 'verdict-lowered',
        message: `the reviewer wrote "approved", the runtime keeps it as "${verdict}": ${reasons.join('; ')}.`,
      });
    }
  } else if (review.verdict === 'with_reservations' && blocking) {
    verdict = 'rejected';
    const reasons = [
      ...(failed.length > 0 ? [`negative on ${failed.join(', ')}`] : []),
      ...(open.some((f) => f.severity === 'blocking') ? ['a blocking finding still open'] : []),
    ];
    issues.push({
      code: 'verdict-lowered',
      message: `the reviewer wrote "with_reservations", the runtime keeps it as "rejected": ${reasons.join('; ')}.`,
    });
  } else if (
    review.verdict === 'rejected' &&
    !blocking &&
    !(turn.findings?.items ?? []).some((f) => f.severity === 'blocking')
  ) {
    issues.push({
      code: 'verdict-incoherent',
      message:
        'the reviewer wrote "rejected" but names no blocking finding and no failed axis; the runtime keeps it as it is.',
    });
  }
  const rounds = verdict === 'rejected' && (turn.roundsLeft ?? 0) > 0;
  if (rounds && !turn.findings) {
    issues.push({
      code: 'findings-missing',
      message:
        'the verdict is "rejected" with correction rounds left, but the reviewer gave no findings for the implementer.',
    });
  } else if (!rounds && turn.findings) {
    issues.push({
      code: 'findings-dropped',
      message:
        'the reviewer called findings in the same turn as review; the findings were not used.',
    });
  }
  return { verdict, issues };
}

/** The issues as the runtime's facts, for the leader and the reviewer; '' when there are none. */
export function contractFacts(title: string, issues: readonly ContractIssue[]): string {
  return issues.length === 0
    ? ''
    : [`${title}, made by the runtime:`, ...issues.map((issue) => `- ${issue.message}`)].join('\n');
}
