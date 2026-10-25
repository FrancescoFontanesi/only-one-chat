// Redaction for recorded Codex transcripts, which are committed to a public
// repository. `redactTranscript` runs before anything is written to disk;
// `findLeaks` is the independent check the fixture test applies afterwards.
// Dev tooling only: nothing here ships in the extension.

/** Exact strings to replace wherever they appear (paths, user name, host name). */
export type RedactionLiterals = readonly (readonly [value: string, placeholder: string])[];

/**
 * Keys whose values are replaced whole. A label gets a number per distinct
 * value (`<login-id-1>`, `<login-id-2>`), so a start and its cancel still match.
 */
const KEY_LABELS: Readonly<Record<string, string>> = {
  email: 'email',
  loginId: 'login-id',
  userCode: 'user-code',
  installationId: 'installation-id',
  accountId: 'account-id',
  userId: 'user-id',
  chatgptAccountId: 'account-id',
  chatgptUserId: 'user-id',
  workspaceId: 'workspace-id',
};
/** Keys replaced by a fixed placeholder. */
const KEY_FIXED: Readonly<Record<string, string>> = {
  serverName: '<host>',
  codexHome: '<CODEX_HOME>',
};

const SECRET_KEY = /token|secret|password|api_?key|authorization|cookie|credential/i;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const JWT = /eyJ[\w-]{4,}\.[\w-]{4,}\.[\w-]{4,}/g;
const URL_PATTERN = /https?:\/\/[^\s"'<>]+/g;

function redactUrl(url: string): string {
  const query = url.indexOf('?');
  const hash = url.indexOf('#');
  const end = Math.min(...[query, hash].filter((at) => at >= 0), url.length);
  const base = url.slice(0, end);
  if (query < 0 || (hash >= 0 && hash < query)) return hash >= 0 ? `${base}#<redacted>` : base;
  const search = url.slice(query + 1, hash > query ? hash : undefined);
  const names = search
    .split('&')
    .filter(Boolean)
    .map((pair) => pair.split('=')[0] ?? '');
  return `${base}?${names.map((name) => `${name}=<redacted>`).join('&')}${hash > query ? '#<redacted>' : ''}`;
}

function replaceAllCaseInsensitive(text: string, value: string, placeholder: string): string {
  if (value === '') return text;
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text.replace(new RegExp(escaped, 'gi'), placeholder);
}

function visitFields(value: unknown, visit: (key: string, item: unknown) => void): void {
  if (Array.isArray(value)) {
    for (const item of value) visitFields(item, visit);
  } else if (typeof value === 'object' && value !== null) {
    for (const [key, item] of Object.entries(value)) {
      visit(key, item);
      visitFields(item, visit);
    }
  }
}

/**
 * Returns redacted deep copies of transcript entries. A first pass collects the
 * values of sensitive keys, so they are also replaced where they reappear inside
 * other strings (an error message quoting a login id, for example).
 */
export function redactTranscript(
  entries: readonly unknown[],
  literals: RedactionLiterals,
): unknown[] {
  const numbered = new Map<string, string>(); // value -> placeholder
  const counters = new Map<string, number>();
  const found = new Map<string, string>(
    literals.map(([value, placeholder]) => [value, placeholder]),
  );
  for (const entry of entries) {
    visitFields(entry, (key, item) => {
      if (typeof item !== 'string' || item === '') return;
      const label = KEY_LABELS[key];
      if (label !== undefined) {
        if (!numbered.has(`${label}\0${item}`)) {
          const n = (counters.get(label) ?? 0) + 1;
          counters.set(label, n);
          numbered.set(`${label}\0${item}`, `<${label}-${String(n)}>`);
        }
        found.set(item, numbered.get(`${label}\0${item}`) ?? '<redacted>');
      } else if (SECRET_KEY.test(key)) {
        found.set(item, '<redacted>');
      }
    });
  }
  const replacements = [...found]
    .filter(([value]) => value.length >= 3)
    .sort((a, b) => b[0].length - a[0].length);

  const redactString = (text: string): string => {
    // URLs first: their parameters go as a whole, whatever literal they contain.
    let out = text.replace(URL_PATTERN, redactUrl);
    for (const [value, placeholder] of replacements) {
      out = replaceAllCaseInsensitive(out, value, placeholder);
    }
    return out.replace(JWT, '<jwt>').replace(EMAIL, '<email>');
  };
  const redact = (value: unknown): unknown => {
    if (typeof value === 'string') return redactString(value);
    if (Array.isArray(value)) return value.map(redact);
    if (typeof value !== 'object' || value === null) return value;
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      const label = KEY_LABELS[key];
      const fixed = KEY_FIXED[key];
      if (item === null || item === '') out[key] = item;
      else if (label !== undefined)
        out[key] =
          (typeof item === 'string' ? numbered.get(`${label}\0${item}`) : undefined) ??
          `<${label}>`;
      else if (fixed !== undefined) out[key] = fixed;
      else if (SECRET_KEY.test(key) && typeof item === 'string') out[key] = '<redacted>';
      else out[key] = redact(item);
    }
    return out;
  };
  return entries.map(redact);
}

export interface Leak {
  readonly kind: string;
  readonly match: string;
}

const LEAK_PATTERNS: readonly (readonly [kind: string, pattern: RegExp])[] = [
  ['email', EMAIL],
  ['jwt', JWT],
  ['api key', /\bsk-[A-Za-z0-9_-]{10,}/g],
  ['bearer token', /Bearer\s+[A-Za-z0-9._~+/-]{10,}/g],
  // JSON escapes backslashes, so a Windows path appears with one or two of them.
  ['windows user path', /[A-Za-z]:(?:\\\\|\\|\/)Users(?:\\\\|\\|\/)(?!<)[^\\/"\s]+/gi],
  ['posix user path', /\/(?:home|Users)\/(?!<)[^/"\s]+/g],
  ['8.3 short name', /\b[A-Z0-9]{1,6}~[0-9]\b/g],
  ['uuid', /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi],
  ['url parameter', /https?:\/\/[^\s"']*[?&][\w.-]+=(?!<redacted>)[^&"\s#]+/g],
  ['url fragment', /https?:\/\/[^\s"'#]*#(?!<redacted>)[^\s"]+/g],
  [
    'unredacted field',
    /"(?:email|loginId|userCode|installationId|serverName|codexHome|accountId|userId|chatgptAccountId|chatgptUserId|workspaceId|accessToken|refreshToken|idToken|apiKey)"\s*:\s*"(?!<)[^"]*"/g,
  ],
];

/** Finds anything in `text` that looks like a secret or a personal value. */
export function findLeaks(text: string, literals: readonly string[] = []): Leak[] {
  const leaks: Leak[] = [];
  for (const [kind, pattern] of LEAK_PATTERNS) {
    for (const match of text.matchAll(pattern)) leaks.push({ kind, match: match[0] });
  }
  for (const literal of literals) {
    if (literal.length >= 3 && text.toLowerCase().includes(literal.toLowerCase())) {
      leaks.push({ kind: 'local literal', match: literal });
    }
  }
  return leaks;
}
