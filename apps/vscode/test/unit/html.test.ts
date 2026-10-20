import { describe, expect, it } from 'vitest';
import {
  buildContentSecurityPolicy,
  createNonce,
  renderWebviewHtml,
} from '../../src/webview/html.js';

const cspSource = 'https://file+.vscode-resource.vscode-cdn.net';

describe('buildContentSecurityPolicy', () => {
  const csp = buildContentSecurityPolicy(cspSource, 'abc123');
  const directives = new Map(
    csp.split(';').map((part) => {
      const [name = '', ...values] = part.trim().split(/\s+/);
      return [name, values];
    }),
  );

  it('denies everything by default', () => {
    expect(directives.get('default-src')).toEqual(["'none'"]);
  });

  it('allows scripts only through the nonce', () => {
    expect(directives.get('script-src')).toEqual(["'nonce-abc123'"]);
  });

  it('never allows inline or eval code', () => {
    expect(csp).not.toContain('unsafe-inline');
    expect(csp).not.toContain('unsafe-eval');
  });

  it('does not open network access', () => {
    expect(directives.has('connect-src')).toBe(false);
    expect(csp).not.toMatch(/\bhttps?:\/\/(?!file\+\.vscode-resource)/);
  });

  it('restricts styles and fonts to extension resources', () => {
    expect(directives.get('style-src')).toEqual([cspSource]);
    expect(directives.get('font-src')).toEqual([cspSource]);
  });
});

describe('renderWebviewHtml', () => {
  const html = renderWebviewHtml({
    cspSource,
    nonce: 'n0nce',
    scriptUri: 'https://example.invalid/main.js',
    styleUri: 'https://example.invalid/webview.css',
    title: 'A <b>"title"</b>',
  });

  it('embeds the CSP meta tag', () => {
    expect(html).toContain('http-equiv="Content-Security-Policy"');
  });

  it('loads exactly one script, carrying the nonce', () => {
    expect(html.match(/<script\b/g)).toHaveLength(1);
    expect(html).toContain('<script nonce="n0nce" src="https://example.invalid/main.js">');
  });

  it('escapes interpolated values', () => {
    expect(html).toContain('<title>A &lt;b&gt;&quot;title&quot;&lt;/b&gt;</title>');
  });
});

describe('createNonce', () => {
  it('returns a distinct 128-bit base64 value each time', () => {
    const a = createNonce();
    expect(Buffer.from(a, 'base64')).toHaveLength(16);
    expect(createNonce()).not.toBe(a);
  });
});
