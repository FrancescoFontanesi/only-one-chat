// Benchmark of a local sandbox scenario: one measured run of one system.
// Dev tooling only. See docs/development.md for the local inputs.
//
//   pnpm bench --system <name> [--scenario calc] [--fake]
//
// Each run gets a fresh working directory outside the repository
// (%LOCALAPPDATA%\only-one-chat\sandbox\<run>), empty or holding a copy of the
// scenario's seed project; the agents work there in sandbox mode (ADR 0008),
// messages between agents approved automatically and logged. A scenario with a
// brief.txt runs it as a brief from the reasoning chat (ADR 0009): given to a
// single agent. Afterwards the scenario's hidden tests run on what they wrote.
// Results: sandbox/results/<run>.json and .md (with --fake, in the run
// directory instead). --fake drives the fake CLIs: no model turns, no quota.
//
// Claude reports its quota only when a turn starts, so a run brackets the
// system with two probes: a minimal Haiku turn (no tools, "Reply only with OK")
// before and after, whose rate_limit_event arrives before its own inference.
// Their tokens and cost are recorded apart, never in the system's totals; the
// difference includes the first probe's own small consumption.
// --no-claude-quota skips them.
// Executables: CODEX_EXECUTABLE, CLAUDE_EXECUTABLE (else searched on PATH).

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  startClaudeTurn,
  CLAUDE_SUBAGENT_FORBIDDEN_NAMES,
  CODEX_SUBAGENT_FORBIDDEN_NAMES,
  antigravityModelId,
  codexQuota,
  createAcpAgentFactory,
  connectCodex,
  createClaudeAgentFactory,
  createCodexAgentFactory,
  resolveClaudeExecutable,
  resolveCodexExecutable,
  type QuotaSnapshot,
} from '../packages/adapters/src/index.js';
import {
  BRIEF_AGENT_INSTRUCTIONS,
  agentLabel,
  agentSessionOptions,
  briefAgentPrompt,
  extractResult,
  leaderInstructions,
  IMPLEMENTER_ROLE_INSTRUCTIONS,
  LIGHT_IMPLEMENTER_INSTRUCTIONS,
  REVIEWER_ROLE_INSTRUCTIONS,
  handoffTools,
  readHandoff,
  renderFindings,
  renderReport,
  renderReview,
  type AgentSession,
  type HandoffServer,
  openEventLog,
  parseBrief,
  requestPrompt,
  runLoop,
  type Brief,
  type SubagentPolicy,
  type AgentFactory,
  type ThreadEvent,
  type TokenUsage,
  type TurnUsage,
} from '../packages/runtime/src/index.js';
import { loadSuite, runHiddenTests, type HiddenResults } from './bench/hidden.js';
import { CheckpointStore } from '../apps/vscode/src/session/checkpoints.js';
import { guardReviewerTurn } from '../apps/vscode/src/session/guard.js';
import { isTestFile } from '../apps/vscode/src/session/shortcuts.js';
import {
  findLeaks,
  homeLiteral,
  localNameLiterals,
  localNames,
  redactTranscript,
} from '../packages/adapters/dev/redact.js';

interface AgentConfig {
  readonly cli: 'codex' | 'claude' | 'antigravity';
  readonly model: string;
  readonly effort: string;
}

interface SystemConfig {
  /** `leader` and `session` run a scenario's script.json, one message after another. */
  readonly kind: 'single' | 'leader' | 'session';
  readonly title: string;
  /** `leader`: the leader, read-only, kept for the whole session; `implementer` writes. */
  readonly leader?: AgentConfig;
  readonly implementer?: AgentConfig;
  /**
   * `leader` systems: the product's own roles (ADR 0020, 0029): the leader
   * read-only, the implementer with its report prompt, and a reviewer if given.
   */
  readonly product?: boolean;
  readonly reviewer?: AgentConfig;
  /**
   * Other reviewers given the same first review request as `reviewer`, each in
   * its own copy of the folder taken at that moment: one turn, not passed on to
   * anyone, its usage kept apart from the run's. Compares reviewers on one input.
   */
  readonly shadowReviewers?: readonly AgentConfig[];
  /** Session systems: the script, relative to the scenario; default script.json. */
  readonly script?: string;
  readonly agent?: AgentConfig;
  readonly subagents?: {
    readonly codex: { readonly model: string; readonly effort: string };
    readonly claude: { readonly model: string; readonly effort: string };
    readonly maxConcurrent: number;
  };
}

interface TurnRecord {
  /** The script message the turn belongs to, in a session. */
  readonly message?: string;
  readonly role: string;
  readonly agent: string;
  readonly label: string;
  /** The handoff tool the turn called validly (ADR 0035); null: none. */
  readonly handoff: string | null;
  readonly usage: TurnUsage | null;
  readonly quota: QuotaSnapshot | null;
}

/**
 * Handoffs per role and agent (ADR 0035): the turns, the valid handoffs by tool, and the turns of
 * an implementer or a reviewer that made none, which the runtime had to ask for or left
 * missing; `invalid` counts the leader's `delegate` calls that never validated.
 */
function handoffMetrics(turns: readonly TurnRecord[], invalid: number) {
  const byAgent: Record<string, { turns: number; made: Record<string, number>; missing: number }> =
    {};
  for (const turn of turns) {
    const row = (byAgent[`${turn.role} · ${turn.agent}`] ??= { turns: 0, made: {}, missing: 0 });
    row.turns += 1;
    if (turn.handoff) row.made[turn.handoff] = (row.made[turn.handoff] ?? 0) + 1;
    else if (turn.role !== 'orchestrator') row.missing += 1;
  }
  return { invalidDelegations: invalid, byAgent };
}

/** A session system: one model, one long chat, every message of the script in it. */
const SESSION_AGENT_INSTRUCTIONS = [
  'You are an Only One Chat agent. Talk with the user in this chat and work on the project in',
  'the current folder. Create and edit files only there. For a change request, implement it,',
  'write automated tests, and run them with the existing tests. Fix failures until they pass.',
  'Briefly describe your work, decisions, and issues. Answer questions without editing files.',
  'Ask the user for any missing decision that would change the result.',
].join('\n');

/** A single system's only turn: implement, test and report. */
const SINGLE_AGENT_INSTRUCTIONS = [
  'You are an Only One Chat agent. Implement the user’s request in the current folder.',
  'Create and edit files only there, write tests, and fix failures until the tests pass.',
  'Respond only with the following report:',
  '## File',
  '<files created or changed>',
  '## Test',
  '<command run and tests passed or failed>',
  '## Issues',
  '<remaining issues, or "None">',
].join('\n');

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

function argument(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? process.argv[at + 1] : undefined;
}

function stateDir(): string {
  return process.platform === 'win32'
    ? join(env['LOCALAPPDATA'] ?? join(homedir(), 'AppData', 'Local'), 'only-one-chat')
    : join(homedir(), '.local', 'state', 'only-one-chat');
}

/** Files the agents left in the run directory, with their line counts. */
function listFiles(dir: string): { path: string; lines: number }[] {
  const out: { path: string; lines: number }[] = [];
  for (const entry of readdirSync(dir, { recursive: true, encoding: 'utf8' })) {
    if (entry.split(/[\\/]/).includes('__pycache__')) continue;
    const path = join(dir, entry);
    if (!statSync(path).isFile()) continue;
    out.push({ path: relative(dir, path), lines: readFileSync(path, 'utf8').split('\n').length });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/** Content hash of every file in the run directory, by relative path. */
function snapshot(dir: string): Map<string, string> {
  return new Map(
    listFiles(dir).map((file) => [
      file.path,
      createHash('sha256')
        .update(readFileSync(join(dir, file.path)))
        .digest('hex'),
    ]),
  );
}

function changes(before: Map<string, string>, after: Map<string, string>): string[] {
  const out: string[] = [];
  for (const [path, hash] of after) {
    if (!before.has(path)) out.push(`added ${path}`);
    else if (before.get(path) !== hash) out.push(`modified ${path}`);
  }
  for (const path of before.keys()) if (!after.has(path)) out.push(`deleted ${path}`);
  return out.sort((a, b) => a.slice(a.indexOf(' ')).localeCompare(b.slice(b.indexOf(' '))));
}

/** Runs a verification command; its output (stdout and stderr) is kept whole. */
function runCommand(
  command: readonly string[],
  cwd: string,
  timeoutMs = 120_000,
): Promise<{ code: number | null; output: string; timedOut: boolean }> {
  const [program = 'python', ...args] = command;
  return new Promise((resolve) => {
    const child = spawn(program, args, {
      cwd,
      env: { ...env, PYTHONDONTWRITEBYTECODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let output = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (output += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (output += chunk));
    child.on('error', (error) => (output += String(error)));
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, output, timedOut });
    });
  });
}

/**
 * What the runtime verified, as text for the leader: the files changed since
 * the seed and the scenario's verification command, run again here.
 */
async function verifiedFacts(
  runDir: string,
  baseline: Map<string, string>,
  verify: readonly string[] | undefined,
): Promise<string> {
  const changed = changes(baseline, snapshot(runDir));
  const lines = [
    'Files changed from the starting project:',
    ...(changed.length > 0 ? changed.map((change) => `- ${change}`) : ['- none']),
  ];
  if (verify) {
    const run = await runCommand(verify, runDir);
    const output = run.output.replace(/\r\n/g, '\n').trim();
    const tail = output.split('\n').slice(-15).join('\n');
    // unittest names each failure on a "FAIL: test (module.Class.test)" line.
    const failed = output.split('\n').filter((line) => /^(FAIL|ERROR): /.test(line));
    lines.push(
      '',
      `Verification run by the runtime: ${verify.join(' ')} → exit ${String(run.code)}${run.timedOut ? ' (timeout)' : ''}`,
      ...(failed.length > 0 ? ['Failed tests:', ...failed.map((line) => `- ${line}`)] : []),
      'Last lines of output:',
      tail || '(no output)',
    );
  }
  return lines.join('\n');
}

function sumTokens(turns: readonly TurnRecord[]): Record<string, TokenUsage> {
  const totals: Record<string, TokenUsage> = {};
  for (const turn of turns) {
    for (const [model, t] of Object.entries(turn.usage?.byModel ?? {})) {
      const prev = totals[model] ?? {
        input: 0,
        cachedInput: 0,
        cacheWrite: 0,
        output: 0,
        reasoning: 0,
      };
      totals[model] = {
        input: prev.input + t.input,
        cachedInput: prev.cachedInput + t.cachedInput,
        cacheWrite: prev.cacheWrite + t.cacheWrite,
        output: prev.output + t.output,
        reasoning: prev.reasoning + t.reasoning,
      };
    }
  }
  return totals;
}

function quotaText(quota: QuotaSnapshot | null | undefined): string {
  if (!quota) return 'not reported';
  return quota.windows.map((w) => `${w.name} ${String(w.usedPercent)}%`).join(', ');
}

async function main(): Promise<void> {
  const systemName = argument('system');
  const scenario = argument('scenario') ?? 'calc';
  const fake = process.argv.includes('--fake');
  const scenarioDir = join(REPO, 'sandbox', 'scenarios', scenario);
  const systemsPath = join(scenarioDir, 'systems.json');
  if (!existsSync(systemsPath)) {
    throw new Error(`local scenario "${scenario}" is missing: provide ${systemsPath}`);
  }
  const systems = JSON.parse(readFileSync(systemsPath, 'utf8')) as {
    systems: Record<string, SystemConfig>;
    sandboxCommands: string[];
    /** Project copied into the run directory first, relative to the scenario. */
    seed?: string;
    /** Verification command the runtime runs again after the implementer. */
    verify?: string[];
  };
  const system = systemName ? systems.systems[systemName] : undefined;
  if (!systemName || !system) {
    const names = Object.keys(systems.systems).join('|');
    throw new Error(`usage: bench --system ${names} [--scenario ${scenario}] [--fake]`);
  }
  const scriptPath = join(scenarioDir, system.script ?? 'script.json');
  /**
   * A session scenario: the user's messages, in order (a file is read as it
   * is: a brief). `to`: the leader (default) or the implementer directly;
   * `implementer`: its session continues (`same`) or starts over (`new`,
   * the default when the field is absent).
   */
  const script = existsSync(scriptPath)
    ? (
        JSON.parse(readFileSync(scriptPath, 'utf8')) as {
          messages: {
            name: string;
            text?: string;
            file?: string;
            to?: 'leader' | 'implementer';
            implementer?: 'new' | 'same';
          }[];
        }
      ).messages.map((message) => ({
        name: message.name,
        text: message.file
          ? readFileSync(join(scenarioDir, message.file), 'utf8')
          : (message.text ?? ''),
        to: message.to ?? 'leader',
        implementer: message.implementer ?? 'new',
      }))
    : undefined;
  const briefPath = join(scenarioDir, 'brief.txt');
  const prompt = script
    ? script.map((message) => message.text).join('\n\n---\n\n')
    : existsSync(briefPath)
      ? readFileSync(briefPath, 'utf8')
      : readFileSync(join(scenarioDir, 'prompt.md'), 'utf8').trim();
  let brief: Brief | undefined;
  if (!script && existsSync(briefPath)) {
    const parsed = parseBrief(prompt);
    if (parsed.status === 'invalid') throw new Error(`brief.txt: ${parsed.error}`);
    brief = parsed.brief;
  }
  const suite = loadSuite(join(scenarioDir, 'hidden-tests.json'));

  const runId = `${scenario}-${systemName}-${new Date().toISOString().replace(/[:.]/g, '-')}${fake ? '-fake' : ''}`;
  const runDir = join(stateDir(), 'sandbox', runId);
  mkdirSync(runDir, { recursive: true });
  if (systems.seed) {
    cpSync(join(scenarioDir, systems.seed), runDir, {
      recursive: true,
      filter: (source) => !source.split(/[\\/]/).includes('__pycache__'),
    });
  }
  const baseline = snapshot(runDir);
  const log = await openEventLog(join(stateDir(), 'logs', `bench-${runId}.jsonl`), runDir);

  const fakes = join(REPO, 'packages', 'adapters', 'test', 'fixtures');
  const codexExecutable = fake
    ? process.execPath
    : await resolveCodexExecutable({ configuredPath: env['CODEX_EXECUTABLE'] ?? '' });
  const claudeExecutable = fake
    ? process.execPath
    : await resolveClaudeExecutable({ configuredPath: env['CLAUDE_EXECUTABLE'] ?? '' });
  const codexLauncher = fake ? [join(fakes, 'fake-app-server.mjs'), '--account=chatgpt'] : [];
  const claudeLauncher = fake ? [join(fakes, 'fake-claude.mjs'), '--echo'] : [];

  // Who writes depends on the role: a read-only leader or reviewer does not (ADR 0008).
  const codex = (config: AgentConfig, writable: boolean, cwd: string): AgentFactory =>
    createCodexAgentFactory({
      executable: codexExecutable,
      launcherArgs: codexLauncher,
      cwd,
      model: config.model,
      effort: config.effort,
      requestTimeoutMs: 120_000,
      writable,
      // Experiments run isolated from the user's hooks (graft writes into the run directory).
      withoutUserHooks: true,
    });
  const claude = (
    config: AgentConfig,
    writable: boolean,
    readOnlyShell: boolean,
    cwd: string,
  ): AgentFactory =>
    createClaudeAgentFactory({
      executable: claudeExecutable,
      launcherArgs: claudeLauncher,
      cwd,
      model: config.model,
      effort: config.effort,
      // As the product's default permission: Claude Code's auto mode, not a list that denies the rest.
      ...(writable ? { sandbox: { commands: systems.sandboxCommands, auto: true } } : {}),
      // The product's leader and reviewer run what Claude Code counts as read-only.
      ...(readOnlyShell ? { readOnlyShell: true } : {}),
    });
  /** Antigravity over ACP (ADR 0023); read-only declines every permission request. */
  const antigravity = (config: AgentConfig, writable: boolean, cwd: string): AgentFactory =>
    createAcpAgentFactory({
      // --fake must never reach the real Antigravity.
      executable: fake ? process.execPath : (env['AGY_EXECUTABLE'] ?? 'agy'),
      args: fake ? [join(fakes, 'fake-agy.mjs'), 'acp'] : ['acp'],
      provider: 'Antigravity',
      cwd,
      model: antigravityModelId(config.model, config.effort),
      readOnly: !writable,
    });
  const factory = (config: AgentConfig, writable: boolean, readOnlyShell = false, cwd = runDir) =>
    config.cli === 'codex'
      ? codex(config, writable, cwd)
      : config.cli === 'antigravity'
        ? antigravity(config, writable, cwd)
        : claude(config, writable, readOnlyShell, cwd);
  /** The first review request and a copy of the folder as it was then, for `shadowReviewers`. */
  let shadowInput: { prompt: string; dirs: string[] } | undefined;
  const copyFolder = (to: string) => {
    cpSync(runDir, to, {
      recursive: true,
      filter: (source) => !source.split(/[\\/]/).includes('__pycache__'),
    });
  };
  /** The sub-agent policy of an agent, from its CLI. */
  const policy = (config: AgentConfig): SubagentPolicy | undefined => {
    const sub = system.subagents;
    // Antigravity has no sub-agents to rule (ADR 0023).
    if (!sub || config.cli === 'antigravity') return undefined;
    return config.cli === 'codex'
      ? {
          ...sub.codex,
          maxConcurrent: sub.maxConcurrent,
          forbiddenNames: CODEX_SUBAGENT_FORBIDDEN_NAMES,
        }
      : {
          ...sub.claude,
          maxConcurrent: sub.maxConcurrent,
          forbiddenNames: CLAUDE_SUBAGENT_FORBIDDEN_NAMES,
        };
  };

  /** Claude quota now: a minimal Haiku turn; see the module comment. */
  async function claudeProbe(): Promise<{
    quota: QuotaSnapshot | null;
    costUsd: number | null;
  } | null> {
    if (fake || process.argv.includes('--no-claude-quota')) return null;
    try {
      const result = await startClaudeTurn({
        executable: claudeExecutable,
        cwd: runDir,
        prompt: 'Reply only with OK',
        model: 'haiku',
        effort: 'low',
      }).done;
      return { quota: result.quota, costUsd: result.costUsd };
    } catch (error) {
      process.stderr.write(`bench: Claude quota probe failed: ${String(error)}\n`);
      return null;
    }
  }

  /** Codex quota before and after: account/rateLimits/read uses no model quota. */
  async function codexQuotaNow(): Promise<QuotaSnapshot | null> {
    if (fake) return null;
    const session = await connectCodex({
      executable: codexExecutable,
      clientInfo: { name: 'only-one-chat-bench', version: '0.0.0' },
    });
    try {
      const result = (await session.request('account/rateLimits/read', {})) as {
        rateLimits?: unknown;
      };
      return codexQuota(result.rateLimits);
    } catch {
      return null;
    } finally {
      await session.close();
    }
  }

  process.stdout.write(`Run ${runId}\n${system.title}\nCartella: ${runDir}\n\n`);
  const turns: TurnRecord[] = [];
  const events: string[] = [];
  /** The script message being handled, for the turn records. */
  let currentMessage: string | undefined;
  /** The single system bypasses the runtime: its events are logged here, as the loop does. */
  const record = (event: ThreadEvent): void => {
    onEvent(event);
    if (event.type === 'text' || event.type === 'subagent_text') return;
    const { type, ...fields } = event;
    void log.append(type, fields);
  };
  const onEvent = (event: ThreadEvent): void => {
    if (event.type === 'text' || event.type === 'subagent_text') return;
    if (event.type === 'message') {
      turns.push({
        ...(currentMessage === undefined ? {} : { message: currentMessage }),
        role: event.role,
        agent: event.agent,
        label: event.label,
        handoff: event.handoff?.tool ?? null,
        usage: event.usage ?? null,
        quota: event.quota ?? null,
      });
      process.stdout.write(
        `✔ ${event.role}: ${event.label} (${String(event.usage?.durationMs ?? '?')} ms)\n`,
      );
    } else if (event.type === 'turn_started') {
      process.stdout.write(`▶ ${event.role}: ${event.agent}\n`);
    } else if (event.type !== 'intercepted') {
      events.push(event.type);
      if (event.type === 'subagent') process.stdout.write(`  ↳ ${event.label}\n`);
      if (event.type === 'activity' || event.type === 'subagent_activity') {
        process.stdout.write(`  · ${event.kind}: ${event.detail.slice(0, 120)}\n`);
      }
      if (event.type === 'error' || event.type === 'subagent_violation') {
        process.stdout.write(`✖ ${event.message}\n`);
      }
    }
  };

  const codexBefore = await codexQuotaNow();
  const claudeBefore = await claudeProbe();
  const startedAt = Date.now();
  /** A session's answers, one per script message. */
  type Answer = { readonly name: string; readonly status: string; readonly text: string };
  let outcome:
    | { status: 'single'; report: string }
    | { status: 'session'; answers: Answer[] }
    | { status: 'failed'; error: string };
  if (script && system.kind === 'leader' && system.leader && system.implementer) {
    // One leader session for the whole script; a new implementer for each delegation.
    const leaderConfig = system.leader;
    const leaderPolicy = policy(leaderConfig);
    const proactive = leaderPolicy ? { ...leaderPolicy, proactive: true } : undefined;
    const implementerPolicy = policy(system.implementer);
    // The leader writes too: it makes the small, focused changes itself.
    const product = system.product === true;
    const leaderSession = await factory(
      leaderConfig,
      !product,
      product,
    )(
      agentSessionOptions(
        // No questions tool in the bench: the leader asks in words.
        leaderInstructions(system.implementer.cli, product ? { questions: false } : {}),
        proactive,
        handoffTools('leader', HANDOFF_SERVER),
      ),
    );
    const reviewerConfig = product ? system.reviewer : undefined;
    /** The folder before each reviewer turn, outside the run directory. */
    const reviewerStore = new CheckpointStore(
      join(stateDir(), 'sandbox', `${runId}-guard`),
      runDir,
    );
    let reviewerTurns = 0;
    const reviewerPolicy = reviewerConfig ? policy(reviewerConfig) : undefined;
    const answers: Answer[] = [];
    const implementerConfig = system.implementer;
    /** Every implementer session opened, closed at the end; the last one is current. */
    const implementers: AgentSession[] = [];
    const implementerSession = async (which: 'new' | 'same'): Promise<AgentSession> => {
      const current = implementers.at(-1);
      if (which === 'same' && current) return current;
      const session = await factory(
        implementerConfig,
        true,
      )(
        agentSessionOptions(
          product ? IMPLEMENTER_ROLE_INSTRUCTIONS : LIGHT_IMPLEMENTER_INSTRUCTIONS,
          implementerPolicy,
          handoffTools('implementer', HANDOFF_SERVER),
        ),
      );
      implementers.push(session);
      return session;
    };
    try {
      for (const message of script) {
        currentMessage = message.name;
        process.stdout.write(`\n— ${message.name} → ${message.to}\n`);
        if (message.to === 'implementer') {
          // A message straight to the implementer: no leader turn, no facts.
          const session = await implementerSession(message.implementer);
          record({ type: 'turn_started', role: 'worker', agent: session.name });
          try {
            const result = await session.runTurn(message.text, {
              onText: () => undefined,
              onApprovalRequest: () => Promise.resolve('decline'),
              onActivity: (activity) => {
                record({ type: 'activity', role: 'worker', ...activity });
              },
            }).done;
            const report = readHandoff(result.handoffs, 'report').value;
            record({
              type: 'message',
              role: 'worker',
              agent: session.name,
              text: result.text,
              label: agentLabel(result.identity),
              identity: result.identity,
              ...(report
                ? {
                    handoff: {
                      tool: 'report',
                      text: renderReport(report),
                      outcome: report.outcome,
                    },
                  }
                : {}),
              ...(result.usage ? { usage: result.usage } : {}),
              ...(result.quota !== undefined ? { quota: result.quota } : {}),
            });
            answers.push({ name: message.name, status: 'completed', text: result.text });
          } catch (error) {
            const text = error instanceof Error ? error.message : String(error);
            answers.push({ name: message.name, status: 'failed', text });
            break;
          }
          continue;
        }
        // The fake leader makes a `delegate` call on [delegation]: on a brief, and on the last
        // message to the leader, so that --fake runs the whole pipeline of a script.
        const isBrief = parseBrief(message.text).status === 'valid';
        const lastToLeader = script.filter((m) => m.to !== 'implementer').at(-1) === message;
        const text =
          fake && (isBrief || lastToLeader)
            ? `${message.text}
[delegation]`
            : message.text;
        const loop = runLoop({
          request: text,
          handoffServer: HANDOFF_SERVER,
          log,
          onEvent,
          mode: 'leader',
          leaderSession,
          workerSession: await implementerSession(message.implementer),
          autoApprove: true,
          worker: () => Promise.reject(new Error('the implementer session is given')),
          ...(reviewerConfig
            ? {
                // As in the product (ADR 0029): it runs and writes tests, its code changes put back.
                reviewer: async (sessionOptions) => {
                  const session = await factory(reviewerConfig, true)(sessionOptions);
                  const shadows = system.shadowReviewers ?? [];
                  if (shadows.length === 0) return session;
                  // The first request, before the turn: the folder is what the reviewer gets.
                  return {
                    name: session.name,
                    id: session.id,
                    runTurn: (prompt, handlers, turnOptions) => {
                      if (!shadowInput) {
                        const dirs = shadows.map((_, at) => `${runDir}-shadow-${String(at + 1)}`);
                        dirs.forEach(copyFolder);
                        shadowInput = { prompt, dirs };
                      }
                      return session.runTurn(prompt, handlers, turnOptions);
                    },
                    close: () => session.close(),
                  };
                },
                reviewRounds: 2,
                guardReviewer: () =>
                  guardReviewerTurn(reviewerStore, `rev-${String(++reviewerTurns)}`),
              }
            : {}),
          subagents: {
            ...(proactive ? { orchestrator: proactive } : {}),
            ...(implementerPolicy ? { worker: implementerPolicy } : {}),
            ...(reviewerPolicy ? { reviewer: reviewerPolicy } : {}),
          },
          facts: () => verifiedFacts(runDir, baseline, systems.verify),
          intercept: () => Promise.reject(new Error('not used with autoApprove')),
          onMalformedDelegation: () => Promise.reject(new Error('not used with autoApprove')),
        });
        const done = await loop.done;
        answers.push({
          name: message.name,
          status: done.status,
          text:
            done.status === 'completed'
              ? done.conclusion
              : done.status === 'result'
                ? done.result
                : done.status === 'failed'
                  ? done.error
                  : done.status,
        });
        if (done.status === 'failed') break;
      }
    } finally {
      await leaderSession.close();
      await Promise.allSettled(implementers.map((session) => session.close()));
    }
    outcome = { status: 'session', answers };
  } else if (script && system.kind === 'session' && system.agent) {
    await log.append('loop_started', { request: prompt, mode: 'session', autoApprove: true });
    const session = await factory(system.agent, true)({ instructions: SESSION_AGENT_INSTRUCTIONS });
    const answers: Answer[] = [];
    try {
      for (const message of script) {
        currentMessage = message.name;
        process.stdout.write(`\n— ${message.name}\n`);
        const parsed = parseBrief(message.text);
        record({ type: 'turn_started', role: 'worker', agent: session.name });
        try {
          const result = await session.runTurn(
            parsed.status === 'valid' ? briefAgentPrompt(parsed.brief) : message.text,
            {
              onText: () => undefined,
              onApprovalRequest: () => Promise.resolve('decline'),
              onActivity: (activity) => {
                record({ type: 'activity', role: 'worker', ...activity });
              },
            },
          ).done;
          record({
            type: 'message',
            role: 'worker',
            agent: session.name,
            text: result.text,
            label: agentLabel(result.identity),
            identity: result.identity,
            ...(result.usage ? { usage: result.usage } : {}),
            ...(result.quota !== undefined ? { quota: result.quota } : {}),
          });
          answers.push({ name: message.name, status: 'completed', text: result.text });
        } catch (error) {
          const text = error instanceof Error ? error.message : String(error);
          answers.push({ name: message.name, status: 'failed', text });
          break;
        }
      }
    } finally {
      await session.close();
    }
    outcome = { status: 'session', answers };
  } else if (system.kind === 'single' && system.agent) {
    await log.append('loop_started', { request: prompt, mode: 'single', autoApprove: true });
    const session = await factory(
      system.agent,
      true,
    )({ instructions: brief ? BRIEF_AGENT_INSTRUCTIONS : SINGLE_AGENT_INSTRUCTIONS });
    record({ type: 'turn_started', role: 'worker', agent: session.name });
    try {
      const turn = session.runTurn(brief ? briefAgentPrompt(brief) : requestPrompt(prompt), {
        onText: () => undefined,
        onApprovalRequest: () => Promise.resolve('decline'),
        onActivity: (activity) => {
          record({ type: 'activity', role: 'worker', ...activity });
        },
      });
      process.on('SIGINT', () => void turn.stop());
      const result = await turn.done;
      record({
        type: 'message',
        role: 'worker',
        agent: session.name,
        text: result.text,
        label: agentLabel(result.identity),
        identity: result.identity,
        ...(result.usage ? { usage: result.usage } : {}),
        ...(result.quota !== undefined ? { quota: result.quota } : {}),
      });
      outcome = { status: 'single', report: result.text };
    } catch (error) {
      outcome = { status: 'failed', error: error instanceof Error ? error.message : String(error) };
    } finally {
      await session.close();
    }
  } else {
    throw new Error(`system ${systemName} is incomplete in systems.json`);
  }
  const wallMs = Date.now() - startedAt;
  const codexAfter = await codexQuotaNow();
  const claudeAfter = await claudeProbe();

  // After the run's quota is read: the shadow reviewers' usage stays out of the run's.
  const shadows: {
    reviewer: AgentConfig;
    verdict: string | null;
    kind: string;
    durationMs: number | null;
    usage: TurnUsage | null;
    /** What it changed in its copy; files that are not tests the product would put back. */
    changed: string[];
    /** The permission requests it made, all allowed in its copy. */
    approved: string[];
    text: string;
  }[] = [];
  const shadowConfigs = system.shadowReviewers ?? [];
  if (shadowInput) {
    for (const [at, config] of shadowConfigs.entries()) {
      const dir = shadowInput.dirs[at] ?? '';
      process.stdout.write(`\n— revisore ombra ${config.cli}:${config.model}:${config.effort}\n`);
      const before = snapshot(dir);
      const session = await factory(
        config,
        true,
        false,
        dir,
      )(
        agentSessionOptions(
          REVIEWER_ROLE_INSTRUCTIONS,
          policy(config),
          handoffTools('reviewer', HANDOFF_SERVER),
        ),
      );
      const approved: string[] = [];
      try {
        const turn = await session.runTurn(shadowInput.prompt, {
          onText: () => undefined,
          // Its own copy, thrown away: what it asks is allowed and listed. A refused
          // command ends an Antigravity turn with no answer.
          onApprovalRequest: (request) => {
            approved.push(request.summary.slice(0, 160));
            return Promise.resolve('accept');
          },
        }).done;
        // The review wins over findings in a turn; neither: the handoff was missed.
        const review = readHandoff(turn.handoffs, 'review').value;
        const findings = readHandoff(turn.handoffs, 'findings').value;
        shadows.push({
          reviewer: config,
          kind: review ? 'review' : findings ? 'findings' : 'none',
          verdict: review?.verdict ?? null,
          durationMs: turn.usage?.durationMs ?? null,
          usage: turn.usage ?? null,
          changed: changes(before, snapshot(dir)).map((change) =>
            isTestFile(change.slice(change.indexOf(' ') + 1))
              ? change
              : `${change} (non-test file)`,
          ),
          approved,
          text: review ? renderReview(review) : findings ? renderFindings(findings) : turn.text,
        });
      } catch (error) {
        shadows.push({
          reviewer: config,
          kind: 'failed',
          verdict: null,
          durationMs: null,
          usage: null,
          changed: [],
          approved,
          text: error instanceof Error ? error.message : String(error),
        });
      } finally {
        await session.close();
      }
    }
  } else if (shadowConfigs.length > 0) {
    process.stdout.write('\nNo review occurred in this run. Shadow reviewers did not start.\n');
  }

  const hidden: HiddenResults = await runHiddenTests(suite, runDir, {
    ...env,
    PYTHONDONTWRITEBYTECODE: '1',
  });
  const files = listFiles(runDir);
  // The same check for every system, for the evaluation: not shown to any agent.
  const finalFacts = brief || script ? await verifiedFacts(runDir, baseline, systems.verify) : null;
  const resultForChat =
    outcome.status === 'single' && brief ? (extractResult(outcome.report) ?? outcome.report) : null;
  const tokens = sumTokens(turns);
  const costUsd = turns.reduce((sum, t) => sum + (t.usage?.costUsd ?? 0), 0);
  const result = {
    runId,
    scenario,
    system: systemName,
    config: system,
    fake,
    runDir,
    wallMs,
    outcome,
    resultForChat,
    finalFacts,
    hidden,
    files,
    turns,
    tokens,
    claudeNominalCostUsd: costUsd,
    codexQuota: { before: codexBefore, after: codexAfter },
    claudeQuota: {
      before: claudeBefore?.quota ?? null,
      after: claudeAfter?.quota ?? null,
      probeCostUsd: (claudeBefore?.costUsd ?? 0) + (claudeAfter?.costUsd ?? 0),
    },
    shadows,
    handoffs: handoffMetrics(turns, events.filter((type) => type === 'delegation_invalid').length),
    otherEvents: events,
  };

  const md = [
    `# ${runId}`,
    '',
    `${system.title}${fake ? ' (fake CLIs)' : ''}`,
    '',
    `- Outcome: ${JSON.stringify(outcome.status)}`,
    `- Hidden tests: ${String(hidden.passed)}/${String(hidden.total)}`,
    `- Total time: ${(wallMs / 1000).toFixed(1)} s`,
    `- Codex quota: before ${quotaText(codexBefore)}, after ${quotaText(codexAfter)}`,
    `- Claude quota (probes): before ${quotaText(claudeBefore?.quota)}, after ${quotaText(claudeAfter?.quota)}`,
    `- Claude nominal cost: $${costUsd.toFixed(4)}`,
    `- Handoffs (ooc tools): ${
      Object.entries(result.handoffs.byAgent)
        .map(
          ([who, row]) =>
            `${who}: ${String(row.turns)} turns, ${JSON.stringify(row.made)}, missing ${String(row.missing)}`,
        )
        .join('; ') || 'none'
    }; invalid delegation calls ${String(result.handoffs.invalidDelegations)}`,
    `- Files: ${files.map((f) => `${f.path} (${String(f.lines)})`).join(', ') || 'none'}`,
    '',
    '| Message | Turn | Label | Time | Context read | Output | Quota observed |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...turns.map((t) => {
      // Context read in the turn: every model's input, cached or not, cache writes included.
      const models = Object.values(t.usage?.byModel ?? {});
      const read = models.reduce((s, m) => s + m.input + m.cachedInput + m.cacheWrite, 0);
      const out = models.reduce((s, m) => s + m.output, 0);
      return `| ${t.message ?? ''} | ${t.role} | ${t.label} | ${((t.usage?.durationMs ?? 0) / 1000).toFixed(1)} s | ${String(read)} | ${String(out)} | ${quotaText(t.quota)} |`;
    }),
    '',
    '| Model | Input | Cache read | Cache write | Output | Reasoning |',
    '| --- | --- | --- | --- | --- | --- |',
    ...Object.entries(tokens).map(
      ([model, t]) =>
        `| ${model} | ${String(t.input)} | ${String(t.cachedInput)} | ${String(t.cacheWrite)} | ${String(t.output)} | ${String(t.reasoning)} |`,
    ),
    '',
    'Failed hidden tests:',
    ...hidden.cases.filter((c) => !c.passed).map((c) => `- ${c.name}: ${c.reason ?? ''}`),
    '',
    ...(resultForChat === null
      ? []
      : ['## Result for the reasoning chat', '', '```text', resultForChat, '```', '']),
    ...(outcome.status === 'session'
      ? outcome.answers.flatMap((answer) => [
          `## Answer to ${answer.name} (${answer.status})`,
          '',
          '```text',
          answer.text,
          '```',
          '',
        ])
      : []),
    ...(finalFacts === null
      ? []
      : ['## Final runner verification', '', '```text', finalFacts, '```', '']),
    ...shadows.flatMap((shadow) => {
      const models = Object.values(shadow.usage?.byModel ?? {});
      const fresh = models.reduce((s, m) => s + m.input + m.cacheWrite, 0);
      const cached = models.reduce((s, m) => s + m.cachedInput, 0);
      const out = models.reduce((s, m) => s + m.output, 0);
      const { cli, model, effort } = shadow.reviewer;
      return [
        `## Shadow reviewer ${cli}:${model}:${effort} with the first reviewer request`,
        '',
        `- Outcome: ${shadow.kind}, verdict ${String(shadow.verdict)}`,
        `- Time: ${((shadow.durationMs ?? 0) / 1000).toFixed(1)} s, fresh tokens ${String(fresh)}, cached ${String(cached)}, output ${String(out)}, nominal cost $${(shadow.usage?.costUsd ?? 0).toFixed(4)}`,
        `- Files changed in its copy: ${shadow.changed.join(', ') || 'none'}`,
        `- Permission requests approved: ${shadow.approved.join('; ') || 'none'}`,
        '',
        '```text',
        shadow.text,
        '```',
        '',
      ];
    }),
  ].join('\n');
  // The results go into the ignored local sandbox folder, redacted like the fixtures, and kept in
  // the run directory instead if the scanner still finds something personal.
  const literals = new Map<string, string>();
  const addPath = (value: string, placeholder: string) => {
    for (const form of [value, value.replaceAll('\\', '/'), value.replaceAll('\\', '\\\\')]) {
      literals.set(form, placeholder);
    }
  };
  addPath(runDir, '<RUN>');
  const home = homeLiteral();
  if (home) addPath(home, '<HOME>');
  for (const [name, placeholder] of localNameLiterals()) literals.set(name, placeholder);
  const [redacted] = redactTranscript([{ ...result, md }], [...literals]) as [
    typeof result & { md: string },
  ];
  const { md: redactedMd, ...redactedResult } = redacted;
  const json = `${JSON.stringify(redactedResult, null, 2)}\n`;
  const leaks = findLeaks(json + redactedMd, localNames());
  const resultsDir = fake || leaks.length > 0 ? runDir : join(REPO, 'sandbox', 'results');
  if (leaks.length > 0) {
    process.stderr.write(
      `bench: possible leaks (${leaks.map((leak) => leak.kind).join(', ')}): results kept in the run directory\n`,
    );
  }
  mkdirSync(resultsDir, { recursive: true });
  writeFileSync(join(resultsDir, `${runId}.json`), json);
  writeFileSync(join(resultsDir, `${runId}.md`), redactedMd);
  process.stdout.write(`\n${redactedMd}\nResults: ${join(resultsDir, runId)}.{json,md}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`bench: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
