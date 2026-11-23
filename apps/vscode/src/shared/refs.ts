// `@path` and `@path#L10-20` in a text (ADR 0015, 0018): the same syntax for
// the user and for the agents. Only tokens outside code count, so a decorator
// or a scoped package in a code block stays text; whether a path exists is for
// the host to tell. Pure, imported by the host and the webview alike.

interface RefToken {
  /** Where the token starts (its `@`) and ends in the text. */
  readonly start: number;
  readonly end: number;
  /** The path as written, without `@` and the line range. */
  readonly path: string;
  readonly lines?: { readonly from: number; readonly to: number };
}

const REF = /(^|\s)@([^\s@`'"<>|]+?)(?:#L(\d+)(?:-L?(\d+))?)?(?=$|[\s,;:!?)\]]|\.(?:$|\s))/g;

/** The ranges of the text inside code: fenced blocks and inline spans. */
function codeRanges(text: string): [number, number][] {
  const ranges: [number, number][] = [];
  const fence = /^[ \t]*```[^\n]*\n[\s\S]*?(?:^[ \t]*```[ \t]*$|(?![\s\S]))/gm;
  for (const match of text.matchAll(fence)) {
    ranges.push([match.index, match.index + match[0].length]);
  }
  const inline = /`[^`\n]+`/g;
  for (const match of text.matchAll(inline)) {
    const at = match.index;
    if (!ranges.some(([a, b]) => at >= a && at < b)) ranges.push([at, at + match[0].length]);
  }
  return ranges;
}

/** The `@` tokens of a text outside code, in order. */
export function refTokens(text: string): RefToken[] {
  const code = codeRanges(text);
  const tokens: RefToken[] = [];
  for (const match of text.matchAll(REF)) {
    const start = match.index + (match[1]?.length ?? 0);
    if (code.some(([a, b]) => start >= a && start < b)) continue;
    const path = match[2] ?? '';
    if (path === '') continue;
    const from = match[3] ? Number(match[3]) : undefined;
    const to = match[4] ? Number(match[4]) : from;
    tokens.push({
      start,
      end: match.index + match[0].length,
      path,
      ...(from !== undefined && to !== undefined
        ? { lines: { from: Math.min(from, to), to: Math.max(from, to) } }
        : {}),
    });
  }
  return tokens;
}

/** A path that names a file: it ends with an extension. A missing one of these is worth a warning. */
export function looksLikeFile(path: string): boolean {
  return /\.[A-Za-z0-9]{1,8}$/.test(path);
}

/** A line range written after a path: `#L10-20`, `#L10`, `:10`, `:10:5` (column ignored). */
const LINES = /(?:#L(\d+)(?:-L?(\d+))?|:(\d+)(?::\d+)?)$/;

/**
 * The file a link of an agent's Markdown points to, or a path written as
 * inline code: `file:///C:/a/b.py`, `src/b.py#L3-9`, `b.py:12`. Null for a
 * web address or anything that is not a path; whether it exists is for the host.
 */
export function linkPath(raw: string): {
  readonly path: string;
  readonly lines?: { readonly from: number; readonly to: number };
} | null {
  let path = raw.trim();
  if (/^[a-z][a-z0-9+.-]*:/i.test(path) && !/^file:/i.test(path) && !/^[a-z]:[\\/]/i.test(path)) {
    return null; // http:, mailto:, vscode: … but not a Windows drive
  }
  if (/^file:/i.test(path)) {
    try {
      path = decodeURIComponent(path.replace(/^file:\/*/i, '/')).replace(/^\/([a-z]:)/i, '$1');
    } catch {
      return null;
    }
  }
  const range = LINES.exec(path);
  if (range) path = path.slice(0, range.index);
  if (path === '') return null;
  const from = Number(range?.[1] ?? range?.[3] ?? NaN);
  const to = Number(range?.[2] ?? from);
  return Number.isFinite(from)
    ? { path, lines: { from: Math.min(from, to), to: Math.max(from, to) } }
    : { path };
}

/**
 * What an agent's text may name as a file besides `@path`: the targets of its
 * Markdown links and the inline code that looks like a path (a `/` in it, or
 * an extension). As written; the host keeps those that exist in the folder.
 */
export function pathCandidates(text: string): string[] {
  const out = new Set<string>();
  for (const match of text.matchAll(/\[[^\]\n]+\]\(([^)\s]+)/g)) {
    if (match[1] && linkPath(match[1])) out.add(match[1]);
  }
  for (const match of text.matchAll(/`([^`\n]+)`/g)) {
    const code = match[1] ?? '';
    const target = linkPath(code);
    if (
      target &&
      /^[\w.\\/:~-]+$/.test(code) &&
      (target.path.includes('/') || looksLikeFile(target.path))
    ) {
      out.add(code);
    }
  }
  return [...out];
}
