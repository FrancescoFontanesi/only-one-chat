// Checks on what a request changed, made by the runtime and not by a model
// (ADR 0030): the signs of a shortcut taken to make the checks pass: tests
// removed or skipped, checks switched off, files that change what is checked.
// They are flags to look at, not proofs: a test moved to another file also
// shows as a test removed. Pure: no `vscode`, no disk.

/** A file the request changed, with its text before and after; null: it did not exist. */
export interface TextChange {
  readonly path: string;
  readonly before: string | null;
  readonly after: string | null;
}

/** A test file, by the conventions of the usual languages and tools. */
export const TEST_FILE =
  /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)test_[^/]*\.py$|_test\.(py|go)$/;
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

function count(text: string | null, pattern: RegExp): number {
  return text === null ? 0 : (text.match(pattern)?.length ?? 0);
}

/**
 * The flags for the files a request changed, one line each; none when the
 * changes show none of these signs.
 */
/** Whether a path, with forward slashes, is a test file. */
export const isTestFile = (path: string): boolean => TEST_FILE.test(path.replaceAll('\\', '/'));

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
    'Runtime diff checks (flags for review):',
    ...(flags.length > 0 ? flags.map((flag) => `- ${flag}`) : ['- no flags']),
    ...(uncovered.length > 0
      ? [`Skipped because they were too large: ${uncovered.join(', ')}`]
      : []),
  ].join('\n');
}
