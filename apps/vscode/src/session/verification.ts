import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { OWN_PROCESS_GROUP, terminateTree, withoutApiKeys } from '@only-one-chat/adapters';
import {
  isTestFile,
  type TestSelection,
  type VerificationEvidence,
  type VerificationResult,
  type WorkVerification,
} from '@only-one-chat/runtime';
import type { VerificationCheckpoint } from '../../../../packages/runtime/src/verification.js';
import { CheckpointStore, type Checkpoint } from './checkpoints.js';
import { readJUnit, MAX_REPORT_BYTES, type TestResult } from './junit.js';
import { copyVerificationDependencies } from './verificationDependencies.js';

interface Run extends VerificationResult {
  readonly xml?: string;
  readonly reportHash?: string | undefined;
  readonly tests: readonly TestResult[];
  readonly output: string;
}
interface Options {
  readonly cwd: string;
  readonly command: readonly string[];
  readonly store?: CheckpointStore | undefined;
  readonly id: () => string;
  readonly update: (evidence: VerificationEvidence) => void;
  /** The command is about to run in the working folder, where it may write. */
  readonly onRun?: () => void;
  readonly timeoutMs?: number;
}

async function execute(
  command: readonly string[],
  cwd: string,
  report: string,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<Run> {
  signal.throwIfAborted();
  if (command.length === 0)
    return {
      status: 'unavailable',
      summary: 'No verification command configured',
      tests: [],
      output: '',
    };
  const args = command.map((part) => part.replaceAll('{junit}', report));
  const [program = '', ...parameters] = args;
  const child = spawn(program, parameters, {
    cwd,
    env: withoutApiKeys(process.env),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    detached: OWN_PROCESS_GROUP,
  });
  let output = '';
  const state = { stopped: false, spawnError: '' };
  let stopping: Promise<void> | undefined;
  const stop = () => {
    state.stopped = true;
    stopping ??= (async () => {
      if (child.pid !== undefined) {
        await terminateTree(child.pid, 'SIGKILL').catch(() => {
          child.kill();
        });
      }
      child.stdout.destroy();
      child.stderr.destroy();
    })();
  };
  signal.addEventListener('abort', stop, { once: true });
  const timer = setTimeout(stop, timeoutMs);
  child.stdout.setEncoding('utf8').on('data', (text: string) => {
    output = (output + text).slice(-32768);
  });
  child.stderr.setEncoding('utf8').on('data', (text: string) => {
    output = (output + text).slice(-32768);
  });
  child.on('error', (error) => {
    state.spawnError = error.message;
  });
  const code = await new Promise<number | null>((done) => {
    child.once('close', done);
  });
  clearTimeout(timer);
  signal.removeEventListener('abort', stop);
  await stopping;
  signal.throwIfAborted();
  if (state.stopped || state.spawnError)
    return {
      status: 'inconclusive',
      summary: state.stopped ? 'Verification timed out' : state.spawnError,
      tests: [],
      output,
    };
  let tests: TestResult[] = [];
  let xml = '';
  try {
    if (lstatSync(report).isSymbolicLink() || statSync(report).size > MAX_REPORT_BYTES)
      throw new Error('Unsafe or oversized JUnit report');
    xml = readFileSync(report, 'utf8');
    tests = readJUnit(xml);
  } catch (error) {
    if (!command.some((part) => part.includes('{junit}'))) {
      return {
        status: code === 0 ? 'passed' : 'inconclusive',
        exitCode: code,
        summary: `Verification exit ${String(code)}; JUnit not configured`,
        tests,
        output,
      };
    }
    return {
      status: 'inconclusive',
      exitCode: code,
      summary: `JUnit unavailable: ${error instanceof Error ? error.message : String(error)}`,
      tests,
      xml,
      output,
    };
  }
  if (tests.some((test) => test.status === 'error'))
    return {
      status: 'inconclusive',
      exitCode: code,
      summary: 'JUnit reports a test execution error',
      tests,
      xml,
      output,
    };
  const failed = tests.filter((test) => test.status === 'failed');
  if (failed.length > 0 && code !== null && code !== 0) {
    return {
      status: 'failed',
      summary: `Runtime tests failed (${String(failed.length)})`,
      tests,
      xml,
      output,
    };
  }
  if (code !== 0 || failed.length > 0 || !tests.some((test) => test.status === 'passed')) {
    return {
      status: 'inconclusive',
      exitCode: code,
      summary: 'Process exit and JUnit outcomes do not establish success',
      tests,
      xml,
      output,
    };
  }
  return { status: 'passed', summary: 'Runtime verification passed', tests, xml, output };
}

function selected(run: Run, selection: TestSelection): TestResult {
  const matches = run.tests.filter(
    (test) => test.name === selection.name && test.className === selection.className,
  );
  if (matches.length !== 1) throw new Error('Selected test missing or ambiguous in JUnit');
  const test = matches[0];
  if (!test || test.status === 'error' || test.status === 'skipped')
    throw new Error('Selected test did not execute normally');
  return test;
}

/** One task's baseline and bounded command evidence, owned by the extension host. */
export class WorkspaceVerification implements WorkVerification {
  private active = false;
  private id = '';
  private base: Checkpoint | null = null;
  private baselineReference: string | null = null;
  private cached: { key: string; run: Run } | undefined;
  private round = 0;
  private budget = 0;
  private reviewVerdict: string | undefined;
  // An explicit field, not a parameter property: the bench runs this file with Node's type stripping.
  private readonly options: Options;

  constructor(options: Options) {
    this.options = options;
  }

  checkpoint(): VerificationCheckpoint | undefined {
    return this.active
      ? { id: this.id, baseline: this.baselineReference, round: this.round, budget: this.budget }
      : undefined;
  }

  restore(saved: VerificationCheckpoint | undefined): void {
    this.reset();
    if (!saved) return;
    this.active = true;
    this.id = saved.id;
    this.base = saved.baseline ? (this.options.store?.load(saved.baseline) ?? null) : null;
    this.baselineReference = saved.baseline;
    this.round = saved.round;
    this.budget = saved.budget;
  }

  reset(): void {
    this.active = false;
    this.base = null;
    this.baselineReference = null;
    this.cached = undefined;
  }

  beginReview(): void {
    this.reset();
    this.active = true;
    this.id = this.options.id();
  }

  begin(): void {
    if (this.active) return;
    this.active = true;
    this.id = this.options.id();
    this.base = this.capture(this.id);
    this.baselineReference = this.base?.id ?? null;
    this.cached = undefined;
    this.round = 0;
    this.budget = 0;
    this.reviewVerdict = undefined;
  }

  progress(round: number, budget: number): void {
    this.begin();
    this.round = round;
    this.budget = budget;
    this.reviewVerdict = undefined;
    this.publish(
      { status: 'unavailable', summary: 'Review in progress' },
      undefined,
      'reviewer',
      'pending',
      '',
    );
  }

  private capture(id = this.options.id()): Checkpoint | null {
    try {
      return this.options.store?.take(id) ?? null;
    } catch {
      return null;
    }
  }

  private async run(at: Checkpoint | null, signal: AbortSignal): Promise<Run> {
    const root = mkdtempSync(join(tmpdir(), 'ooc-check-'));
    try {
      const cwd = this.options.command.some((part) => part.includes('{junit}'))
        ? root
        : this.options.cwd;
      if (cwd === root) {
        if (!at || !this.options.store) throw new Error('Workspace checkpoint unavailable');
        this.options.store.materialize(at, root);
        await copyVerificationDependencies(this.options.cwd, root, at, signal);
      } else this.options.onRun?.();
      const report = join(root, '.ooc-junit.xml');
      // Ignore any old or agent-produced report copied with the workspace.
      rmSync(report, { force: true });
      const result = await execute(
        this.options.command,
        cwd,
        report,
        signal,
        this.options.timeoutMs ?? 120000,
      );
      if (cwd === root && at) {
        for (const [path, hash] of Object.entries(at.files)) {
          if (path === '.ooc-junit.xml') continue;
          const file = join(root, path);
          const rel = existsSync(file) ? relative(root, realpathSync(file)) : '..';
          if (
            !existsSync(file) ||
            !lstatSync(file).isFile() ||
            rel.startsWith('..') ||
            isAbsolute(rel) ||
            createHash('sha256').update(readFileSync(file)).digest('hex') !== hash
          ) {
            return {
              status: 'inconclusive',
              summary: 'Verification changed captured source or test files',
              tests: [],
              output: result.output,
            };
          }
        }
      }
      return {
        ...result,
        reportHash: result.xml ? this.options.store?.keepArtifact(result.xml) : undefined,
      };
    } catch (error) {
      signal.throwIfAborted();
      return {
        status: 'inconclusive',
        summary: error instanceof Error ? error.message : String(error),
        tests: [],
        output: '',
      };
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  private key(at: Checkpoint | null): string {
    return createHash('sha256')
      .update(JSON.stringify([at?.files, at?.large, at?.incomplete, this.options.command]))
      .digest('hex');
  }

  async check(
    selection: TestSelection | undefined,
    origin: 'implementer' | 'reviewer',
    signal: AbortSignal,
    reviewVerdict?: string,
  ): Promise<VerificationResult> {
    this.begin();
    if (reviewVerdict !== undefined) this.reviewVerdict = reviewVerdict;
    const at = this.capture();
    const key = this.key(at);
    const run = at && this.cached?.key === key ? this.cached.run : await this.run(at, signal);
    this.cached = { key, run };
    this.publish(run, selection, origin, 'pending', run.output);
    const failing = run.tests
      .filter((test) => test.status !== 'passed')
      .slice(0, 8)
      .map((test) => `${test.className} / ${test.name}\n${test.detail}`)
      .join('\n');
    return {
      status: run.status,
      summary: run.summary,
      // Without JUnit details, the output's tail is all that says what failed.
      detail: (
        failing || (run.status === 'passed' ? '' : run.output.split(/\r?\n/).slice(-40).join('\n'))
      ).slice(0, 16384),
      ...(run.exitCode !== undefined ? { exitCode: run.exitCode } : {}),
    };
  }

  private publish(
    run: VerificationResult,
    selection: TestSelection | undefined,
    origin: 'implementer' | 'reviewer',
    comparison: VerificationEvidence['comparison'],
    detail: string,
    baselineReportHash?: string,
  ): void {
    this.options.update({
      status: run.status,
      summary: run.summary.slice(0, 16384),
      reportHash: this.cached?.run.reportHash,
      baselineReportHash,
      id: this.id,
      origin,
      reviewVerdict: this.reviewVerdict,
      selection,
      comparison,
      round: this.round,
      budget: this.budget,
      detail: detail.slice(0, 65536),
    });
  }

  async finish(
    selection: TestSelection | undefined,
    origin: 'implementer' | 'reviewer',
    signal: AbortSignal,
  ): Promise<{ summary: string; result: VerificationResult }> {
    this.begin();
    const current = await this.check(selection, origin, signal);
    const run = this.cached?.run;
    let comparison: VerificationEvidence['comparison'] = 'unavailable';
    let detail = current.summary;
    let baselineReportHash: string | undefined;
    if (!selection) detail += '\nNo acceptance test selected';
    else if (!this.base || !this.options.store || !run)
      detail += '\nStarting checkpoint unavailable';
    else if (!this.options.command.some((part) => part.includes('{junit}')))
      detail += '\nConfigure {junit} in the verification command';
    else {
      const final = this.capture();
      const files = { ...this.base.files };
      try {
        if (!final) throw new Error('Final checkpoint unavailable');
        const dependencyFiles = new Set([
          ...Object.keys(this.base.files),
          ...Object.keys(final.files),
        ]);
        for (const path of dependencyFiles) {
          if (
            /(^|\/)(package\.json|pnpm-lock\.yaml|package-lock\.json|yarn\.lock|requirements[^/]*\.txt|pyproject\.toml|poetry\.lock|uv\.lock|Cargo\.(toml|lock)|go\.(mod|sum))$/.test(
              path,
            ) &&
            this.base.files[path] !== final.files[path]
          ) {
            throw new Error(
              'Package or dependency inputs changed; the original toolchain cannot be reconstructed',
            );
          }
        }
        for (const path of selection.files) {
          const rel = relative(this.options.cwd, resolve(this.options.cwd, path));
          if (
            isAbsolute(path) ||
            !rel ||
            rel.startsWith('..') ||
            isAbsolute(rel) ||
            !isTestFile(path)
          ) {
            throw new Error('Unsafe test overlay path');
          }
          const hash = final.files[path];
          if (!hash) throw new Error('Selected test file is not recorded');
          files[path] = hash;
        }
        selected(run, selection);
        comparison = 'inconclusive';
        if (run.status === 'passed' && selected(run, selection).status === 'passed') {
          const before = await this.run({ ...this.base, files }, signal);
          baselineReportHash = before.reportHash;
          const baselineTest = selected(before, selection);
          if (before.status === 'passed' && baselineTest.status === 'passed')
            comparison = 'already_passed';
          if (
            before.status === 'failed' &&
            baselineTest.status === 'failed' &&
            baselineTest.detail.includes(selection.expectedFailure)
          )
            comparison = 'confirmed';
          detail += `\nBefore: ${before.summary}\nSelected baseline result: ${baselineTest.status}\n${baselineTest.detail}\n${before.output}`;
        }
      } catch (error) {
        signal.throwIfAborted();
        detail += `\nComparison unavailable: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    if (run?.output) detail += `\nFinal output:\n${run.output}`;
    if (run)
      detail +=
        '\n' +
        run.tests
          .filter((test) => test.status !== 'passed')
          .map((test) => `${test.className} / ${test.name}: ${test.status}\n${test.detail}`)
          .join('\n');
    this.publish(current, selection, origin, comparison, detail, baselineReportHash);
    return {
      summary: `Runtime verification: ${current.status}. Red-green: ${comparison}. Test selected by ${origin}.`,
      result: current,
    };
  }
}
