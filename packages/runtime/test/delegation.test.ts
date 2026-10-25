import { describe, expect, it } from 'vitest';
import { delegationTemplate, parseDelegation, DELEGATION_SECTIONS } from '../src/index.js';
import { delegationBlock } from './fake-agents.js';

describe('delegation block', () => {
  it('parses a block after a plan, with all six sections in order', () => {
    const parsed = parseDelegation(delegationBlock());
    expect(parsed.status).toBe('valid');
    if (parsed.status !== 'valid') return;
    expect(Object.keys(parsed.delegation.sections)).toEqual([...DELEGATION_SECTIONS]);
    expect(parsed.delegation.sections['Domande aperte']).toBe('Nessuna');
    expect(parsed.delegation.text.startsWith('## Obiettivo')).toBe(true);
    expect(parsed.delegation.text).not.toContain('DELEGA');
  });

  it('accepts CRLF line endings', () => {
    expect(parseDelegation(delegationBlock().replace(/\n/g, '\r\n')).status).toBe('valid');
  });

  it('reports an answer without markers as absent (a conclusion)', () => {
    expect(parseDelegation('Conclusione: tutto a posto.')).toEqual({ status: 'absent' });
  });

  it.each([
    ['a missing section', delegationBlock().replace('## Vincoli\nSola lettura.\n', '')],
    [
      'sections out of order',
      delegationBlock()
        .replace('## Contesto', '## Tmp')
        .replace('## Obiettivo', '## Contesto')
        .replace('## Tmp', '## Obiettivo'),
    ],
    ['an empty section', delegationBlock().replace('Il file compila.', '')],
    ['a missing end marker', delegationBlock().replace('DELEGA>>>', '')],
    ['two blocks', `${delegationBlock()}\n${delegationBlock()}`],
    [
      'text before the first section',
      delegationBlock().replace('## Obiettivo', 'Ciao\n## Obiettivo'),
    ],
    [
      'an extra section',
      delegationBlock().replace('## Output atteso', '## Note\nx\n## Output atteso'),
    ],
  ])('rejects %s', (_label, answer) => {
    const parsed = parseDelegation(answer);
    expect(parsed.status).toBe('malformed');
    if (parsed.status === 'malformed') expect(parsed.errors.length).toBeGreaterThan(0);
  });

  it('builds a template that the parser recognises once filled', () => {
    expect(parseDelegation(delegationTemplate().replaceAll('<testo>', 'x')).status).toBe('valid');
  });
});
