// Does a reviewer find a flaw that is really there? Dev tooling only.
//
//   node --import ./dev/ts-resolve.mjs dev/review-check.ts --from <bench log.jsonl> \
//     --reviewer claude:haiku --reviewer codex:gpt-6-luna [--runs 2]
//
// Takes the brief and the implementer's report of a bench run (its event log)
// and the folder it worked in is not used: a copy of the reference calculator
// gets that run's `round`, with two flaws put in, as a careless implementer
// leaves them: the check `digits < 0` is gone from the code, and the test's
// cases for an invalid `n` are gone, so `python -m unittest` still passes. The
// report is the original one, so it claims those cases verified. The reviewer
// gets what the runtime gives it (brief, report, facts) and reads and runs
// what its read-only session allows. Result: sandbox/results/review-check-*.json.

import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  antigravityModelId,
  createAcpAgentFactory,
  createClaudeAgentFactory,
  createCodexAgentFactory,
  resolveClaudeExecutable,
  resolveCodexExecutable,
} from '../packages/adapters/src/index.js';
import {
  REVIEWER_ROLE_INSTRUCTIONS,
  agentSessionOptions,
  handoffTools,
  readHandoff,
  renderFindings,
  renderReview,
  reviewRequestPrompt,
  type HandoffServer,
} from '../packages/runtime/src/index.js';
import { snapshot, verifiedFacts } from '../apps/vscode/src/session/facts.js';

const REPO = join(import.meta.dirname, '..');
const env = process.env;

/** The handoff server (ADR 0035), run from its source with the dev loader. */
const HANDOFF_SERVER: HandoffServer = {
  command: process.execPath,
  args: [
    '--import',
    pathToFileURL(join(REPO, 'dev', 'ts-resolve.mjs')).href,
    join(REPO, 'packages', 'runtime', 'src', 'handoff-main.ts'),
  ],
};

function arguments_(name: string): string[] {
  return process.argv.flatMap((arg, at) =>
    arg === `--${name}` ? [process.argv[at + 1] ?? ''] : [],
  );
}

/** The brief and the report of a bench run, from its event log: the rendered handoffs. */
function fromLog(path: string): { brief: string; report: string } {
  let brief = '';
  let report = '';
  for (const line of readFileSync(path, 'utf8').split('\n').filter(Boolean)) {
    const event = JSON.parse(line) as {
      type: string;
      role?: string;
      handoff?: { tool: string; text: string };
    };
    if (event.type !== 'message' || !event.handoff) continue;
    if (event.role === 'orchestrator' && event.handoff.tool === 'delegate') {
      brief = event.handoff.text;
    }
    if (event.role === 'worker' && event.handoff.tool === 'report') report = event.handoff.text;
  }
  if (!brief || !report) throw new Error(`no brief and report handoffs in ${path}`);
  return { brief, report };
}

const CODE_CHECK = 'digits != int(digits) or digits < 0';
const TEST_INVALID = / {8}for line in \["round\(1, 1\.5\)"[^\n]*\n[^\n]*\n[^\n]*\n[^\n]*\n/;

async function main(): Promise<void> {
  const log = arguments_('from')[0];
  const reviewers = arguments_('reviewer');
  const runs = Number(arguments_('runs')[0] ?? '1');
  if (!log || reviewers.length === 0) throw new Error('usage: --from <log> --reviewer cli:model');
  const reference = join(REPO, 'sandbox', 'scenarios', 'calc', 'reference');
  if (!existsSync(reference)) throw new Error(`provide a local reference project at ${reference}`);
  const { brief, report } = fromLog(log);

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = join(
    env['LOCALAPPDATA'] ?? join(homedir(), 'AppData', 'Local'),
    'only-one-chat',
    'sandbox',
    `review-check-${stamp}`,
  );
  mkdirSync(dir, { recursive: true });
  const skip = (source: string) => !source.split(/[\\/]/).includes('__pycache__');
  cpSync(reference, dir, { recursive: true, filter: skip });
  const baseline = snapshot(dir);

  // The implementer's `round` and test, from the run the brief and report come from.
  const sandboxOf = log.replace(/^.*bench-/, '').replace(/\.jsonl$/, '');
  const worked = join(
    env['LOCALAPPDATA'] ?? join(homedir(), 'AppData', 'Local'),
    'only-one-chat',
    'sandbox',
    sandboxOf,
  );
  if (!existsSync(worked)) throw new Error(`run folder not found: ${worked}`);
  const evaluator = readFileSync(join(worked, 'evaluator.py'), 'utf8');
  const tests = readFileSync(join(worked, 'test_calc.py'), 'utf8');
  if (!evaluator.includes(CODE_CHECK) || !TEST_INVALID.test(tests)) {
    throw new Error('the run does not have the code and the test the flaws are put into');
  }
  writeFileSync(join(dir, 'evaluator.py'), evaluator.replace(CODE_CHECK, 'digits != int(digits)'));
  writeFileSync(join(dir, 'test_calc.py'), tests.replace(TEST_INVALID, ''));

  const facts = await verifiedFacts(dir, baseline, ['python', '-m', 'unittest']);
  process.stdout.write(`Cartella: ${dir}\n${facts}\n\n`);

  const claudeExecutable = await resolveClaudeExecutable({
    configuredPath: env['CLAUDE_EXECUTABLE'] ?? '',
  });
  const codexExecutable = await resolveCodexExecutable({
    configuredPath: env['CODEX_EXECUTABLE'] ?? '',
  });
  const results: unknown[] = [];
  for (const spec of reviewers) {
    // cli:model[:effort], e.g. antigravity:gemini-4-hydrogen:medium
    const [cli, model, effort = 'low'] = spec.split(':');
    if ((cli !== 'claude' && cli !== 'codex' && cli !== 'antigravity') || !model) {
      throw new Error(`reviewer ${spec}`);
    }
    for (let run = 1; run <= runs; run++) {
      const factory =
        cli === 'claude'
          ? createClaudeAgentFactory({
              executable: claudeExecutable,
              cwd: dir,
              model,
              effort,
              readOnlyShell: true,
            })
          : cli === 'antigravity'
            ? createAcpAgentFactory({
                executable: env['AGY_EXECUTABLE'] ?? 'agy',
                args: ['acp'],
                provider: 'Antigravity',
                cwd: dir,
                model: antigravityModelId(model, effort),
                readOnly: true,
                ...(env['OOC_ACP_MODE'] ? { mode: env['OOC_ACP_MODE'] } : {}),
              })
            : createCodexAgentFactory({
                executable: codexExecutable,
                cwd: dir,
                model,
                effort,
                requestTimeoutMs: 120_000,
                writable: false,
                withoutUserHooks: true,
              });
      const session = await factory(
        agentSessionOptions(
          REVIEWER_ROLE_INSTRUCTIONS,
          undefined,
          handoffTools('reviewer', HANDOFF_SERVER),
        ),
      );
      const activity: string[] = [];
      const denied: string[] = [];
      try {
        const turn = await session.runTurn(
          (env['OOC_NOEXEC']
            ? [
                'Nota del runtime: in questa sessione non si possono eseguire comandi, nemmeno git:',
                'leggi i file con lo strumento di lettura e basta.',
                '',
                '',
              ].join('\n')
            : '') + reviewRequestPrompt('Claude (sonnet)', brief, report, facts, 2),
          {
            onText: () => undefined,
            onApprovalRequest: (request) => {
              denied.push(request.summary.slice(0, 120));
              return Promise.resolve('decline');
            },
            onActivity: (a) => activity.push(`${a.kind}: ${a.detail.slice(0, 120)}`),
          },
        ).done;
        // The review wins over findings in a turn; neither: the handoff was missed (ADR 0035).
        const review = readHandoff(turn.handoffs, 'review').value;
        const findings = readHandoff(turn.handoffs, 'findings').value;
        const answer = review
          ? { kind: 'review', verdict: review.verdict, text: renderReview(review) }
          : findings
            ? { kind: 'findings', verdict: null, text: renderFindings(findings) }
            : { kind: 'none', verdict: null, text: turn.text };
        const found = review
          ? (review.open_findings ?? []).some((f) => f.severity === 'blocking')
          : (findings?.items ?? []).some((f) => f.severity === 'blocking');
        const row = {
          reviewer: spec,
          run,
          kind: answer.kind,
          verdict: answer.verdict,
          foundBlocking: found,
          mentionsNegative: /-\s*1|negativ|< ?0/.test(answer.text),
          activity,
          denied,
          durationMs: turn.usage?.durationMs ?? null,
          text: answer.text,
        };
        results.push(row);
        process.stdout.write(
          `${spec} #${String(run)}: ${row.kind}, verdetto ${String(row.verdict)}, bloccante ${String(found)}, comandi ${String(activity.length)}, negati ${String(denied.length)}\n`,
        );
      } finally {
        await session.close();
      }
    }
  }
  const out = join(REPO, 'sandbox', 'results', `review-check-${stamp}.json`);
  // The results go into the repository: the user's home, in any escaped form, is not kept.
  const json = JSON.stringify(
    { log, flaws: 'digits<0 check removed; invalid-n test cases removed', facts, results },
    null,
    2,
  ).replace(/[A-Za-z]:(?:\\+|\/)Users(?:\\+|\/)[^\\/"\s]+/g, '<HOME>');
  writeFileSync(out, `${json}\n`);
  process.stdout.write(`\nRisultati: ${out}\n`);
}

await main();
