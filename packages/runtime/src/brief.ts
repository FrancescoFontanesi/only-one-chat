// The blocks exchanged with the reasoning chat (ChatGPT web, ADR 0009): the
// brief that comes in and the result that goes back. Only the brief's first
// and last lines are checked (docs/brief-format.md); its body reaches the
// gateway as it is.

export const BRIEF_END = 'OOC-BRIEF>>>';
export const RESULT_END = 'OOC-RESULT>>>';

const BRIEF_START = /^<<<OOC-BRIEF v1 project=([a-z0-9-]+) track=([a-z0-9-]+)$/;
const RESULT_START = /^<<<OOC-RESULT v1\b/;

export interface Brief {
  readonly project: string;
  readonly track: string;
  /** Everything between the two marker lines, trimmed. */
  readonly body: string;
}

export type BriefParse =
  | { readonly status: 'valid'; readonly brief: Brief }
  | { readonly status: 'invalid'; readonly error: string };

/** Checks the marker lines of a copied brief; blank lines around them do not count. */
export function parseBrief(text: string): BriefParse {
  const lines = text.replace(/\r\n/g, '\n').trim().split('\n');
  const start = BRIEF_START.exec(lines[0]?.trim() ?? '');
  if (!start) {
    return {
      status: 'invalid',
      error: 'the first line must be "<<<OOC-BRIEF v1 project=<id> track=<slug>"',
    };
  }
  if (lines.length < 2 || lines.at(-1)?.trim() !== BRIEF_END) {
    return {
      status: 'invalid',
      error: `the last line must be "${BRIEF_END}": the copy may be truncated`,
    };
  }
  return {
    status: 'valid',
    brief: {
      project: start[1] ?? '',
      track: start[2] ?? '',
      body: lines.slice(1, -1).join('\n').trim(),
    },
  };
}

/** The result block's template, for the brief's project and track. */
export function resultTemplate(brief: Pick<Brief, 'project' | 'track'>): string {
  return [
    `<<<OOC-RESULT v1 project=${brief.project} track=${brief.track}`,
    '## Outcome',
    'done, partial o failed, in una riga',
    '## Acceptance criteria',
    'ogni criterio del brief, con il suo numero: ✓ o ✗ e l’evidenza in una riga',
    '## Verified facts',
    'solo ciò che è stato verificato eseguendo qualcosa: comandi con il loro esito, file modificati',
    '## Autonomous decisions',
    'ciò che è stato deciso senza che il brief lo dicesse, e ogni deviazione, con il perché; oppure "None"',
    '## Problems and risks',
    'oppure "None"',
    '## Notes',
    'facoltativa: ciò che serve sapere per il prossimo brief',
    RESULT_END,
  ].join('\n');
}

/** The result block in an answer, markers included; null when there is none. */
export function extractResult(answer: string): string | null {
  const lines = answer.replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex((line) => RESULT_START.test(line.trim()));
  const end = lines.findIndex((line, at) => at > start && line.trim() === RESULT_END);
  if (start < 0 || end < 0) return null;
  return lines.slice(start, end + 1).join('\n');
}
