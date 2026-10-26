// Hidden acceptance tests of a sandbox scenario: each case runs the program
// the agents wrote as a process in their working directory and checks its
// stdout, stderr and exit code. The cases live in the repository and are never
// copied into that directory.

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';

export interface HiddenCase {
  readonly name: string;
  readonly args: readonly string[];
  readonly stdin?: string;
  /** Exact stdout, lines compared without trailing whitespace. */
  readonly stdout?: string;
  readonly stderrIncludes?: string;
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

export function loadSuite(path: string): HiddenSuite {
  return JSON.parse(readFileSync(path, 'utf8')) as HiddenSuite;
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

/** Runs every case; a missing program or a timeout is a failed case, not an error. */
export async function runHiddenTests(
  suite: HiddenSuite,
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs = 10_000,
): Promise<HiddenResults> {
  const cases: CaseResult[] = [];
  const scrub = scrubber(cwd);
  for (const test of suite.cases) {
    const raw = await runCase(suite, test, cwd, env, timeoutMs);
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
    cases.push(
      problems.length === 0
        ? { name: test.name, passed: true }
        : { name: test.name, passed: false, reason: problems.join('; ') },
    );
  }
  return { passed: cases.filter((c) => c.passed).length, total: cases.length, cases };
}
