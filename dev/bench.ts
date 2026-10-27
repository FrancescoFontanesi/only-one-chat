// Benchmark of a sandbox scenario (sandbox/README.md): one run of one system,
// measured. Dev tooling only.
//
//   pnpm bench --system <name> [--scenario calc] [--fake]
//
// Each run gets a fresh working directory outside the repository
// (%LOCALAPPDATA%\only-one-chat\sandbox\<run>), empty or holding a copy of the
// scenario's seed project; the agents work there in sandbox mode (ADR 0008),
// messages between agents approved automatically and logged. A scenario with a
// brief.txt runs it as a brief from the reasoning chat (ADR 0009): through a
// gateway and an implementer, or given to a single agent. Afterwards the
// scenario's hidden tests run on what they wrote.
// Results: sandbox/results/<run>.json and .md (with --fake, in the run
// directory instead). --fake drives the fake CLIs: no model turns, no quota.
//
// Claude reports its quota only when a turn starts, so a run brackets the
// system with two probes: a minimal Haiku turn (no tools, "Rispondi solo OK")
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
import {
  startClaudeTurn,
  CLAUDE_SUBAGENT_FORBIDDEN_NAMES,
  CODEX_SUBAGENT_FORBIDDEN_NAMES,
  codexQuota,
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
  openEventLog,
  parseBrief,
  requestPrompt,
  runLoop,
  type Brief,
  type SubagentPolicy,
  type AgentFactory,
  type LoopOutcome,
  type ThreadEvent,
  type TokenUsage,
  type TurnUsage,
} from '../packages/runtime/src/index.js';
import { loadSuite, runHiddenTests, type HiddenResults } from './bench/hidden.js';
import {
  findLeaks,
  homeLiteral,
  localNameLiterals,
  localNames,
  redactTranscript,
} from '../packages/adapters/dev/redact.js';

interface AgentConfig {
  readonly cli: 'codex' | 'claude';
  readonly model: string;
  readonly effort: string;
}

interface SystemConfig {
  /** `leader` and `session` run a scenario's script.json, one message after another. */
  readonly kind: 'pipeline' | 'gateway' | 'single' | 'leader' | 'session';
  readonly title: string;
  /** `leader`: the leader, read-only, kept for the whole session; `implementer` writes. */
  readonly leader?: AgentConfig;
  readonly planner?: AgentConfig;
  readonly executor?: AgentConfig;
  readonly gateway?: AgentConfig;
  readonly implementer?: AgentConfig;
  /** Gateway systems: a light leader (forwards the brief, judges on the facts). */
  readonly light?: boolean;
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
  readonly usage: TurnUsage | null;
  readonly quota: QuotaSnapshot | null;
}

/** A session system: one model, one long chat, every message of the script in it. */
const SESSION_AGENT_INSTRUCTIONS = [
  "Sei un agente di Only One Chat: conversi con l'utente in questa chat e lavori sul progetto nella",
  'cartella corrente; crea e modifica file solo lì. Per una richiesta di modifica: implementa, scrivi',
  'test automatici, eseguili insieme a quelli esistenti e correggi finché passano; poi rispondi in',
  'breve con cosa hai fatto, le decisioni prese e i problemi. Per una domanda rispondi senza',
  'modificare nulla. Se manca una decisione che cambia il risultato, chiedila.',
].join('\n');

/** System B's only turn: implement, test and report like the pipeline's executor. */
const SINGLE_AGENT_INSTRUCTIONS = [
  "Sei un agente di Only One Chat. Implementa la richiesta dell'utente nella cartella corrente:",
  'crea e modifica file solo lì, scrivi i test, eseguili e correggi finché passano. Alla fine',
  'rispondi solo con questo rapporto:',
  '## File',
  '<elenco dei file creati o modificati>',
  '## Test',
  '<comando eseguito, test passati e falliti>',
  '## Problemi',
  '<problemi rimasti, oppure "Nessuno">',
].join('\n');

const REPO = join(import.meta.dirname, '..');
const env = process.env;

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
 * What the runtime verified, as text for the gateway: the files changed since
 * the seed and the scenario's verification command, run again here.
 */
async function verifiedFacts(
  runDir: string,
  baseline: Map<string, string>,
  verify: readonly string[] | undefined,
): Promise<string> {
  const changed = changes(baseline, snapshot(runDir));
  const lines = [
    'File cambiati rispetto al progetto di partenza:',
    ...(changed.length > 0 ? changed.map((change) => `- ${change}`) : ['- nessuno']),
  ];
  if (verify) {
    const run = await runCommand(verify, runDir);
    const output = run.output.replace(/\r\n/g, '\n').trim();
    const tail = output.split('\n').slice(-15).join('\n');
    // unittest names each failure on a "FAIL: test (module.Class.test)" line.
    const failed = output.split('\n').filter((line) => /^(FAIL|ERROR): /.test(line));
    lines.push(
      '',
      `Verifica eseguita dal runtime: ${verify.join(' ')} → exit ${String(run.code)}${run.timedOut ? ' (timeout)' : ''}`,
      ...(failed.length > 0 ? ['Test falliti:', ...failed.map((line) => `- ${line}`)] : []),
      'Ultime righe dell’output:',
      tail || '(nessun output)',
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
  if (!quota) return 'non riportata';
  return quota.windows.map((w) => `${w.name} ${String(w.usedPercent)}%`).join(', ');
}

async function main(): Promise<void> {
  const systemName = argument('system');
  const scenario = argument('scenario') ?? 'calc';
  const fake = process.argv.includes('--fake');
  const scenarioDir = join(REPO, 'sandbox', 'scenarios', scenario);
  const systems = JSON.parse(readFileSync(join(scenarioDir, 'systems.json'), 'utf8')) as {
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
  const scriptPath = join(scenarioDir, 'script.json');
  /** A session scenario: the user's messages, in order (a file is read as it is: a brief). */
  const script = existsSync(scriptPath)
    ? (
        JSON.parse(readFileSync(scriptPath, 'utf8')) as {
          messages: { name: string; text?: string; file?: string }[];
        }
      ).messages.map((message) => ({
        name: message.name,
        text: message.file
          ? readFileSync(join(scenarioDir, message.file), 'utf8')
          : (message.text ?? ''),
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

  // Who writes depends on the role: planners and gateways read only (ADR 0008).
  const codex = (config: AgentConfig, writable: boolean): AgentFactory =>
    createCodexAgentFactory({
      executable: codexExecutable,
      launcherArgs: codexLauncher,
      cwd: runDir,
      model: config.model,
      effort: config.effort,
      requestTimeoutMs: 120_000,
      writable,
      // Experiments run isolated from the user's hooks (graft writes into the run directory).
      withoutUserHooks: true,
    });
  const claude = (config: AgentConfig, writable: boolean): AgentFactory =>
    createClaudeAgentFactory({
      executable: claudeExecutable,
      launcherArgs: claudeLauncher,
      cwd: runDir,
      model: config.model,
      effort: config.effort,
      ...(writable ? { sandbox: { commands: systems.sandboxCommands } } : {}),
    });
  const factory = (config: AgentConfig, writable: boolean) =>
    config.cli === 'codex' ? codex(config, writable) : claude(config, writable);
  /** The sub-agent policy of an agent, from its CLI. */
  const policy = (config: AgentConfig): SubagentPolicy | undefined => {
    const sub = system.subagents;
    if (!sub) return undefined;
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
        prompt: 'Rispondi solo OK',
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
  // The fakes answer by marker: [delegation], [spec] or [light] asks for a delegation.
  const request = !fake
    ? prompt
    : system.kind === 'pipeline'
      ? `${prompt}\n\n[delegation]`
      : system.kind === 'gateway'
        ? prompt.replace('\n', system.light === true ? '\n[light]\n' : '\n[spec]\n')
        : prompt;
  const [lead, doer] =
    system.kind === 'pipeline'
      ? [system.planner, system.executor]
      : system.kind === 'gateway'
        ? [system.gateway, system.implementer]
        : [undefined, undefined];
  /** A session's answers, one per script message. */
  type Answer = { readonly name: string; readonly status: string; readonly text: string };
  let outcome:
    | LoopOutcome
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
    const leaderSession = await factory(
      leaderConfig,
      true,
    )(agentSessionOptions(leaderInstructions(system.implementer.cli), proactive));
    const answers: Answer[] = [];
    try {
      for (const message of script) {
        currentMessage = message.name;
        process.stdout.write(`\n— ${message.name}\n`);
        // The fake leader answers [light] with a delegation block.
        const isBrief = parseBrief(message.text).status === 'valid';
        const text = fake && isBrief ? message.text.replace('\n', '\n[light]\n') : message.text;
        const loop = runLoop({
          request: text,
          log,
          onEvent,
          mode: 'leader',
          leaderSession,
          autoApprove: true,
          orchestrator: () => Promise.reject(new Error('the leader session is given')),
          worker: factory(system.implementer, true),
          subagents: {
            ...(proactive ? { orchestrator: proactive } : {}),
            ...(implementerPolicy ? { worker: implementerPolicy } : {}),
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
    }
    outcome = { status: 'session', answers };
  } else if (script && system.kind === 'session' && system.agent) {
    await log.append('loop_started', { request, mode: 'session', autoApprove: true });
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
  } else if ((system.kind === 'pipeline' || system.kind === 'gateway') && lead && doer) {
    const leadPolicy = policy(lead);
    const doerPolicy = policy(doer);
    const loop = runLoop({
      request,
      log,
      onEvent,
      mode: system.kind,
      ...(system.light === true ? { light: true } : {}),
      autoApprove: true,
      orchestrator: factory(lead, false),
      worker: factory(doer, true),
      subagents: {
        ...(leadPolicy ? { orchestrator: leadPolicy } : {}),
        ...(doerPolicy ? { worker: doerPolicy } : {}),
      },
      ...(system.kind === 'gateway'
        ? { facts: () => verifiedFacts(runDir, baseline, systems.verify) }
        : {}),
      intercept: () => Promise.reject(new Error('not used with autoApprove')),
      onMalformedDelegation: () => Promise.reject(new Error('not used with autoApprove')),
    });
    process.on('SIGINT', () => void loop.stop());
    outcome = await loop.done;
  } else if (system.kind === 'single' && system.agent) {
    await log.append('loop_started', { request, mode: 'single', autoApprove: true });
    const session = await factory(
      system.agent,
      true,
    )({ instructions: brief ? BRIEF_AGENT_INSTRUCTIONS : SINGLE_AGENT_INSTRUCTIONS });
    record({ type: 'turn_started', role: 'worker', agent: session.name });
    try {
      const turn = session.runTurn(brief ? briefAgentPrompt(brief) : requestPrompt(request), {
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

  const hidden: HiddenResults = await runHiddenTests(suite, runDir, {
    ...env,
    PYTHONDONTWRITEBYTECODE: '1',
  });
  const files = listFiles(runDir);
  // The same check for every system, for the evaluation: not shown to any agent.
  const finalFacts = brief || script ? await verifiedFacts(runDir, baseline, systems.verify) : null;
  const resultForChat =
    outcome.status === 'result'
      ? outcome.result
      : outcome.status === 'single' && brief
        ? (extractResult(outcome.report) ?? outcome.report)
        : outcome.status === 'clarification'
          ? outcome.questions
          : null;
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
    otherEvents: events,
  };

  const md = [
    `# ${runId}`,
    '',
    `${system.title}${fake ? ' (fake: nessun turno reale)' : ''}`,
    '',
    `- Esito: ${JSON.stringify('verdict' in outcome ? outcome.verdict : outcome.status)}`,
    `- Test nascosti: ${String(hidden.passed)}/${String(hidden.total)}`,
    `- Tempo totale: ${(wallMs / 1000).toFixed(1)} s`,
    `- Quota Codex: prima ${quotaText(codexBefore)}; dopo ${quotaText(codexAfter)}`,
    `- Quota Claude (sonde): prima ${quotaText(claudeBefore?.quota)}; dopo ${quotaText(claudeAfter?.quota)}`,
    `- Costo nominale Claude: $${costUsd.toFixed(4)}`,
    `- File: ${files.map((f) => `${f.path} (${String(f.lines)})`).join(', ') || 'nessuno'}`,
    '',
    '| Messaggio | Turno | Etichetta | Tempo | Contesto letto | Output | Quota vista |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...turns.map((t) => {
      // Context read in the turn: every model's input, cached or not, cache writes included.
      const models = Object.values(t.usage?.byModel ?? {});
      const read = models.reduce((s, m) => s + m.input + m.cachedInput + m.cacheWrite, 0);
      const out = models.reduce((s, m) => s + m.output, 0);
      return `| ${t.message ?? ''} | ${t.role} | ${t.label} | ${((t.usage?.durationMs ?? 0) / 1000).toFixed(1)} s | ${String(read)} | ${String(out)} | ${quotaText(t.quota)} |`;
    }),
    '',
    '| Modello | Input | Cache letta | Cache scritta | Output | di cui ragionamento |',
    '| --- | --- | --- | --- | --- | --- |',
    ...Object.entries(tokens).map(
      ([model, t]) =>
        `| ${model} | ${String(t.input)} | ${String(t.cachedInput)} | ${String(t.cacheWrite)} | ${String(t.output)} | ${String(t.reasoning)} |`,
    ),
    '',
    'Test nascosti falliti:',
    ...hidden.cases.filter((c) => !c.passed).map((c) => `- ${c.name}: ${c.reason ?? ''}`),
    '',
    ...(resultForChat === null
      ? []
      : ['## Risultato per la chat di ragionamento', '', '```text', resultForChat, '```', '']),
    ...(outcome.status === 'session'
      ? outcome.answers.flatMap((answer) => [
          `## Risposta a ${answer.name} (${answer.status})`,
          '',
          '```text',
          answer.text,
          '```',
          '',
        ])
      : []),
    ...(finalFacts === null
      ? []
      : ['## Verifica finale del runner', '', '```text', finalFacts, '```', '']),
  ].join('\n');
  // The results go into the repository: redacted like the fixtures, and kept in
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
  process.stdout.write(`\n${redactedMd}\nRisultati: ${join(resultsDir, runId)}.{json,md}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`bench: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
