// `@` in the composer (ADR 0015): the word being typed after an `@`, and the
// folder's paths that match it. Pure functions, so they can be tested.

/** The `@` word the caret is in: where it starts and what follows the `@`. */
export function mentionAt(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const match = /(^|\s)@([^\s@]*)$/.exec(before);
  if (!match) return null;
  const query = match[2] ?? '';
  return { start: caret - query.length - 1, query };
}

/**
 * The paths that match, best first: the file name starting with the query,
 * then the path containing it; at most `limit`.
 */
export function matchPaths(paths: readonly string[], query: string, limit = 8): string[] {
  const q = query.toLowerCase();
  const scored: { path: string; score: number }[] = [];
  for (const path of paths) {
    const lower = path.toLowerCase();
    const name = lower.replace(/\/$/, '').split('/').at(-1) ?? lower;
    const score =
      q === '' ? 3 : name.startsWith(q) ? 0 : lower.startsWith(q) ? 1 : lower.includes(q) ? 2 : -1;
    if (score >= 0) scored.push({ path, score });
  }
  return scored
    .sort(
      (a, b) => a.score - b.score || a.path.length - b.path.length || a.path.localeCompare(b.path),
    )
    .slice(0, limit)
    .map((s) => s.path);
}

/** The text with the `@` word replaced by the chosen path, and where the caret goes. */
export function pickMention(
  text: string,
  mention: { start: number; query: string },
  path: string,
): { text: string; caret: number } {
  const end = mention.start + 1 + mention.query.length;
  const rest = text.slice(end);
  const folder = path.endsWith('/');
  // A file is followed by a space, once; a folder waits for a file in it.
  const space = folder || /^\s/.test(rest) ? '' : ' ';
  const inserted = `@${path}${space}`;
  return {
    text: text.slice(0, mention.start) + inserted + rest,
    caret: mention.start + inserted.length + (!folder && space === '' ? 1 : 0),
  };
}
