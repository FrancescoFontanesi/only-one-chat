import { describe, expect, it } from 'vitest';
import { parseDelegation } from '../src/index.js';
import { delegationBlock } from './fake-agents.js';

describe('delegation block', () => {
  it('parses a block after a plan, its body free', () => {
    const parsed = parseDelegation(delegationBlock());
    expect(parsed.status).toBe('valid');
    if (parsed.status !== 'valid') return;
    expect(parsed.delegation.text.startsWith('## Obiettivo')).toBe(true);
    expect(parsed.delegation.text).toContain('Nessuna');
    expect(parsed.delegation.text).not.toContain('DELEGA');
  });

  it('accepts CRLF line endings', () => {
    expect(parseDelegation(delegationBlock().replace(/\n/g, '\r\n')).status).toBe('valid');
  });

  it('reports an answer without markers as absent (a conclusion)', () => {
    expect(parseDelegation('Conclusione: tutto a posto.')).toEqual({ status: 'absent' });
  });

  it.each([
    ['a missing end marker', delegationBlock().replace('DELEGA>>>', '')],
    ['a missing start marker', delegationBlock().replace('<<<DELEGA', '')],
    ['two blocks', `${delegationBlock()}\n${delegationBlock()}`],
    ['the end marker before the start', 'DELEGA>>>\nx\n<<<DELEGA'],
    ['an empty block', '<<<DELEGA\nDELEGA>>>'],
  ])('rejects %s', (_label, answer) => {
    const parsed = parseDelegation(answer);
    expect(parsed.status).toBe('malformed');
    if (parsed.status === 'malformed') expect(parsed.errors.length).toBeGreaterThan(0);
  });

  it('reads the recipient from the start line, and none when it is not given', () => {
    const named = parseDelegation(delegationBlock('Domanda', 'Claude'));
    expect(named.status === 'valid' && named.delegation.recipient).toBe('claude');
    const plain = parseDelegation(delegationBlock());
    expect(plain.status === 'valid' && plain.delegation.recipient).toBeNull();
    const old = parseDelegation('<<<DELEGA @Claude\nx\nDELEGA>>>');
    expect(old.status === 'valid' && old.delegation.recipient).toBe('claude');
  });

  it('does not take a recipient written without @ as a start line', () => {
    const block = delegationBlock().replace('<<<DELEGA', '<<<DELEGA a Claude');
    expect(parseDelegation(block)).toMatchObject({ status: 'malformed' });
  });
});
