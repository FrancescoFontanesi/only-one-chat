// The brief's marker lines and the result block (ADR 0009, docs/brief-format.md).

import { describe, expect, it } from 'vitest';
import { extractResult, parseBrief, resultTemplate } from '../src/index.js';

const BRIEF = [
  '<<<OOC-BRIEF v1 project=calc track=user-functions',
  '',
  '## Goal',
  'Funzioni utente.',
  '',
  'OOC-BRIEF>>>',
].join('\n');

describe('brief', () => {
  it('reads project and track and keeps the body as it is, with \\n line ends', () => {
    expect(parseBrief(`\n${BRIEF.replace(/\n/g, '\r\n')}\n\n`)).toEqual({
      status: 'valid',
      brief: { project: 'calc', track: 'user-functions', body: '## Goal\nFunzioni utente.' },
    });
  });

  it('refuses a copy without the start line, or with an unknown version or bad names', () => {
    for (const text of [
      BRIEF.split('\n').slice(1).join('\n'),
      BRIEF.replace('v1', 'v2'),
      BRIEF.replace('project=calc', 'project=Calc'),
      BRIEF.replace(' track=user-functions', ''),
    ]) {
      expect(parseBrief(text)).toMatchObject({ status: 'invalid', error: /first line/ });
    }
  });

  it('refuses a truncated copy: no end line', () => {
    expect(parseBrief(BRIEF.replace('OOC-BRIEF>>>', ''))).toMatchObject({
      status: 'invalid',
      error: /truncated/,
    });
  });

  it('finds the result block in an answer, markers included', () => {
    const block = resultTemplate({ project: 'calc', track: 'user-functions' });
    expect(block.split('\n')[0]).toBe('<<<OOC-RESULT v1 project=calc track=user-functions');
    expect(extractResult(`Ecco il risultato.\n${block}\nFine.`)).toBe(block);
    expect(extractResult('Nessun blocco.')).toBeNull();
    expect(extractResult(block.replace('OOC-RESULT>>>', ''))).toBeNull();
  });
});
