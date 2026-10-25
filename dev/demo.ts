// Terminal demo of the D6 loop with the real CLIs: Codex orchestrates, Claude
// works, both read-only, in the user's own profiles. Every message to an agent
// is shown first and can be approved, edited or cancelled; answers stream.
// Dev tooling only (pnpm demo); nothing here ships in the extension.
//
// Configuration (environment, with defaults for the cheap models):
//   CODEX_EXECUTABLE, CLAUDE_EXECUTABLE   native binaries (else searched on PATH)
//   OOC_CODEX_MODEL=gpt-6-luna  OOC_CODEX_EFFORT=low
//   OOC_CLAUDE_MODEL=haiku      OOC_CLAUDE_EFFORT=low
//   OOC_LOG_DIR                 event logs, outside the repository
//                               (default %LOCALAPPDATA%\only-one-chat\logs or
//                               ~/.local/state/only-one-chat/logs)
//   OOC_ALLOW_UNVERIFIED_PROVIDER=1   accept a provider whose billing cannot be verified
//   OOC_CODEX_TRACE=<file.jsonl>      write the Codex wire traffic as a transcript,
//                               redacted like the recorded fixtures (raw traffic
//                               is never written: nothing is if a leak is found)
// Arguments: --request "<text>" to skip the first question; --question for the
// mini conversation: Codex only asks Claude one question (`<<<DELEGA @claude`),
// with its native sub-agents switched off for the thread, and the run ends
// with Claude's answer.
// Ctrl+C stops the loop (interrupts the running turn); a second one exits.

import { writeFileSync } from 'node:fs';
import { homedir, hostname, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import {
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
import {
  findLeaks,
  projectCodexConfig,
  redactTranscript,
} from '../packages/adapters/dev/redact.js';

const env = process.env;
const workspace = process.cwd();
const config = {
  codexModel: env['OOC_CODEX_MODEL'] ?? 'gpt-6-luna',
  codexEffort: env['OOC_CODEX_EFFORT'] ?? 'low',
  claudeModel: env['OOC_CLAUDE_MODEL'] ?? 'haiku',
  claudeEffort: env['OOC_CLAUDE_EFFORT'] ?? 'low',
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
const trace: { type: 'message'; dir: 'client' | 'server'; atMs: number; message: unknown }[] = [];
const traceStarted = Date.now();

function writeTrace(path: string, scenario: string): void {
  const init = trace
    .map(
      (entry) =>
        (entry.message as { result?: { codexHome?: unknown; userAgent?: unknown } }).result,
    )
    .find((result) => typeof result?.userAgent === 'string');
  const codexHome = typeof init?.codexHome === 'string' ? init.codexHome : undefined;
  const userAgent = typeof init?.userAgent === 'string' ? init.userAgent : 'unknown';
  const literals = new Map<string, string>();
  const addPath = (value: string, placeholder: string) => {
    for (const form of [value, value.replaceAll('\\', '/')]) literals.set(form, placeholder);
  };
  addPath(workspace, '<WORKSPACE>');
  if (codexHome) addPath(codexHome, '<CODEX_HOME>');
  addPath(tmpdir(), '<TMP>');
  addPath(homedir(), '<HOME>');
  literals.set(userInfo().username, '<user>');
  literals.set(hostname(), '<host>');
  const meta = {
    type: 'meta',
    scenario,
    codexVersion: /\/(\d+\.\d+\.\d+[\w.-]*)/.exec(userAgent)?.[1] ?? 'unknown',
    userAgent,
    recordedAt: new Date().toISOString(),
    platform: `${process.platform}-${process.arch}`,
    commands: { recorder: 'OOC_CODEX_TRACE=<file> pnpm demo', model: config.codexModel },
  };
  const entries = trace.map((entry) => ({ ...entry, message: projectCodexConfig(entry.message) }));
  const text = `${redactTranscript([meta, ...entries], [...literals])
    .map((entry) => JSON.stringify(entry))
    .join('\n')}\n`;
  const leaks = findLeaks(text, [userInfo().username, hostname()]);
  if (leaks.length > 0) {
    process.stderr.write(
      `demo: Codex trace not written, possible leaks: ${leaks.map((leak) => leak.kind).join(', ')}\n`,
    );
    return;
  }
  writeFileSync(path, text);
  process.stdout.write(`Codex trace (redacted): ${path}\n`);
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
    orchestrator: createCodexAgentFactory({
      executable: codexExecutable,
      cwd: workspace,
      model: config.codexModel,
      effort: config.codexEffort,
      allowUnverifiedProvider: config.allowUnverifiedProvider,
      requestTimeoutMs: 120_000,
      ...(question ? { nativeSubagents: false } : {}),
      ...(env['OOC_CODEX_TRACE']
        ? {
            onWire: (dir: 'client' | 'server', message: unknown) => {
              trace.push({ type: 'message', dir, atMs: Date.now() - traceStarted, message });
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
