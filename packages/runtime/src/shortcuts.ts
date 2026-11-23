// Checks on what a request changed, made by the runtime and not by a model
// (ADR 0030): the signs of a shortcut taken to make the checks pass: tests
// removed or skipped, checks switched off, files that change what is checked.
// They are flags to look at, not proofs: a test moved to another file also
// shows as a test removed. Pure: no `vscode`, no disk.

import { TEST_FILE } from './contract.js';
import { DIFF_CHECKS_HEADER, DIFF_CHECKS_SKIPPED_PREFIX, NO_FLAGS } from './fact-headers.js';

/** A file the request changed, with its text before and after; null: it did not exist. */
export interface TextChange {
  readonly path: string;
  readonly before: string | null;
  readonly after: string | null;
}

const LOCKFILE =
  /(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|npm-shrinkwrap\.json|Cargo\.lock|poetry\.lock|uv\.lock|Pipfile\.lock|go\.sum|Gemfile\.lock|composer\.lock)$/;
/** What decides which checks run, and how strict they are. */
const CHECK_CONFIG =
  /(^|\/)(eslint\.config\.[cm]?[jt]s|\.eslintrc[^/]*|tsconfig[^/]*\.json|vitest\.config\.[cm]?[jt]s|jest\.config\.[cm]?[jt]s|pytest\.ini|tox\.ini|\.pre-commit-config\.yaml|\.gitlab-ci\.yml)$|(^|\/)\.(github\/workflows|husky)\//;

const CASES = /\b(?:it|test)(?:\.\w+)*\s*\(|\bdef\s+test_\w+|\bfunc\s+Test\w+/g;
const ASSERTIONS = /\bexpect\s*\(|\bassert\w*/g;
const SKIPS =
  /\b(?:it|test|describe)\.(?:skip|only)\b|\bx(?:it|describe)\b|\.only\s*\(|@pytest\.mark\.skip|@unittest\.skip|\bpytest\.skip\b|\bt\.Skip\b/g;
const SWITCHED_OFF =
  /eslint-disable|@ts-ignore|@ts-nocheck|@ts-expect-error|#\s*type:\s*ignore|#\s*noqa|#\s*pylint:\s*disable|\bas any\b|:\s*any\b/g;

/** Longer lines are not parsed. */
const MAX_LINE = 400;
const COMPARISON = /\b(assertEqual|assertIs|expect)\s*\(|^\s*assert\s/;
const EXPECT_EQUAL = /^\s*\.(?:toBe|toEqual|toStrictEqual)\(/;

/**
 * The pieces of `text` from `from`, split at the top-level `separator`, up to the
 * parenthesis that closes it (`closed`) or the end. Strings and nested brackets
 * are skipped; null when `closed` and it never closes.
 */
function pieces(
  text: string,
  from: number,
  separator: string,
  closed: boolean,
): { parts: string[]; end: number } | null {
  const parts: string[] = [];
  let depth = 0;
  let quote = '';
  let start = from;
  for (let i = from; i < text.length; i++) {
    const c = text.charAt(i);
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = '';
    } else if (c === '"' || c === "'" || c === '`') quote = c;
    else if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) {
      if (depth > 0) depth--;
      else if (closed) return { parts: [...parts, text.slice(start, i)], end: i };
    } else if (depth === 0 && text.startsWith(separator, i)) {
      parts.push(text.slice(start, i));
      start = i + separator.length;
      i = start - 1;
    }
  }
  return closed ? null : { parts: [...parts, text.slice(start)], end: text.length };
}

const same = (a: string | undefined, b: string | undefined) =>
  a !== undefined && b !== undefined && a.trim() !== '' && a.trim() === b.trim();

/** Assertions that compare an expression with itself: they pass whatever the code does. */
function selfComparisons(text: string | null): number {
  let found = 0;
  for (const line of text === null ? [] : text.split('\n')) {
    const call = line.length <= MAX_LINE ? COMPARISON.exec(line) : null;
    if (!call) continue;
    const at = call.index + call[0].length;
    if (call[1] === 'assertEqual' || call[1] === 'assertIs') {
      const args = pieces(line, at, ',', true)?.parts;
      if (same(args?.[0], args?.[1])) found++;
    } else if (call[1] === 'expect') {
      const actual = pieces(line, at, ',', true);
      const next = actual && EXPECT_EQUAL.exec(line.slice(actual.end + 1));
      const wanted = next && pieces(line, actual.end + 1 + next[0].length, ',', true);
      if (actual && wanted && same(actual.parts[0], wanted.parts[0])) found++;
    } else {
      const condition = pieces(line, at, ',', false)?.parts[0] ?? '';
      const sides = pieces(condition, 0, '==', false)?.parts;
      if (sides?.length === 2 && same(sides[0], sides[1])) found++;
    }
  }
  return found;
}

function count(text: string | null, pattern: RegExp): number {
  return text === null ? 0 : (text.match(pattern)?.length ?? 0);
}

/**
 * The flags for the files a request changed, one line each; none when the
 * changes show none of these signs.
 */
export function shortcutFlags(changes: readonly TextChange[]): string[] {
  const flags: string[] = [];
  for (const { path, before, after } of changes) {
    const test = TEST_FILE.test(path);
    if (test && before !== null && after === null) flags.push(`test removed: ${path}`);
    // A new test file has nothing to be weakened from.
    if (test && before !== null && after !== null) {
      const cases = [count(before, CASES), count(after, CASES)] as const;
      if (cases[1] < cases[0]) {
        flags.push(`${path}: test cases reduced from ${String(cases[0])} to ${String(cases[1])}`);
      }
      const checks = [count(before, ASSERTIONS), count(after, ASSERTIONS)] as const;
      if (checks[1] < checks[0]) {
        flags.push(`${path}: assertions reduced from ${String(checks[0])} to ${String(checks[1])}`);
      }
    }
    if (test) {
      const skipped = count(after, SKIPS) - count(before, SKIPS);
      if (skipped > 0) {
        flags.push(`${path}: new skipped or isolated tests (skip, only): ${String(skipped)}`);
      }
    }
    if (test && after !== null) {
      const tautologies = selfComparisons(after) - selfComparisons(before);
      if (tautologies > 0) {
        flags.push(
          `${path}: assertions that compare an expression with itself: ${String(tautologies)}`,
        );
      }
    }
    if (after !== null) {
      const off = count(after, SWITCHED_OFF) - count(before, SWITCHED_OFF);
      if (off > 0) {
        flags.push(`${path}: new check suppressions or type overrides: ${String(off)}`);
      }
    }
    if (LOCKFILE.test(path)) flags.push(`lockfile changed: ${path}`);
    else if (CHECK_CONFIG.test(path)) {
      flags.push(`check configuration changed: ${path}`);
    }
  }
  return flags;
}

/** The flags as the facts' text for the leader and the reviewer. */
export function shortcutFacts(
  changes: readonly TextChange[],
  /** Changed files too large to read: not checked. */
  uncovered: readonly string[] = [],
): string {
  const flags = shortcutFlags(changes);
  return [
    DIFF_CHECKS_HEADER,
    ...(flags.length > 0 ? flags.map((flag) => `- ${flag}`) : [NO_FLAGS]),
    ...(uncovered.length > 0 ? [`${DIFF_CHECKS_SKIPPED_PREFIX}${uncovered.join(', ')}`] : []),
  ].join('\n');
}
