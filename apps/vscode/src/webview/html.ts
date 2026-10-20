// Builds the webview document. Kept free of `vscode` imports so the CSP can be
// unit-tested without an extension host.

import { randomBytes } from 'node:crypto';

export interface WebviewHtmlOptions {
  /** `webview.cspSource` of the hosting webview. */
  readonly cspSource: string;
  readonly nonce: string;
  readonly scriptUri: string;
  readonly styleUri: string;
  readonly title: string;
}

export function createNonce(): string {
  return randomBytes(16).toString('base64');
}

/**
 * Deny by default. Scripts run only with the per-load nonce, styles, fonts and
 * images only from the extension's own resources. No network access
 * (`connect-src` falls back to `default-src 'none'`), no inline styles.
 */
export function buildContentSecurityPolicy(cspSource: string, nonce: string): string {
  return [
    "default-src 'none'",
    `img-src ${cspSource} data:`,
    `style-src ${cspSource}`,
    `font-src ${cspSource}`,
    `script-src 'nonce-${nonce}'`,
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

export function renderWebviewHtml(options: WebviewHtmlOptions): string {
  const csp = buildContentSecurityPolicy(options.cspSource, options.nonce);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${escapeHtml(csp)}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${escapeHtml(options.styleUri)}">
  <title>${escapeHtml(options.title)}</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${escapeHtml(options.nonce)}" src="${escapeHtml(options.scriptUri)}"></script>
</body>
</html>`;
}
