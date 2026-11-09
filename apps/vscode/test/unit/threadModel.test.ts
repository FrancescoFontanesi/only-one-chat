import { describe, expect, it } from 'vitest';
import type { ThreadItem } from '../../webview/state.js';
import {
  delegationNumbers,
  isFacts,
  opsSummary,
  readFacts,
  readOp,
  readReport,
  readUserMessage,
  withoutDelegation,
  wordAt,
} from '../../webview/threadModel.js';

describe('the chat thread as the Chat board reads it (ADR 0016)', () => {
  it('numbers delegations; a report, the facts and the changes after one take its number', () => {
    const facts = 'File cambiati dall’inizio della richiesta:\n- modified calc.py';
    const items: ThreadItem[] = [
      { kind: 'user', id: 'u1', text: 'uno' },
      { kind: 'approval', id: 'a1', approval: 'delegation', from: 'L', to: 'I', text: 'brief' },
      { kind: 'notice', id: 'n1', level: 'info', text: facts },
      { kind: 'approval', id: 'a2', approval: 'review', from: 'I', to: 'L', text: 'report' },
      { kind: 'user', id: 'u2', text: 'due' },
      {
        kind: 'changes',
        id: 'm1',
        checkpoint: 'c',
        files: [],
        uncovered: [],
        decisions: {},
      },
      { kind: 'approval', id: 'a3', approval: 'delegation', from: 'L', to: 'I', text: 'brief' },
    ];
    const numbers = delegationNumbers(items);
    expect([...numbers]).toEqual([
      ['a1', '01'],
      ['n1', '01'],
      ['a2', '01'],
      ['a3', '02'],
    ]);
    expect(isFacts(facts)).toBe(true);
  });

  it('reads the actions of a turn, Codex commands and Claude tools alike', () => {
    const ops = [
      'command: npm test',
      'tool: Read {"file_path":"src/a.ts"}',
      'tool: Edit {"file_path":"src/a.ts","old_string":"x"}',
      'tool: Grep {"pattern":"TODO"}',
      '↳ tool: Read {"file_path":"src/b.ts"}',
    ].map(readOp);
    expect(ops.map((o) => [o.verb, o.what])).toEqual([
      ['CMD', 'npm test'],
      ['READ', 'src/a.ts'],
      ['EDIT', 'src/a.ts'],
      ['GREP', 'TODO'],
      ['READ', 'src/b.ts'],
    ]);
    expect(opsSummary(ops)).toBe('1 comando · 2 letture · 1 modifica · 1 ricerca');
  });

  it('reads the facts the extension wrote back into their parts', () => {
    const facts = readFacts(
      [
        'File cambiati dall’inizio della richiesta:',
        '- modified src/a.ts',
        '- added src/a.test.ts',
        '',
        'Verifica eseguita dal runtime: npm test → exit 1',
        'Test falliti:',
        '- FAIL: rifiuta email senza dominio',
        'Ultime righe dell’output:',
        'Tests: 1 failed',
      ].join('\n'),
    );
    expect(facts).toEqual({
      files: ['modified src/a.ts', 'added src/a.test.ts'],
      verify: 'npm test · uscita 1',
      failed: ['FAIL: rifiuta email senza dominio'],
      output: 'Tests: 1 failed',
    });
  });

  it('splits a user message into recipient, route, text; the attachments line goes to the chips', () => {
    expect(readUserMessage('@impl usa i18n')).toEqual({
      to: 'implementer',
      route: null,
      text: 'usa i18n',
    });
    expect(
      readUserMessage('/delega aggiungi round\n\n@calc.py @src/', ['calc.py', 'src/']),
    ).toEqual({
      to: 'leader',
      route: 'delega',
      text: 'aggiungi round',
    });
  });

  it('finds the @ file word anywhere, the / command only at the start', () => {
    expect(wordAt('vedi @src/ca', 12, '@')).toEqual({ start: 5, query: 'src/ca' });
    expect(wordAt('@imp', 4, '@')).toEqual({ start: 0, query: 'imp' });
    expect(wordAt('mail a@b', 8, '@')).toBeNull();
    expect(wordAt('/del', 4, '/')).toEqual({ start: 0, query: 'del' });
    expect(wordAt('vedi src/a', 10, '/')).toBeNull();
    expect(wordAt('/delega x', 9, '/')).toBeNull();
  });
});

describe('a leader text without its delegation block (ADR 0018)', () => {
  it('keeps the text before and after the block, which its card shows', () => {
    expect(
      withoutDelegation('Ecco il brief.\n<<<DELEGA #claude\nfai x\nDELEGA>>>\nPoi ne parliamo.'),
    ).toEqual({
      text: 'Ecco il brief.\n\nPoi ne parliamo.',
      writing: false,
    });
    expect(withoutDelegation('Prima.\n<<<DELEGA @claude\nx\nDELEGA>>>')).toEqual({
      text: 'Prima.',
      writing: false,
    });
  });

  it('while the block streams, shows the text before it and says it is being written', () => {
    expect(withoutDelegation('Ecco.\n<<<DELEGA #claude\nfai')).toEqual({
      text: 'Ecco.',
      writing: true,
    });
    expect(withoutDelegation('Solo testo.')).toEqual({ text: 'Solo testo.', writing: false });
  });
});

describe('the $ word of the composer (ADR 0019)', () => {
  it('finds a skill name being typed anywhere, after a space', () => {
    expect(wordAt('usa $td', 7, '$')).toEqual({ start: 4, query: 'td' });
    expect(wordAt('$', 1, '$')).toEqual({ start: 0, query: '' });
    expect(wordAt('costa 5$', 8, '$')).toBeNull();
  });
});

describe('the implementer’s report (ADR 0020)', () => {
  it('reads its outcome and sections, and the text around it', () => {
    const text = [
      'Ecco.',
      '<<<RAPPORTO',
      '## Esito',
      'completato — round(x, n) aggiunto.',
      '## Modifiche',
      '@calc.py — la funzione',
      '## Bloccato su',
      'nessuno',
      'RAPPORTO>>>',
    ].join('\n');
    expect(readReport(text)).toEqual({
      before: 'Ecco.',
      outcome: 'completato',
      sections: [
        { name: 'Esito', body: 'completato — round(x, n) aggiunto.' },
        { name: 'Modifiche', body: '@calc.py — la funzione' },
        { name: 'Bloccato su', body: 'nessuno' },
      ],
      after: '',
    });
  });

  it('is not one while its block is still open, nor in a text without it', () => {
    expect(readReport('<<<RAPPORTO\n## Esito\nparziale')).toBeNull();
    expect(readReport('Fatto.')).toBeNull();
  });
});
