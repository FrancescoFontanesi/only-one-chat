// The contract between the roles, checked by the runtime and not by a model
// (ADR 0031): a report says how each criterion of the brief went, its outcome
// agrees with that, it names the files the runtime saw change; a review covers
// the criteria, and an approval rests on nothing left unverified, dubious or
// open. The runtime does not ask again: it tells the leader what does not
// hold, and lowers an approval that its own review contradicts. Text only.

import { reportOutcome, reviewVerdict, type ReviewVerdict } from './review.js';

/** A point where a report or a review does not keep the contract. */
export interface ContractIssue {
  readonly code:
    | 'no-report'
    | 'criteria-missing'
    | 'outcome-incoherent'
    | 'files-undeclared'
    | 'verdict-lowered';
  readonly message: string;
}

/** The body of a `## name` section, up to the next `## ` heading or a closing marker. */
function section(text: string, name: string): string | null {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const at = lines.findIndex((line) => line.trim().toLowerCase() === `## ${name.toLowerCase()}`);
  if (at < 0) return null;
  const end = lines.findIndex(
    (line, index) => index > at && (/^##\s/.test(line) || /^[A-Z]+>>>\s*$/.test(line.trim())),
  );
  return lines
    .slice(at + 1, end < 0 ? undefined : end)
    .join('\n')
    .trim();
}

/** The criteria of a brief, `C1`, `C2`…, as each line of its acceptance criteria opens. */
export function criteriaOf(brief: string): string[] {
  // The web app's briefs are in English (ADR 0009).
  const body =
    section(brief, 'Criteri di accettazione') ?? section(brief, 'Acceptance criteria') ?? '';
  const ids = new Set<string>();
  for (const match of body.matchAll(/^\s*(?:[-*]\s*)?(?:\*\*)?C(\d+)\b/gm)) {
    ids.add(`C${match[1] ?? ''}`);
  }
  return [...ids];
}

type Status = 'verificato' | 'non verificato' | 'non soddisfatto';
// Plurals and "parziale" too: reports write "C1, C3–C8: verificati" and "C2: parziale".
const STATUS = /\b(non soddisfatt[oi]|non verificat[oi]|verificat[oi]|parziale)\b/i;
const statusOf = (word: string): Status => {
  const w = word.toLowerCase();
  if (w.startsWith('non soddisfatt')) return 'non soddisfatto';
  if (w.startsWith('verificat')) return 'verificato';
  return 'non verificato';
};

/**
 * The status of each criterion a section names: one status word per line,
 * for the criteria and ranges written before it (`C1–C10: verificato`).
 */
export function criterionStatuses(body: string): Map<string, Status> {
  const statuses = new Map<string, Status>();
  for (const line of body.split('\n')) {
    const found = STATUS.exec(line);
    if (!found) continue;
    const status = statusOf(found[1] ?? '');
    for (const id of line.slice(0, found.index).matchAll(/C(\d+)(?:\s*[–—-]\s*C?(\d+))?/g)) {
      const from = Number(id[1]);
      const to = id[2] === undefined ? from : Number(id[2]);
      // A range written backwards or absurdly long is not a range of criteria.
      if (to < from || to - from > 100) continue;
      for (let n = from; n <= to; n++)
        if (!statuses.has(`C${String(n)}`)) statuses.set(`C${String(n)}`, status);
    }
  }
  return statuses;
}

/** The files the runtime saw change, from its facts (`- modified path`). */
export function changedFiles(facts: string): string[] {
  return [...facts.matchAll(/^- (?:added|modified|deleted) (.+)$/gm)].map((match) =>
    (match[1] ?? '').trim().replaceAll('\\', '/'),
  );
}

const listed = (ids: readonly string[]) => ids.join(', ');

/** What does not hold in an implementer's report on a brief; none when it keeps the contract. */
export function checkReport(brief: string, report: string, facts: string): ContractIssue[] {
  if (!/<<<RAPPORTO|^##\s+Esito\s*$/m.test(report)) {
    return [{ code: 'no-report', message: 'l’implementatore non ha scritto il rapporto.' }];
  }
  const issues: ContractIssue[] = [];
  const criteria = criteriaOf(brief);
  const statuses = criterionStatuses(section(report, 'Verifica') ?? '');
  const missing = criteria.filter((id) => !statuses.has(id));
  if (missing.length > 0) {
    issues.push({
      code: 'criteria-missing',
      message: `la Verifica non dice come sono andati ${listed(missing)}.`,
    });
  }
  const outcome = reportOutcome(report);
  const open = [...statuses].filter(([, status]) => status !== 'verificato').map(([id]) => id);
  const blocked = (section(report, 'Bloccato su') ?? '').trim();
  if (outcome === 'completato' && open.length > 0) {
    issues.push({
      code: 'outcome-incoherent',
      message: `l’esito è "completato" ma ${listed(open)} non risultano verificati.`,
    });
  } else if (outcome === 'completato' && blocked !== '' && !/^nessun[oa]\b/i.test(blocked)) {
    issues.push({
      code: 'outcome-incoherent',
      message: 'l’esito è "completato" ma "Bloccato su" chiede una decisione.',
    });
  }
  const declared = (section(report, 'Modifiche') ?? '').replaceAll('\\', '/');
  const undeclared = changedFiles(facts).filter((path) => !declared.includes(path));
  if (undeclared.length > 0) {
    issues.push({
      code: 'files-undeclared',
      message: `file cambiati che il rapporto non nomina in Modifiche: ${undeclared.join(', ')}.`,
    });
  }
  return issues;
}

/** The axes of a review's Giudizio that are not clean, by their word. */
function dubiousAxes(review: string): { dubious: string[]; failed: string[] } {
  const body = section(review, 'Giudizio') ?? '';
  const dubious: string[] = [];
  const failed: string[] = [];
  for (const match of body.matchAll(
    /^\s*(?:[-*]\s*)?(Onestà|Sicurezza|Aggiornamento):\s*(\p{L}+)/gimu,
  )) {
    const [, axis = '', word = ''] = match;
    if (/^(aggirata|falla|superato)$/i.test(word)) failed.push(axis);
    else if (!/^pulit[oa]$/i.test(word)) dubious.push(axis);
  }
  return { dubious, failed };
}

/** Findings still open in a review: the text between "Aperti:" and "Chiusi:". */
function openFindings(review: string): { any: boolean; blocking: boolean } {
  const body = section(review, 'Rilievi') ?? '';
  const open = /Aperti:\s*([\s\S]*?)(?:\n\s*Chiusi:|$)/i.exec(body)?.[1]?.trim() ?? body.trim();
  const any = open !== '' && !/^nessun[oa]\.?$/i.test(open);
  return { any, blocking: any && /bloccante/i.test(open) };
}

/**
 * A review checked against the brief: the criteria it covers, and its verdict
 * as the runtime keeps it. An approval with a criterion not verified, an axis
 * not clean or a finding open is lowered, and the leader is told why.
 */
export function checkReview(
  brief: string,
  review: string,
): { verdict: ReviewVerdict | null; issues: ContractIssue[] } {
  const said = reviewVerdict(review);
  const issues: ContractIssue[] = [];
  const criteria = criteriaOf(brief);
  const statuses = criterionStatuses(section(review, 'Criteri') ?? '');
  const missing = criteria.filter((id) => !statuses.has(id));
  if (missing.length > 0) {
    issues.push({
      code: 'criteria-missing',
      message: `la revisione non dice come sono andati ${listed(missing)}.`,
    });
  }
  if (said !== 'approvato') return { verdict: said, issues };
  const unverified = [...statuses].filter(([, s]) => s !== 'verificato').map(([id]) => id);
  const { dubious, failed } = dubiousAxes(review);
  const open = openFindings(review);
  const reasons = [
    ...(unverified.length > 0 ? [`${listed(unverified)} non verificati`] : []),
    ...(missing.length > 0 ? [`${listed(missing)} non citati`] : []),
    ...(dubious.length > 0 ? [`giudizio dubbio su ${dubious.join(', ')}`] : []),
    ...(failed.length > 0 ? [`giudizio negativo su ${failed.join(', ')}`] : []),
    ...(open.any ? ['rilievi ancora aperti'] : []),
  ];
  if (reasons.length === 0) return { verdict: said, issues };
  const verdict: ReviewVerdict = failed.length > 0 || open.blocking ? 'respinto' : 'con riserve';
  issues.push({
    code: 'verdict-lowered',
    message: `il revisore ha scritto "approvato", il runtime lo tiene come "${verdict}": ${reasons.join('; ')}.`,
  });
  return { verdict, issues };
}

/** The issues as the runtime's facts, for the leader and the reviewer; '' when there are none. */
export function contractFacts(title: string, issues: readonly ContractIssue[]): string {
  return issues.length === 0
    ? ''
    : [`${title}, fatti dal runtime:`, ...issues.map((issue) => `- ${issue.message}`)].join('\n');
}
