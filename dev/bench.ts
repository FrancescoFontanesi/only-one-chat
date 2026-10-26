// Benchmark of a sandbox scenario (sandbox/README.md): one run of one system,
// measured. Dev tooling only.
//
//   pnpm bench --system A|B [--scenario calc] [--fake]
//
// Each run gets a fresh, empty working directory outside the repository
// (%LOCALAPPDATA%\only-one-chat\sandbox\<run>); the agents work there in
// sandbox mode (ADR 0008), messages between agents approved automatically and
// logged. Afterwards the scenario's hidden tests run on what they wrote.
// Results: sandbox/results/<run>.json and .md (with --fake, in the run
// directory instead). --fake drives the fake CLIs: no model turns, no quota.
// Executables: CODEX_EXECUTABLE, CLAUDE_EXECUTABLE (else searched on PATH).

import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative } from 'node:path';
import {
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
  agentLabel,
  openEventLog,
  requestPrompt,
  runLoop,
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
  readonly kind: 'pipeline' | 'single';
  readonly title: string;
  readonly planner?: AgentConfig;
  readonly executor?: AgentConfig;
  readonly agent?: AgentConfig;
  readonly subagents?: {
    readonly codex: { readonly model: string; readonly effort: string };
    readonly claude: { readonly model: string; readonly effort: string };
    readonly maxConcurrent: number;
  };
}

interface TurnRecord {
  readonly role: string;
  readonly agent: string;
  readonly label: string;
  readonly usage: TurnUsage | null;
  readonly quota: QuotaSnapshot | null;
}

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
  };
  const system = systemName ? systems.systems[systemName] : undefined;
  if (!systemName || !system)
    throw new Error('usage: bench --system A|B [--scenario calc] [--fake]');
  const prompt = readFileSync(join(scenarioDir, 'prompt.md'), 'utf8').trim();
  const suite = loadSuite(join(scenarioDir, 'hidden-tests.json'));

  const runId = `${scenario}-${systemName}-${new Date().toISOString().replace(/[:.]/g, '-')}${fake ? '-fake' : ''}`;
  const runDir = join(stateDir(), 'sandbox', runId);
  mkdirSync(runDir, { recursive: true });
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

  const codex = (config: AgentConfig): AgentFactory =>
    createCodexAgentFactory({
      executable: codexExecutable,
      launcherArgs: codexLauncher,
      cwd: runDir,
      model: config.model,
      effort: config.effort,
      requestTimeoutMs: 120_000,
    });
  const claude = (config: AgentConfig): AgentFactory =>
    createClaudeAgentFactory({
      executable: claudeExecutable,
      launcherArgs: claudeLauncher,
      cwd: runDir,
      model: config.model,
      effort: config.effort,
      sandbox: { commands: systems.sandboxCommands },
    });
  const factory = (config: AgentConfig) =>
    config.cli === 'codex' ? codex(config) : claude(config);

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
  const onEvent = (event: ThreadEvent): void => {
    if (event.type === 'text' || event.type === 'subagent_text') return;
    if (event.type === 'message') {
      turns.push({
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
  const startedAt = Date.now();
  const request = fake && system.kind === 'pipeline' ? `${prompt}\n\n[delegation]` : prompt;
  let outcome:
    LoopOutcome | { status: 'single'; report: string } | { status: 'failed'; error: string };
  if (system.kind === 'pipeline' && system.planner && system.executor && system.subagents) {
    const sub = system.subagents;
    const loop = runLoop({
      request,
      log,
      onEvent,
      mode: 'pipeline',
      autoApprove: true,
      orchestrator: factory(system.planner),
      worker: factory(system.executor),
      subagents: {
        orchestrator: {
          ...sub.codex,
          maxConcurrent: sub.maxConcurrent,
          forbiddenNames: CODEX_SUBAGENT_FORBIDDEN_NAMES,
        },
        worker: {
          ...sub.claude,
          maxConcurrent: sub.maxConcurrent,
          forbiddenNames: CLAUDE_SUBAGENT_FORBIDDEN_NAMES,
        },
      },
      intercept: () => Promise.reject(new Error('not used with autoApprove')),
      onMalformedDelegation: () => Promise.reject(new Error('not used with autoApprove')),
    });
    process.on('SIGINT', () => void loop.stop());
    outcome = await loop.done;
  } else if (system.kind === 'single' && system.agent) {
    const session = await factory(system.agent)({ instructions: SINGLE_AGENT_INSTRUCTIONS });
    onEvent({ type: 'turn_started', role: 'worker', agent: session.name });
    try {
      const turn = session.runTurn(requestPrompt(request), {
        onText: () => undefined,
        onApprovalRequest: () => Promise.resolve('decline'),
        onActivity: (activity) => {
          onEvent({ type: 'activity', role: 'worker', ...activity });
        },
      });
      process.on('SIGINT', () => void turn.stop());
      const result = await turn.done;
      onEvent({
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

  const hidden: HiddenResults = await runHiddenTests(suite, runDir, {
    ...env,
    PYTHONDONTWRITEBYTECODE: '1',
  });
  const files = listFiles(runDir);
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
    hidden,
    files,
    turns,
    tokens,
    claudeNominalCostUsd: costUsd,
    codexQuota: { before: codexBefore, after: codexAfter },
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
    `- Costo nominale Claude: $${costUsd.toFixed(4)}`,
    `- File: ${files.map((f) => `${f.path} (${String(f.lines)})`).join(', ') || 'nessuno'}`,
    '',
    '| Turno | Etichetta | Tempo | Quota vista |',
    '| --- | --- | --- | --- |',
    ...turns.map(
      (t) =>
        `| ${t.role} | ${t.label} | ${((t.usage?.durationMs ?? 0) / 1000).toFixed(1)} s | ${quotaText(t.quota)} |`,
    ),
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
