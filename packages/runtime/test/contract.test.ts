// The contract between the roles (ADR 0031), on texts shaped like the real
// reports and reviews of the role evaluations.

import { describe, expect, it } from 'vitest';
import {
  changedFiles,
  checkReport,
  checkReview,
  contractFacts,
  criteriaOf,
  criterionStatuses,
} from '../src/index.js';

const brief = [
  '## Obiettivo',
  'round(x) e round(x, n).',
  '## Criteri di accettazione',
  'Ingresso → risultato atteso:',
  '- C1. `round(2.4)` → `2`',
  '- C2. `round(2.5)` → `2`',
  'C3. Errore per `round(1, -1)`; vedi anche C1.',
  '- **C4.** `python -m unittest` passa.',
  '## Confini',
  'C9 qui non è un criterio.',
].join('\n');

const facts = [
  'File cambiati dall’inizio della richiesta:',
  '- modified evaluator.py',
  '- added tests\\test_round.py',
  '',
  'Verifica eseguita dal runtime: python -m unittest → exit 0',
].join('\n');

const report = (
  verifica: string,
  esito = 'completato',
  modifiche = '@evaluator.py — round\n@tests/test_round.py — test',
) =>
  [
    '<<<RAPPORTO',
    '## Esito',
    `${esito} — fatto.`,
    '## Modifiche',
    modifiche,
    '## Verifica',
    verifica,
    '## Decisioni',
    'nessuno',
    '## Bloccato su',
    'nessuno',
    '## Fuori ambito',
    'nessuno',
    'RAPPORTO>>>',
  ].join('\n');

describe('the criteria and their statuses', () => {
  it('reads the criteria as each line of the acceptance criteria opens, and only there', () => {
    expect(criteriaOf(brief)).toEqual(['C1', 'C2', 'C3', 'C4']);
    expect(criteriaOf('## Acceptance criteria\n1. C1 nothing\nC2. ok')).toEqual(['C2']);
    expect(criteriaOf('## Obiettivo\nC1. x')).toEqual([]);
  });

  it('reads one status per line, for the criteria and ranges before it', () => {
    const statuses = criterionStatuses(
      [
        'C1–C2: verificato — `test_round`.',
        '- C3 non verificato — i comandi sono stati negati.',
        'C4 — non soddisfatto — exit 1; C1 verificato non conta, C1 è già letto.',
        'Comandi eseguiti: `python -m unittest` verificato.',
      ].join('\n'),
    );
    expect(Object.fromEntries(statuses)).toEqual({
      C1: 'verificato',
      C2: 'verificato',
      C3: 'non verificato',
      C4: 'non soddisfatto',
    });
  });

  it('reads plurals, and "parziale" as not verified (as a real report wrote them)', () => {
    const statuses = criterionStatuses(
      [
        '- C1, C3–C4: verificati. Gli stessi test di prima passano ancora.',
        '- C2: parziale. Non ho provato un symlink vero.',
        '- C5 e C6: non verificati.',
      ].join('\n'),
    );
    expect(Object.fromEntries(statuses)).toEqual({
      C1: 'verificato',
      C2: 'non verificato',
      C3: 'verificato',
      C4: 'verificato',
      C5: 'non verificato',
      C6: 'non verificato',
    });
  });

  it('reads the files the runtime saw change, with forward slashes', () => {
    expect(changedFiles(facts)).toEqual(['evaluator.py', 'tests/test_round.py']);
  });
});

describe('checkReport', () => {
  it('has nothing to say about a report that keeps the contract', () => {
    expect(checkReport(brief, report('C1–C4: verificato — `test_round`.'), facts)).toEqual([]);
  });

  it('names the criteria the Verifica leaves out, and the files Modifiche leaves out', () => {
    expect(
      checkReport(brief, report('C1, C2: verificato.', 'completato', '@evaluator.py'), facts),
    ).toEqual([
      { code: 'criteria-missing', message: 'la Verifica non dice come sono andati C3, C4.' },
      {
        code: 'files-undeclared',
        message: 'file cambiati che il rapporto non nomina in Modifiche: tests/test_round.py.',
      },
    ]);
  });

  it('finds an outcome that its own Verifica contradicts', () => {
    const issues = checkReport(brief, report('C1–C3: verificato.\nC4: non verificato.'), facts);
    expect(issues).toEqual([
      {
        code: 'outcome-incoherent',
        message: 'l’esito è "completato" ma C4 non risultano verificati.',
      },
    ]);
    // "parziale" with something unverified is what it should be.
    expect(
      checkReport(brief, report('C1–C3: verificato.\nC4: non verificato.', 'parziale'), facts),
    ).toEqual([]);
  });

  it('says there is no report when there is none', () => {
    expect(checkReport(brief, 'Fatto, tutto bene.', facts)).toEqual([
      { code: 'no-report', message: 'l’implementatore non ha scritto il rapporto.' },
    ]);
  });
});

const review = (
  verdetto: string,
  criteri: string,
  giudizio: string,
  rilievi = 'Aperti: nessuno\nChiusi: nessuno',
) =>
  [
    '<<<REVISIONE',
    '## Verdetto',
    `${verdetto} — un giro.`,
    '## Criteri',
    criteri,
    '## Giudizio',
    giudizio,
    '## Modifiche',
    '@evaluator.py — round',
    '## Rilievi',
    rilievi,
    'REVISIONE>>>',
  ].join('\n');
const clean = 'Onestà: pulita — ok.\nSicurezza: pulita — ok.\nAggiornamento: pulito — Python 3.12.';

describe('checkReview', () => {
  it('keeps an approval that rests on every criterion verified and every axis clean', () => {
    expect(checkReview(brief, review('approvato', 'C1–C4 — verificato — test.', clean))).toEqual({
      verdict: 'approvato',
      issues: [],
    });
  });

  it('lowers an approval with a criterion not verified, or an axis in doubt, to "con riserve"', () => {
    const checked = checkReview(
      brief,
      review(
        'approvato',
        'C1–C3 — verificato.\nC4 — non verificato — sessione in sola lettura.',
        'Onestà: pulita.\nSicurezza: dubbia — symlink non provati.\nAggiornamento: pulito.',
      ),
    );
    expect(checked.verdict).toBe('con riserve');
    expect(checked.issues).toEqual([
      {
        code: 'verdict-lowered',
        message:
          'il revisore ha scritto "approvato", il runtime lo tiene come "con riserve": C4 non verificati; giudizio dubbio su Sicurezza.',
      },
    ]);
  });

  it('lowers an approval to "respinto" with an axis failed or a blocking finding open', () => {
    expect(
      checkReview(
        brief,
        review(
          'approvato',
          'C1–C4 — verificato.',
          clean.replace('pulita — ok.\nSicurezza', 'aggirata — test scritti a mano.\nSicurezza'),
        ),
      ).verdict,
    ).toBe('respinto');
    expect(
      checkReview(
        brief,
        review(
          'approvato',
          'C1–C4 — verificato.',
          clean,
          'Aperti: R1 [bloccante] — byte nullo.\nChiusi: nessuno',
        ),
      ).verdict,
    ).toBe('respinto');
  });

  it('names the criteria a review leaves out, and leaves other verdicts as they are', () => {
    expect(checkReview(brief, review('con riserve', 'C1 — verificato.', clean))).toEqual({
      verdict: 'con riserve',
      issues: [
        { code: 'criteria-missing', message: 'la revisione non dice come sono andati C2, C3, C4.' },
      ],
    });
  });
});

describe('contractFacts', () => {
  it('is empty with nothing to say, a list of facts otherwise', () => {
    expect(contractFacts('Controlli sul rapporto', [])).toBe('');
    expect(
      contractFacts('Controlli sul rapporto', [{ code: 'no-report', message: 'manca.' }]),
    ).toBe('Controlli sul rapporto, fatti dal runtime:\n- manca.');
  });
});
