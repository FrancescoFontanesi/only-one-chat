// What the runtime reads in the reviewer's and the implementer's answers (ADR
// 0029): the reviewer's two blocks, by their marker lines, and the one word
// that says how a report or a review ended. Text only, no model.

/** The reviewer's findings for the implementer, and its report for the leader. */
export const FINDINGS_START = '<<<RILIEVI';
export const FINDINGS_END = 'RILIEVI>>>';
export const REVIEW_START = '<<<REVISIONE';
export const REVIEW_END = 'REVISIONE>>>';

type ReportOutcome = 'completato' | 'parziale' | 'bloccato';
export type ReviewVerdict = 'approvato' | 'con riserve' | 'respinto';

/**
 * How a reviewer's turn ended. `findings`: the block for the implementer.
 * `review`: the block for the leader, or the whole answer when it wrote
 * neither block, so that what it found still reaches the leader.
 */
export type ReviewerTurn =
  | { readonly kind: 'findings'; readonly text: string }
  | { readonly kind: 'review'; readonly text: string; readonly verdict: ReviewVerdict | null };

/** The last complete block between two marker lines, markers included; null without one. */
function block(text: string, start: string, end: string): string | null {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const to = lines.findLastIndex((line) => line.trim() === end);
  const from = lines.findLastIndex((line, at) => at < to && line.trim() === start);
  return from < 0 ? null : lines.slice(from, to + 1).join('\n');
}

/** The first line of a `## name` section, in lower case; '' without the section. */
function firstLineOf(text: string, name: string): string {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const at = lines.findIndex((line) => line.trim().toLowerCase() === `## ${name}`);
  if (at < 0) return '';
  const body = lines.slice(at + 1).find((line) => line.trim() !== '');
  return body === undefined || body.startsWith('## ') ? '' : body.trim().toLowerCase();
}

/** The Esito of an implementer's report; null when it does not say. */
export function reportOutcome(report: string): ReportOutcome | null {
  const word = /^(completato|parziale|bloccato)(?![\p{L}\p{N}])/u.exec(
    firstLineOf(report, 'esito'),
  );
  return (word?.[1] as ReportOutcome | undefined) ?? null;
}

/** The Verdetto of a review; null when it does not say. */
export function reviewVerdict(review: string): ReviewVerdict | null {
  // "approvato con riserve" is the middle verdict, however it is spelled.
  const word = /^(approvato con riserve|con riserve|approvato|respinto)(?![\p{L}\p{N}])/u.exec(
    firstLineOf(review, 'verdetto'),
  )?.[1];
  if (word === undefined) return null;
  return word === 'approvato' || word === 'respinto' ? word : 'con riserve';
}

/**
 * A reviewer's answer, by its blocks. The report wins over the findings when
 * it wrote both: the review is over.
 */
export function parseReviewerTurn(answer: string): ReviewerTurn {
  const review = block(answer, REVIEW_START, REVIEW_END);
  if (review !== null) return { kind: 'review', text: review, verdict: reviewVerdict(review) };
  const findings = block(answer, FINDINGS_START, FINDINGS_END);
  if (findings !== null) return { kind: 'findings', text: findings };
  return { kind: 'review', text: answer.trim(), verdict: reviewVerdict(answer) };
}
