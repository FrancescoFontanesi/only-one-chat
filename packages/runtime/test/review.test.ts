// What the runtime reads in a reviewer's answer and in a report (ADR 0029).

import { describe, expect, it } from 'vitest';
import { parseReviewerTurn, reportOutcome, reviewVerdict } from '../src/index.js';

describe('the reviewer’s blocks', () => {
  it('reads the findings block, without the text around it', () => {
    const answer = 'Analisi.\n<<<RILIEVI\nR1 [bloccante] C1 — x.\nRILIEVI>>>\nfine';
    expect(parseReviewerTurn(answer)).toEqual({
      kind: 'findings',
      text: '<<<RILIEVI\nR1 [bloccante] C1 — x.\nRILIEVI>>>',
    });
  });

  it('reads the review block and its verdict; the review wins over the findings', () => {
    const answer = [
      '<<<RILIEVI',
      'R1 [minore] — y.',
      'RILIEVI>>>',
      '  <<<REVISIONE',
      '## Verdetto',
      'Con riserve — resta R1.',
      'REVISIONE>>>  ',
    ].join('\r\n');
    expect(parseReviewerTurn(answer)).toEqual({
      kind: 'review',
      text: '  <<<REVISIONE\n## Verdetto\nCon riserve — resta R1.\nREVISIONE>>>  ',
      verdict: 'con riserve',
    });
  });

  it('takes an answer without a complete block as the review, so it still reaches the leader', () => {
    expect(parseReviewerTurn('<<<RILIEVI\nR1 — mai chiuso.')).toEqual({
      kind: 'review',
      text: '<<<RILIEVI\nR1 — mai chiuso.',
      verdict: null,
    });
    // A marker inside a sentence is not a block.
    expect(parseReviewerTurn('Scrivo <<<REVISIONE dopo.\nREVISIONE>>>').kind).toBe('review');
    expect(parseReviewerTurn('Scrivo <<<RILIEVI dopo.\nRILIEVI>>>').kind).toBe('review');
  });
});

describe('the one word of a report and of a review', () => {
  it('reads the Esito', () => {
    expect(reportOutcome('<<<RAPPORTO\n## Esito\n\nBloccato: manca una decisione.')).toBe(
      'bloccato',
    );
    expect(reportOutcome('## Esito\ncompletato — fatto.\n## Modifiche')).toBe('completato');
    expect(reportOutcome('## Esito\ncompletatone')).toBeNull();
    expect(reportOutcome('## Esito\n## Modifiche\nparziale')).toBeNull();
    expect(reportOutcome('nessun rapporto')).toBeNull();
  });

  it('reads the Verdetto, "approvato con riserve" as the middle one', () => {
    expect(reviewVerdict('## Verdetto\napprovato — tutto provato.')).toBe('approvato');
    expect(reviewVerdict('## Verdetto\nApprovato con riserve: resta R2.')).toBe('con riserve');
    expect(reviewVerdict('## Verdetto\nrespinto')).toBe('respinto');
    expect(reviewVerdict('## Verdetto\nforse')).toBeNull();
  });
});
