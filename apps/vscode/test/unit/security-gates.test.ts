// The host's security checks as pure functions (ADR 0050): the Workspace Trust
// gate and the consent before agents start, the webview options, and the
// checks before a setting is written.

import { describe, expect, it } from 'vitest';
import {
  agentsGate,
  checkedValue,
  consentQuestion,
  isUserOnly,
  webviewOptions,
  writeRefusal,
} from '../../src/webview/security-gates.js';

describe('agents gate (security.md T11)', () => {
  it('starts no agent without a folder, or in an untrusted one', () => {
    expect(agentsGate(null, true, false, undefined)).toEqual({
      ok: false,
      reason: 'Open the folder where the agents should work.',
    });
    expect(agentsGate('F:/w', false, false, undefined)).toEqual({
      ok: false,
      reason: 'Trust this workspace before starting the agents.',
    });
    // Not even with the fake CLIs, nor once agreed to.
    expect(agentsGate('F:/w', false, true, 'F:/w').ok).toBe(false);
  });

  it('asks consent once per folder, never for the fake CLIs', () => {
    expect(agentsGate('F:/w', true, false, undefined)).toEqual({ ok: true, consent: true });
    expect(agentsGate('F:/w', true, false, 'F:/w')).toEqual({ ok: true, consent: false });
    expect(agentsGate('F:/other', true, false, 'F:/w')).toEqual({ ok: true, consent: true });
    expect(agentsGate('F:/w', true, true, undefined)).toEqual({ ok: true, consent: false });
    expect(consentQuestion('F:/w')).toContain('Agents will work in F:/w');
  });
});

describe('webview options (security.md T6)', () => {
  it('runs scripts, with no forms, no command links, and only the given roots', () => {
    expect(webviewOptions(['dist', 'media'])).toEqual({
      enableScripts: true,
      enableForms: false,
      enableCommandUris: false,
      localResourceRoots: ['dist', 'media'],
    });
  });
});

describe('settings writes (ADR 0013)', () => {
  it('keeps machine and application settings out of the folder’s settings', () => {
    expect(isUserOnly('machine')).toBe(true);
    expect(isUserOnly('application')).toBe(true);
    expect(isUserOnly('window')).toBe(false);
    expect(isUserOnly(undefined)).toBe(false);
    expect(writeRefusal('workspace', 'machine', true)).toBe('This is a user setting.');
    expect(writeRefusal('user', 'machine', true)).toBeUndefined();
    expect(writeRefusal('workspace', 'window', false)).toBe('Open a folder first.');
    expect(writeRefusal('workspace', 'window', true)).toBeUndefined();
  });

  it('writes only a value of the setting’s kind and limits', () => {
    expect(checkedValue({ kind: 'boolean' }, 'yes')).toBeUndefined();
    expect(checkedValue({ kind: 'enum', options: [{ value: 'a' }] }, 'b')).toBeUndefined();
    expect(checkedValue({ kind: 'enum', options: [{ value: 'a' }] }, 'a')).toBe('a');
    expect(checkedValue({ kind: 'number', min: 0, max: 100 }, 101)).toBeUndefined();
    expect(checkedValue({ kind: 'number', min: 0, max: 100 }, Number.NaN)).toBeUndefined();
    expect(checkedValue({ kind: 'string' }, 'a\nb')).toBeUndefined();
    expect(checkedValue({ kind: 'string' }, ' x ')).toBe('x');
    expect(checkedValue({ kind: 'string' }, 'x'.repeat(501))).toBeUndefined();
    expect(checkedValue({ kind: 'text' }, 'x'.repeat(20_001))).toBeUndefined();
    expect(checkedValue({ kind: 'list' }, ['pytest', ' '])).toBeUndefined();
    expect(
      checkedValue(
        { kind: 'list' },
        Array.from({ length: 51 }, () => 'x'),
      ),
    ).toBeUndefined();
    expect(checkedValue({ kind: 'list' }, [' pytest '])).toEqual(['pytest']);
  });
});
