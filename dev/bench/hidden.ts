// Hidden acceptance tests of a sandbox scenario: each case runs the program
// the agents wrote as a process in their working directory and checks its
// stdout, stderr and exit code. The cases live in the repository and are never
// copied into that directory.

import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

export interface HiddenCase {
  readonly name: string;
  readonly args: readonly string[];
  readonly stdin?: string;
  /**
   * Files the case needs in the working directory, created before it and
   * removed after: a text, or a text repeated. `<OUTSIDE>` in a file, in
   * `stdin` or in `args` is the absolute path of a file outside the working
   * directory that holds `outside` (a secret the program must not read);
   * `<OUTSIDE_REL>` is the same file as a relative path from it.
   */
  readonly files?: Readonly<
    Record<string, string | { readonly repeat: string; readonly times: number }>
  >;
  readonly outside?: string;
  /** Exact stdout, lines compared without trailing whitespace. */
  readonly stdout?: string;
  readonly stderrIncludes?: string;
  /** Text stderr must not hold, e.g. `Traceback`: an error must be one the program reports. */
  readonly stderrExcludes?: string;
  readonly exitCode: number;
}

export interface HiddenSuite {
  readonly command: readonly string[];
  readonly cases: readonly HiddenCase[];
}

export interface CaseResult {
  readonly name: string;
  readonly passed: boolean;
  /** Why it failed, for the report. */
  readonly reason?: string;
}

export interface HiddenResults {
  readonly passed: number;
  readonly total: number;
  readonly cases: readonly CaseResult[];
}

/** A suite, after the cases of the suites it includes (paths relative to it). */
export function loadSuite(path: string): HiddenSuite {
  const suite = JSON.parse(readFileSync(path, 'utf8')) as HiddenSuite & {
    include?: readonly string[];
  };
  const included = (suite.include ?? []).flatMap(
    (other) => loadSuite(join(dirname(path), other)).cases,
  );
  return { command: suite.command, cases: [...included, ...suite.cases] };
}

function normalize(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .trim();
}

function runCase(
  suite: HiddenSuite,
  test: HiddenCase,
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; code: number | null; timedOut: boolean }> {
  const [program = 'python', ...programArgs] = suite.command;
  return new Promise((resolve) => {
    const child = spawn(program, [...programArgs, ...test.args], {
      cwd,
      env,
      stdio: 'pipe',
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
    child.on('error', (error) => {
      stderr += String(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code, timedOut });
    });
    child.stdin.end(test.stdin ?? '');
  });
}

/** The run directory as `<RUN>` in program output, however it is escaped there. */
function scrubber(cwd: string): (text: string) => string {
  // Python's messages quote paths with doubled backslashes.
  const forms = new Set([cwd, cwd.replaceAll('\\', '/'), cwd.replaceAll('\\', '\\\\')]);
  const ordered = [...forms].sort((a, b) => b.length - a.length);
  return (text) => ordered.reduce((out, form) => out.split(form).join('<RUN>'), text);
}

/** Puts a case's files in place; returns the case with its placeholders filled, and the cleanup. */
function setUp(test: HiddenCase, cwd: string): { test: HiddenCase; cleanUp: () => void } {
  const outsideDir = `${cwd}-outside`;
  const outsideFile = join(outsideDir, 'secret.calc');
  const absolute = outsideFile.replaceAll('\\', '/');
  const relative = `../${basename(outsideDir)}/secret.calc`;
  const fill = (text: string) =>
    text
      .replaceAll('<OUTSIDE_REL_BS>', relative.replaceAll('/', '\\'))
      .replaceAll('<OUTSIDE_REL>', relative)
      .replaceAll('<OUTSIDE>', absolute);
  const made: string[] = [];
  for (const [name, content] of Object.entries(test.files ?? {})) {
    const path = join(cwd, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      typeof content === 'string' ? fill(content) : content.repeat.repeat(content.times),
    );
    made.push(path);
  }
  if (test.outside !== undefined) {
    mkdirSync(outsideDir, { recursive: true });
    writeFileSync(outsideFile, test.outside);
  }
  return {
    test: {
      ...test,
      args: test.args.map(fill),
      ...(test.stdin === undefined ? {} : { stdin: fill(test.stdin) }),
    },
    cleanUp: () => {
      for (const path of made) rmSync(path, { force: true });
      rmSync(outsideDir, { recursive: true, force: true });
    },
  };
}

/** Runs every case; a missing program or a timeout is a failed case, not an error. */
export async function runHiddenTests(
  suite: HiddenSuite,
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs = 10_000,
): Promise<HiddenResults> {
  const cases: CaseResult[] = [];
  const scrub = scrubber(cwd);
  for (const original of suite.cases) {
    const { test, cleanUp } = setUp(original, cwd);
    let raw: Awaited<ReturnType<typeof runCase>>;
    try {
      raw = await runCase(suite, test, cwd, env, timeoutMs);
    } finally {
      cleanUp();
    }
    const run = { ...raw, stdout: scrub(raw.stdout), stderr: scrub(raw.stderr) };
    const problems: string[] = [];
    if (run.timedOut) problems.push(`timed out after ${String(timeoutMs)} ms`);
    if (run.code !== test.exitCode) {
      problems.push(`exit code ${String(run.code)} instead of ${String(test.exitCode)}`);
    }
    if (test.stdout !== undefined && normalize(run.stdout) !== normalize(test.stdout)) {
      problems.push(
        `stdout ${JSON.stringify(normalize(run.stdout))} instead of ${JSON.stringify(test.stdout)}`,
      );
    }
    if (test.stderrIncludes !== undefined && !run.stderr.includes(test.stderrIncludes)) {
      problems.push(
        `stderr ${JSON.stringify(normalize(run.stderr))} lacks ${JSON.stringify(test.stderrIncludes)}`,
      );
    }
    if (test.stderrExcludes !== undefined && run.stderr.includes(test.stderrExcludes)) {
      problems.push(`stderr holds ${JSON.stringify(test.stderrExcludes)}`);
    }
    cases.push(
      problems.length === 0
        ? { name: test.name, passed: true }
        : { name: test.name, passed: false, reason: problems.join('; ') },
    );
  }
  return { passed: cases.filter((c) => c.passed).length, total: cases.length, cases };
}
