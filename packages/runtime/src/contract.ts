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

/** The status of each criterion, the first entry of an id winning. */
function statusesOf(criteria: readonly { id: string; status: string }[]): Map<string, string> {
  const statuses = new Map<string, string>();
  for (const { id, status } of criteria) if (!statuses.has(id)) statuses.set(id, status);
  return statuses;
}

/**
 * What does not hold in an implementer's report on a brief; none when it keeps
 * the contract. `report` is null when the implementer made no valid call.
 */
export function checkReport(brief: string, report: Report | null, facts: string): ContractIssue[] {
  if (report === null) {
    return [{ code: 'no-report', message: 'the implementer did not call the report tool.' }];
  }
  const issues: ContractIssue[] = [];
  const statuses = statusesOf(report.criteria);
  const missing = criteriaOf(brief).filter((id) => !statuses.has(id));
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
 * as the runtime keeps it. An approval with a criterion not verified, an axis
 * not clean or a finding open is lowered, and the leader is told why.
 */
export function checkReview(
  brief: string,
  review: Review,
): { verdict: ReviewVerdict; issues: ContractIssue[] } {
  const issues: ContractIssue[] = [];
  const statuses = statusesOf(review.criteria);
  const missing = criteriaOf(brief).filter((id) => !statuses.has(id));
  if (missing.length > 0) {
    issues.push({
      code: 'criteria-missing',
      message: `the review does not say how ${listed(missing)} went.`,
    });
  }
  if (review.verdict !== 'approved') return { verdict: review.verdict, issues };
  const unverified = [...statuses].filter(([, s]) => s !== 'verified').map(([id]) => id);
  const { honesty, security, currency } = review.axes;
  const dubious = [
    ...(honesty === 'doubtful' ? ['honesty'] : []),
    ...(security === 'doubtful' ? ['security'] : []),
    ...(currency === 'doubtful' ? ['currency'] : []),
  ];
  const failed = [
    ...(honesty === 'bypassed' ? ['honesty'] : []),
    ...(security === 'flaw' ? ['security'] : []),
    ...(currency === 'outdated' ? ['currency'] : []),
  ];
  const open = review.open_findings ?? [];
  const reasons = [
    ...(unverified.length > 0 ? [`${listed(unverified)} not verified`] : []),
    ...(missing.length > 0 ? [`${listed(missing)} not cited`] : []),
    ...(dubious.length > 0 ? [`doubtful on ${dubious.join(', ')}`] : []),
    ...(failed.length > 0 ? [`negative on ${failed.join(', ')}`] : []),
    ...(open.length > 0 ? ['findings still open'] : []),
  ];
  if (reasons.length === 0) return { verdict: review.verdict, issues };
  const verdict: ReviewVerdict =
    failed.length > 0 || open.some((f) => f.severity === 'blocking')
      ? 'rejected'
      : 'with_reservations';
  issues.push({
    code: 'verdict-lowered',
    message: `the reviewer wrote "approved", the runtime keeps it as "${verdict}": ${reasons.join('; ')}.`,
  });
  return { verdict, issues };
}

/** The issues as the runtime's facts, for the leader and the reviewer; '' when there are none. */
export function contractFacts(title: string, issues: readonly ContractIssue[]): string {
  return issues.length === 0
    ? ''
    : [`${title}, made by the runtime:`, ...issues.map((issue) => `- ${issue.message}`)].join('\n');
}
