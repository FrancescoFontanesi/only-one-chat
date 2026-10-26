// Recorded CLI transcripts (Codex, Claude) are committed to a public repository: every
// fixture must be free of secrets, e-mail addresses and personal paths. The
// scanner is checked against a sample built to trip every rule.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findLeaks, localNames, personalNames, redactTranscript } from '../dev/redact.js';

const FIXTURES = join(import.meta.dirname, 'fixtures');
const LOCAL = localNames();

function fixtureFiles(): string[] {
  return readdirSync(FIXTURES, { recursive: true, encoding: 'utf8' })
    .filter((path) => path.endsWith('.jsonl'))
    .map((path) => join(FIXTURES, path));
}

describe('recorded CLI fixtures', () => {
  it('exist for every CLI', () => {
    for (const cli of ['codex', 'claude']) {
      expect(fixtureFiles().some((path) => path.includes(join('fixtures', cli)))).toBe(true);
    }
  });

  it.each(fixtureFiles().map((path) => [path.slice(FIXTURES.length + 1), path]))(
    '%s contains no secrets, e-mails or personal paths',
    (_name, path) => {
      expect(findLeaks(readFileSync(path, 'utf8'), LOCAL)).toEqual([]);
    },
  );
});

describe('leak scanner', () => {
  // Built to fail: one occurrence for every rule.
  const sample = [
    '{"message":{"result":{"account":{"type":"chatgpt","email":"someone@example.com"}}}}',
    '{"token":"eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.c2lnbmF0dXJlLXZhbHVl"}',
    '{"key":"sk-proj-abcdefghijklmnop"}',
    '{"header":"Bearer abcdefghijklmnopqrstuvwxyz"}',
    '{"codexHome":"C:\\\\Users\\\\alice\\\\AppData\\\\Local\\\\Temp\\\\codex"}',
    '{"path":"/home/alice/.codex"}',
    '{"path":"C:\\\\Users\\\\ALICE~1\\\\AppData"}',
    '{"installationId":"38bd11d2-f386-41e2-b59a-448b834a89f6"}',
    '{"authUrl":"https://auth.openai.com/oauth/authorize?state=abc123&scope=openid"}',
    '{"verificationUrl":"https://auth.openai.com/codex/device#code=XYZ"}',
    '{"userCode":"ABCD-1234","loginId":"login-1","serverName":"alice-laptop"}',
    '{"text":"recorded on alice-laptop"}',
  ].join('\n');

  it('flags every kind of leak in a sample built to fail', () => {
    const kinds = new Set(findLeaks(sample, ['alice-laptop']).map((leak) => leak.kind));
    expect([...kinds].sort()).toEqual(
      [
        '8.3 short name',
        'api key',
        'bearer token',
        'email',
        'jwt',
        'local literal',
        'posix user path',
        'unredacted field',
        'url fragment',
        'url parameter',
        'uuid',
        'windows user path',
      ].sort(),
    );
  });

  it('flags nothing once the same data has been redacted', () => {
    const raw = [
      {
        type: 'message',
        dir: 'server',
        message: {
          id: 2,
          result: {
            type: 'chatgptDeviceCode',
            loginId: '38bd11d2-f386-41e2-b59a-448b834a89f6',
            verificationUrl: 'https://auth.openai.com/codex/device?user_code=ABCD-1234',
            userCode: 'ABCD-1234',
          },
        },
      },
      {
        type: 'message',
        dir: 'server',
        message: {
          result: {
            account: { type: 'chatgpt', email: 'someone@example.com', planType: 'plus' },
            codexHome: 'C:\\Users\\alice\\AppData\\Local\\Temp\\codex',
            accessToken: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.c2lnbmF0dXJlLXZhbHVl',
          },
        },
      },
      {
        type: 'message',
        dir: 'server',
        message: { error: { message: 'invalid login id: 38bd11d2-f386-41e2-b59a-448b834a89f6' } },
      },
      {
        type: 'stderr',
        text: 'log written to C:\\Users\\alice\\AppData\\codex.log on alice-laptop',
      },
    ];
    const redacted = redactTranscript(raw, [
      ['C:\\Users\\alice', '<HOME>'],
      ['alice-laptop', '<host>'],
    ]);
    const text = redacted.map((entry) => JSON.stringify(entry)).join('\n');
    expect(findLeaks(text, ['alice', 'alice-laptop'])).toEqual([]);
    // The same login id gets the same placeholder everywhere it appears.
    expect(text.match(/<login-id-1>/g)).toHaveLength(2);
    expect(text).toContain('"planType":"plus"');
  });
});

describe('generic account names', () => {
  it('are never personal: root, admin, administrator, user', () => {
    expect(personalNames(['root', 'Admin', 'administrator', 'user', 'alice', 'ab'])).toEqual([
      'alice',
    ]);
  });

  it('do not trip the scanner on Codex sub-agent paths, while a real name still does', () => {
    const fixture = '{"agentPath":"/root/env_read"}';
    expect(findLeaks(fixture, ['root'])).toEqual([]);
    expect(findLeaks('{"cwd":"/srv/alice/work"}', ['alice'])).toMatchObject([
      { kind: 'local literal', match: 'alice' },
    ]);
  });

  it('are not redacted, so the sub-agent paths in the fixtures stay intact', () => {
    const [entry] = redactTranscript(
      [{ agentPath: '/root/env_read' }],
      personalNames(['root']).map((name) => [name, '<user>'] as const),
    );
    expect(entry).toEqual({ agentPath: '/root/env_read' });
  });
});
