// Does a reviewer find the defects that are really there? Dev tooling only (ADR 0046).
//
//   node --import ./dev/ts-resolve.mjs dev/review-check.ts [--case <name>]... [--runs N] \
//     [--reviewer cli:model:effort]... [--fake]
//
// The cases are in dev/review-cases/: a shared base project, and for each case
// the files it adds or changes, a brief, a report and a manifest (case.json:
// the expectation, the axis at stake, the defects with a keyword pattern each).
// Per run: a copy of base/ is the work folder, the facts' baseline is taken, the
// case is laid over it, and the facts and the diff checks are computed as the
// product does. The reviewer then runs as in the product: writable, the allowed
// commands in auto mode, its handoff tools, and the reviewer-turn guard. Two
// checks, in this order: the contract fields of its review or findings, then the
// keywords that name each expected defect. Needs a real reviewer (a CLI logged
// in); `--fake` only exercises the plumbing, since the fakes make no review.
// Default: every case, 3 runs, claude:claude-haiku-5-5:medium.
// Result: sandbox/results/review-check-*.json.

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  antigravityModelId,
  createAcpAgentFactory,
  createClaudeAgentFactory,
  createCodexAgentFactory,
  longPath,
  resolveClaudeExecutable,
  resolveCodexExecutable,
} from '../packages/adapters/src/index.js';
import {
  agentSessionOptions,
  handoffTools,
  readHandoff,
  renderFindings,
  renderReview,
  reviewRequestPrompt,
  reviewerInstructions,
  type AgentFactory,
  type Findings,
  type HandoffServer,
  type Review,
} from '../packages/runtime/src/index.js';
import { CheckpointStore } from '../apps/vscode/src/session/checkpoints.js';
import { snapshot, verifiedFacts } from '../apps/vscode/src/session/facts.js';
import { guardReviewerTurn } from '../apps/vscode/src/session/guard.js';

const REPO = join(import.meta.dirname, '..');
const CASES = join(REPO, 'dev', 'review-cases');
const env = process.env;
const VERIFY = ['python', '-m', 'unittest'];
/** The commands the reviewer may run, as the product's allowed commands. */
const COMMANDS = ['python'];
const FIXTURES = join(REPO, 'packages', 'adapters', 'test', 'fixtures');

/** The handoff server (ADR 0035), run from its source with the dev loader. */
const HANDOFF_SERVER: HandoffServer = {
  command: process.execPath,
  args: [
    '--import',
    pathToFileURL(join(REPO, 'dev', 'ts-resolve.mjs')).href,
    join(REPO, 'packages', 'runtime', 'src', 'handoff-main.ts'),
  ],
};

interface Manifest {
  readonly name: string;
  readonly expectation: 'clean' | 'defective';
  readonly axis: string | null;
  readonly defects: readonly { readonly id: string; readonly pattern: string }[];
}
interface Case extends Manifest {
  readonly dir: string;
  readonly brief: string;
  readonly report: string;
}

function arguments_(name: string): string[] {
  return process.argv.flatMap((arg, at) =>
    arg === `--${name}` ? [process.argv[at + 1] ?? ''] : [],
  );
}

function loadCases(names: readonly string[]): Case[] {
  const all = readdirSync(CASES, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(CASES, entry.name, 'case.json')))
    .map((entry) => {
      const dir = join(CASES, entry.name);
      const manifest = JSON.parse(readFileSync(join(dir, 'case.json'), 'utf8')) as Manifest;
      return {
        ...manifest,
        dir,
        brief: readFileSync(join(dir, 'brief.md'), 'utf8'),
        report: readFileSync(join(dir, 'report.md'), 'utf8'),
      };
    });
  const unknown = names.filter((name) => !all.some((c) => c.name === name));
  if (unknown.length > 0) {
    throw new Error(`no case ${unknown.join(', ')}; cases: ${all.map((c) => c.name).join(', ')}`);
  }
  return names.length > 0 ? all.filter((c) => names.includes(c.name)) : all;
}

/** The reviewer as the product runs it: writable, its commands in auto mode (providers.ts). */
async function reviewerFactory(spec: string, cwd: string, fake: boolean): Promise<AgentFactory> {
  // cli:model[:effort], e.g. antigravity:gemini-4-hydrogen:medium
  const [cli, model, effort = 'medium'] = spec.split(':');
  if ((cli !== 'claude' && cli !== 'codex' && cli !== 'antigravity') || !model) {
    throw new Error(`reviewer ${spec}: use claude|codex|antigravity:model[:effort]`);
  }
  if (cli === 'claude') {
    return createClaudeAgentFactory({
      executable: fake
        ? process.execPath
        : await resolveClaudeExecutable({ configuredPath: env['CLAUDE_EXECUTABLE'] ?? '' }),
      ...(fake ? { launcherArgs: [join(FIXTURES, 'fake-claude.mjs'), '--echo'] } : {}),
      cwd,
      model,
      effort,
      sandbox: { commands: COMMANDS, auto: true },
    });
  }
  if (cli === 'codex') {
    return createCodexAgentFactory({
      executable: fake
        ? process.execPath
        : await resolveCodexExecutable({ configuredPath: env['CODEX_EXECUTABLE'] ?? '' }),
      ...(fake
        ? { launcherArgs: [join(FIXTURES, 'fake-app-server.mjs'), '--account=chatgpt'] }
        : {}),
      cwd,
      model,
      effort,
      requestTimeoutMs: 120_000,
      writable: true,
      approvalPolicy: 'on-request',
      withoutUserHooks: true,
    });
  }
  return createAcpAgentFactory({
    executable: fake ? process.execPath : (env['AGY_EXECUTABLE'] ?? 'agy'),
    args: fake ? [join(FIXTURES, 'fake-agy.mjs'), 'acp'] : ['acp'],
    provider: 'Antigravity',
    cwd,
    model: antigravityModelId(model, effort),
    mode: env['OOC_ACP_MODE'] ?? 'auto',
    readOnly: false,
  });
}

/** What the reviewer gave, and whether it keeps the contract of the case, then its keywords. */
function evaluate(
  c: Case,
  review: Review | null,
  findings: Findings | null,
  fallback: string,
): {
  kind: 'review' | 'findings' | 'none';
  verdict: string | null;
  blocking: number;
  text: string;
  contract: string[];
  keywords: Record<string, boolean>;
} {
  // The review wins over findings in a turn; neither: the handoff was missed (ADR 0035).
  const kind = review ? 'review' : findings ? 'findings' : 'none';
  const text = review ? renderReview(review) : findings ? renderFindings(findings) : fallback;
  const blocking = review
    ? (review.open_findings ?? []).filter((f) => f.severity === 'blocking').length
    : (findings?.items ?? []).filter((f) => f.severity === 'blocking').length;
  const verdict = review ? review.verdict : null;
  const contract: string[] = [];
  if (kind === 'none') contract.push('no review or findings handoff');
  if (c.expectation === 'defective') {
    if (blocking === 0) contract.push('no blocking finding');
    if (review?.verdict === 'approved') contract.push('approved a defective case');
    if (c.axis === 'honesty' && review && review.axes.honesty === 'clean') {
      contract.push('honesty axis clean');
    }
  } else {
    if (kind === 'findings') contract.push('findings on a clean case');
    if (review && review.verdict !== 'approved') contract.push(`verdict ${review.verdict}`);
    if (blocking > 0) contract.push(`${String(blocking)} blocking finding(s)`);
  }
  // Only the blocking findings: a clean review explains correct code with the same words.
  const named = review
    ? (review.open_findings ?? [])
        .filter((f) => f.severity === 'blocking')
        .map((f) => `${f.issue} ${JSON.stringify(f)}`)
    : (findings?.items ?? [])
        .filter((f) => f.severity === 'blocking')
        .map((f) => `${f.issue} ${f.evidence}`);
  const keywords = Object.fromEntries(
    c.defects.map((d) => [d.id, named.some((one) => new RegExp(d.pattern, 'i').test(one))]),
  );
  return { kind, verdict, blocking, text, contract, keywords };
}

interface Row {
  readonly reviewer: string;
  readonly case: string;
  readonly run: number;
  readonly kind: string;
  readonly verdict: string | null;
  readonly blocking: number;
  /** Empty: the contract holds. */
  readonly contract: readonly string[];
  readonly keywords: Record<string, boolean>;
  readonly handoffCalls: number;
  readonly handoffErrors: readonly string[];
  readonly toolCalls: number;
  readonly denied: readonly string[];
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly durationMs: number | null;
  readonly guard: string;
  readonly facts: string;
  readonly text: string;
}

const ok = (row: Row) =>
  row.contract.length === 0 && Object.values(row.keywords).every((found) => found);

function table(rows: readonly Row[]): string {
  const head = ['run', 'kind', 'verdict', 'blocking', 'contract', 'keywords', 'calls', 'denied'];
  const lines = rows.map((r) => [
    String(r.run),
    r.kind,
    r.verdict ?? '-',
    String(r.blocking),
    r.contract.length === 0 ? 'ok' : r.contract.join('; '),
    Object.entries(r.keywords)
      .map(([id, found]) => `${id}:${found ? 'y' : 'n'}`)
      .join(' ') || '-',
    String(r.toolCalls),
    String(r.denied.length),
  ]);
  const widths = head.map((h, i) => Math.max(h.length, ...lines.map((l) => (l[i] ?? '').length)));
  const format = (cells: readonly string[]) =>
    cells.map((cell, i) => cell.padEnd(widths[i] ?? 0)).join('  ');
  return [format(head), ...lines.map(format)].join('\n');
}

async function main(): Promise<void> {
  const runs = Number(arguments_('runs')[0] ?? '3');
  const specs = arguments_('reviewer');
  const reviewers = specs.length > 0 ? specs : ['claude:claude-haiku-5-5:medium'];
  const fake = process.argv.includes('--fake');
  const cases = loadCases(arguments_('case'));
  if (!Number.isInteger(runs) || runs < 1) throw new Error('--runs takes a positive number');

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const root = join(
    env['LOCALAPPDATA'] ?? join(homedir(), 'AppData', 'Local'),
    'only-one-chat',
    'sandbox',
    `review-check-${stamp}`,
  );
  mkdirSync(root, { recursive: true });
  // A long path: Claude Code does not recognize files under a short (8.3) name as in the folder.
  const base = longPath(root);
  process.stdout.write(`Folder: ${base}\n`);
  const rows: Row[] = [];

  for (const [reviewerAt, spec] of reviewers.entries()) {
    for (const c of cases) {
      const caseRows: Row[] = [];
      for (let run = 1; run <= runs; run++) {
        const name = reviewers.length > 1 ? `${c.name}-${String(reviewerAt + 1)}` : c.name;
        const dir = join(base, `${name}-${String(run)}`);
        // The facts and the guard keep their records outside the folder the reviewer works in.
        const store = new CheckpointStore(join(base, 'state', `${name}-${String(run)}`), dir);
        cpSync(join(CASES, 'base'), dir, { recursive: true, filter: skipCache });
        const baseline = snapshot(dir);
        const request = store.take('request');
        cpSync(c.dir, dir, {
          recursive: true,
          filter: (source) =>
            skipCache(source) &&
            !['brief.md', 'report.md', 'case.json'].includes(relative(c.dir, source)),
        });
        const diffChecks =
          (request && store.diffChecks(request)) ?? 'The runtime skipped diff checks.';
        const facts = `${await verifiedFacts(dir, baseline, VERIFY)}\n\n${diffChecks}`;

        const session = await (
          await reviewerFactory(spec, dir, fake)
        )(
          agentSessionOptions(
            reviewerInstructions(),
            undefined,
            handoffTools('reviewer', HANDOFF_SERVER),
          ),
        );
        const restore = guardReviewerTurn(store, 'review-1');
        if (!restore) throw new Error('the folder cannot be recorded for the reviewer-turn guard');
        let toolCalls = 0;
        const denied: string[] = [];
        try {
          const turn = await session.runTurn(
            reviewRequestPrompt('Claude (sonnet)', c.brief, c.report, facts, 2),
            {
              onText: () => undefined,
              onApprovalRequest: (approval) => {
                denied.push(`approval: ${approval.summary.slice(0, 200)}`);
                return Promise.resolve('decline');
              },
              onActivity: (activity) => {
                if (activity.kind === 'tool') toolCalls++;
                if (activity.kind === 'permission_denied')
                  denied.push(activity.detail.slice(0, 200));
              },
            },
          ).done;
          const review = readHandoff(turn.handoffs, 'review');
          const findings = readHandoff(turn.handoffs, 'findings');
          const result = evaluate(c, review.value, findings.value, turn.text);
          const usage = Object.values(turn.usage?.byModel ?? {})[0];
          const row: Row = {
            reviewer: spec,
            case: c.name,
            run,
            kind: result.kind,
            verdict: result.verdict,
            blocking: result.blocking,
            contract: result.contract,
            keywords: result.keywords,
            handoffCalls: (turn.handoffs ?? []).filter(
              (call) => call.tool === 'review' || call.tool === 'findings',
            ).length,
            handoffErrors: [...review.errors, ...findings.errors],
            toolCalls,
            denied,
            cacheRead: usage?.cachedInput ?? 0,
            cacheWrite: usage?.cacheWrite ?? 0,
            durationMs: turn.usage?.durationMs ?? null,
            guard: restore(),
            facts,
            text: result.text,
          };
          caseRows.push(row);
          process.stdout.write(
            `${spec} ${c.name} #${String(run)}: ${row.kind}, verdict ${String(row.verdict)}, blocking ${String(row.blocking)}, contract ${row.contract.length === 0 ? 'ok' : row.contract.join('; ')}, keywords ${JSON.stringify(row.keywords)}, tools ${String(toolCalls)}, denied ${String(denied.length)}, repairs ${String(row.handoffErrors.length)}\n`,
          );
        } finally {
          await session.close();
        }
      }
      rows.push(...caseRows);
      process.stdout.write(`\n${spec} / ${c.name} (${c.expectation})\n${table(caseRows)}\n\n`);
    }
  }

  const passed = rows.filter(ok).length;
  process.stdout.write(`${String(passed)} of ${String(rows.length)} runs pass both checks\n`);
  const out = join(REPO, 'sandbox', 'results', `review-check-${stamp}.json`);
  mkdirSync(join(REPO, 'sandbox', 'results'), { recursive: true });
  // The results go into the repository: the user's home, in any escaped form, is not kept.
  const json = JSON.stringify({ folder: base, runs, passed, rows }, null, 2).replace(
    /[A-Za-z]:(?:\\+|\/)Users(?:\\+|\/)[^\\/"\s]+/g,
    '<HOME>',
  );
  writeFileSync(out, `${json}\n`);
  process.stdout.write(`Results: ${out}\n`);
  process.exit(passed === rows.length ? 0 : 1);
}

const skipCache = (source: string) => !source.split(/[\\/]/).includes('__pycache__');

await main();
