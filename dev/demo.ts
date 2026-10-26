// Terminal demo of the D6 loop with the real CLIs: Codex orchestrates, Claude
// works, both read-only, in the user's own profiles. Every message to an agent
// is shown first and can be approved, edited or cancelled; answers stream.
// Dev tooling only (pnpm demo); nothing here ships in the extension.
//
// Configuration (environment, with defaults for the cheap models):
//   CODEX_EXECUTABLE, CLAUDE_EXECUTABLE   native binaries (else searched on PATH)
//   OOC_CODEX_MODEL=gpt-6-luna  OOC_CODEX_EFFORT=low
//   OOC_CLAUDE_MODEL=haiku      OOC_CLAUDE_EFFORT=low
//   Sub-agents (D13), each CLI's own, visible and held to these:
//   OOC_CODEX_SUBAGENT_MODEL=gpt-6-luna         OOC_CODEX_SUBAGENT_EFFORT=low
//   OOC_CLAUDE_SUBAGENT_MODEL=claude-haiku-5-5  OOC_CLAUDE_SUBAGENT_EFFORT=low
//   OOC_MAX_SUBAGENTS=2
//   OOC_LOG_DIR                 event logs, outside the repository
//                               (default %LOCALAPPDATA%\only-one-chat\logs or
//                               ~/.local/state/only-one-chat/logs)
//   OOC_ALLOW_UNVERIFIED_PROVIDER=1   accept a provider whose billing cannot be verified
//   OOC_CODEX_TRACE=<file.jsonl>      write the Codex wire traffic as a transcript,
//                               redacted like the recorded fixtures (raw traffic
//                               is never written: nothing is if a leak is found)
// Arguments: --request "<text>" to skip the first question; --question for the
// mini conversation: Codex only asks Claude one question (`<<<DELEGA @claude`)
// and the run ends with Claude's answer. In both modes each CLI's own
// sub-agents are allowed, shown with their label and held to the policy above.
// Ctrl+C stops the loop (interrupts the running turn); a second one exits.

import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import {
  CLAUDE_SUBAGENT_FORBIDDEN_NAMES,
  CODEX_SUBAGENT_FORBIDDEN_NAMES,
  createClaudeAgentFactory,
  createCodexAgentFactory,
  resolveClaudeExecutable,
  resolveCodexExecutable,
} from '../packages/adapters/src/index.js';
import {
  openEventLog,
  runLoop,
  type InterceptDecision,
  type MalformedDecision,
  type Role,
  type ThreadEvent,
} from '../packages/runtime/src/index.js';
import { Trace, codexVersion } from './trace.js';

const env = process.env;
const workspace = process.cwd();
const config = {
  codexModel: env['OOC_CODEX_MODEL'] ?? 'gpt-6-luna',
  codexEffort: env['OOC_CODEX_EFFORT'] ?? 'low',
  claudeModel: env['OOC_CLAUDE_MODEL'] ?? 'haiku',
  claudeEffort: env['OOC_CLAUDE_EFFORT'] ?? 'low',
  codexSubagentModel: env['OOC_CODEX_SUBAGENT_MODEL'] ?? 'gpt-6-luna',
  codexSubagentEffort: env['OOC_CODEX_SUBAGENT_EFFORT'] ?? 'low',
  claudeSubagentModel: env['OOC_CLAUDE_SUBAGENT_MODEL'] ?? 'claude-haiku-5-5',
  claudeSubagentEffort: env['OOC_CLAUDE_SUBAGENT_EFFORT'] ?? 'low',
  maxSubagents: Number(env['OOC_MAX_SUBAGENTS'] ?? '2'),
  allowUnverifiedProvider: env['OOC_ALLOW_UNVERIFIED_PROVIDER'] === '1',
  logDir:
    env['OOC_LOG_DIR'] ??
    (process.platform === 'win32'
      ? join(env['LOCALAPPDATA'] ?? join(homedir(), 'AppData', 'Local'), 'only-one-chat', 'logs')
      : join(homedir(), '.local', 'state', 'only-one-chat', 'logs')),
};

// One line reader for questions and edits; works with a TTY or piped input.
const rl = createInterface({ input: process.stdin, terminal: false });
const pending: string[] = [];
const waiting: ((line: string | undefined) => void)[] = [];
let inputEnded = false;
rl.on('line', (line) => {
  const next = waiting.shift();
  if (next) next(line);
  else pending.push(line);
});
rl.on('close', () => {
  inputEnded = true;
  for (const next of waiting.splice(0)) next(undefined);
});

function readLine(prompt: string): Promise<string | undefined> {
  process.stdout.write(prompt);
  const line = pending.shift();
  if (line !== undefined) return Promise.resolve(line);
  if (inputEnded) return Promise.resolve(undefined);
  return new Promise((resolve) => waiting.push(resolve));
}

async function readBlock(title: string): Promise<string> {
  process.stdout.write(`${title} (termina con una riga contenente solo ".")\n`);
  const lines: string[] = [];
  for (;;) {
    const line = await readLine('> ');
    if (line === undefined || line.trim() === '.') return lines.join('\n');
    lines.push(line);
  }
}

/** Codex wire traffic for OOC_CODEX_TRACE, kept in memory until it is redacted. */
const trace = new Trace();

function writeTrace(path: string, scenario: string): void {
  const written = trace.write(
    path,
    {
      scenario,
      ...codexVersion(trace),
      platform: `${process.platform}-${process.arch}`,
      commands: { recorder: 'OOC_CODEX_TRACE=<file> pnpm demo', model: config.codexModel },
    },
    workspace,
  );
  if (written) process.stdout.write(`Codex trace (redacted): ${path}\n`);
}

const bar = '─'.repeat(72);
let streaming: Role | undefined;

function endStream(): void {
  if (streaming) process.stdout.write('\n');
  streaming = undefined;
}

function onEvent(event: ThreadEvent): void {
  switch (event.type) {
    case 'turn_started':
      endStream();
      process.stdout.write(`\n${bar}\n▶ ${event.agent} (${event.role})\n`);
      break;
    case 'text':
      streaming = event.role;
      process.stdout.write(event.text);
      break;
    case 'message':
      endStream();
      process.stdout.write(`✔ fine turno — ${event.label}\n`);
      break;
    case 'approval_denied':
      endStream();
      process.stdout.write(`⛔ ${event.agent}: ${event.message} (${event.request.summary})\n`);
      break;
    case 'activity':
      endStream();
      process.stdout.write(`  · ${event.role} ${event.kind}: ${event.detail.slice(0, 160)}\n`);
      break;
    case 'delegation_invalid':
      endStream();
      process.stdout.write(`✖ blocco di delega non valido:\n  - ${event.errors.join('\n  - ')}\n`);
      break;
    case 'subagent':
      endStream();
      process.stdout.write(`  ↳ ${event.label}\n`);
      break;
    case 'subagent_text':
      streaming = event.role;
      process.stdout.write(event.text);
      break;
    case 'subagent_activity':
      endStream();
      process.stdout.write(`    · ${event.kind}: ${event.detail.slice(0, 160)}\n`);
      break;
    case 'subagent_violation':
      endStream();
      process.stdout.write(`✖ ${event.message}\n`);
      break;
    case 'attribution_warning':
      endStream();
      process.stdout.write(`⚠ attribuzione: ${event.message}\n`);
      break;
    case 'error':
      endStream();
      process.stdout.write(`✖ errore: ${event.message}\n`);
      break;
    default:
      break;
  }
}

async function main(): Promise<void> {
  const codexExecutable = await resolveCodexExecutable({
    configuredPath: env['CODEX_EXECUTABLE'] ?? '',
  });
  const claudeExecutable = await resolveClaudeExecutable({
    configuredPath: env['CLAUDE_EXECUTABLE'] ?? '',
  });
  const question = process.argv.includes('--question');
  const at = process.argv.indexOf('--request');
  const request = at >= 0 ? process.argv[at + 1] : await readLine('Richiesta: ');
  if (!request) {
    process.stdout.write('Nessuna richiesta.\n');
    return;
  }
  const logPath = join(
    config.logDir,
    `demo-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`,
  );
  const log = await openEventLog(logPath, workspace);
  process.stdout.write(
    `Workspace: ${workspace}\nCodex ${config.codexModel}/${config.codexEffort} → Claude ${config.claudeModel}/${config.claudeEffort}\nLog: ${logPath}\n`,
  );

  const loop = runLoop({
    request,
    log,
    onEvent,
    ...(question ? { mode: 'question' as const } : {}),
    subagents: {
      orchestrator: {
        model: config.codexSubagentModel,
        effort: config.codexSubagentEffort,
        maxConcurrent: config.maxSubagents,
        forbiddenNames: CODEX_SUBAGENT_FORBIDDEN_NAMES,
      },
      worker: {
        model: config.claudeSubagentModel,
        effort: config.claudeSubagentEffort,
        maxConcurrent: config.maxSubagents,
        forbiddenNames: CLAUDE_SUBAGENT_FORBIDDEN_NAMES,
      },
    },
    orchestrator: createCodexAgentFactory({
      executable: codexExecutable,
      cwd: workspace,
      model: config.codexModel,
      effort: config.codexEffort,
      allowUnverifiedProvider: config.allowUnverifiedProvider,
      requestTimeoutMs: 120_000,
      ...(env['OOC_CODEX_TRACE']
        ? {
            onWire: (dir: 'client' | 'server', message: unknown) => {
              trace.add(dir, message);
            },
          }
        : {}),
    }),
    worker: createClaudeAgentFactory({
      executable: claudeExecutable,
      cwd: workspace,
      model: config.claudeModel,
      effort: config.claudeEffort,
      allowUnverifiedProvider: config.allowUnverifiedProvider,
    }),
    async intercept(message): Promise<InterceptDecision> {
      endStream();
      const what = message.kind === 'delegation' ? 'Delega' : 'Review';
      process.stdout.write(
        `\n${bar}\n✋ ${what} ${message.from} → ${message.to} (scambio ${String(message.exchange)}), da approvare:\n${bar}\n${message.text}\n${bar}\n`,
      );
      for (;;) {
        const answer = (await readLine('[a] approva  [m] modifica  [n] annulla: '))
          ?.trim()
          .toLowerCase();
        if (answer === undefined || answer === 'n') return { action: 'cancel' };
        if (answer === 'a') return { action: 'approve' };
        if (answer === 'm') return { action: 'edit', text: await readBlock('Nuovo testo') };
      }
    },
    async onMalformedDelegation(problem): Promise<MalformedDecision> {
      endStream();
      process.stdout.write(
        `\nIl blocco di delega non rispetta il formato e non viene inoltrato.\n`,
      );
      const choices = problem.canAskOrchestrator
        ? '[c] chiedi a Codex di correggerlo  [m] scrivilo tu  [n] annulla: '
        : '(correzione di Codex già usata)  [m] scrivilo tu  [n] annulla: ';
      for (;;) {
        const answer = (await readLine(choices))?.trim().toLowerCase();
        if (answer === undefined || answer === 'n') return { action: 'cancel' };
        if (answer === 'c' && problem.canAskOrchestrator) return { action: 'ask_orchestrator' };
        if (answer === 'm')
          return {
            action: 'edit',
            text: await readBlock(`Delega (${String(problem.errors.length)} errori sopra)`),
          };
      }
    },
  });

  let interrupts = 0;
  process.on('SIGINT', () => {
    interrupts++;
    if (interrupts > 1) process.exit(130);
    process.stdout.write('\n■ stop richiesto: interrompo il turno in corso…\n');
    void loop.stop();
  });

  const outcome = await loop.done;
  endStream();
  if (outcome.status === 'answered') {
    process.stdout.write(`\n${bar}\nRisposta — ${outcome.label}\n${bar}\n${outcome.answer}\n`);
  }
  process.stdout.write(`\n${bar}\nEsito: ${JSON.stringify(outcome, null, 2)}\nLog: ${logPath}\n`);
  const tracePath = env['OOC_CODEX_TRACE'];
  if (tracePath) writeTrace(tracePath, question ? 'question-turn' : 'demo-turn');
}

main()
  .catch((error: unknown) => {
    process.stderr.write(`demo: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(() => {
    rl.close();
  });
