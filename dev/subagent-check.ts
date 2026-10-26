// Real check of the sub-agent policy (D13), ONE model turn per run, read-only:
//   node --import ./dev/ts-resolve.mjs dev/subagent-check.ts codex|claude <trace.jsonl>
// The turn explicitly asks the CLI for one sub-agent on a minimal task. Every
// sub-agent event is printed with the runtime's label and checked against the
// policy (model, effort, name, number); a violation stops the turn. The wire
// traffic is written to <trace.jsonl> redacted (dev/trace.ts). Same
// configuration as the demo: CODEX_EXECUTABLE, CLAUDE_EXECUTABLE, OOC_*.

import { homedir } from 'node:os';
import {
  CLAUDE_SUBAGENT_FORBIDDEN_NAMES,
  CODEX_SUBAGENT_FORBIDDEN_NAMES,
  createClaudeAgentFactory,
  createCodexAgentFactory,
  resolveClaudeExecutable,
  resolveCodexExecutable,
} from '../packages/adapters/src/index.js';
import {
  agentLabel,
  checkSubagent,
  subagentLabel,
  subagentRules,
  type AgentFactory,
  type SubagentPolicy,
  type SubagentState,
} from '../packages/runtime/src/index.js';
import { Trace, codexVersion } from './trace.js';

const env = process.env;
const [cli, tracePath] = process.argv.slice(2);
const workspace = process.cwd();
const TASK =
  'leggi packages/adapters/src/environment.ts e rispondi in una riga: quali variabili toglie withoutApiKeys?';

const policies: Record<string, SubagentPolicy> = {
  codex: {
    model: env['OOC_CODEX_SUBAGENT_MODEL'] ?? 'gpt-6-luna',
    effort: env['OOC_CODEX_SUBAGENT_EFFORT'] ?? 'low',
    maxConcurrent: 2,
    forbiddenNames: CODEX_SUBAGENT_FORBIDDEN_NAMES,
  },
  claude: {
    model: env['OOC_CLAUDE_SUBAGENT_MODEL'] ?? 'claude-haiku-5-5',
    effort: env['OOC_CLAUDE_SUBAGENT_EFFORT'] ?? 'low',
    maxConcurrent: 2,
    forbiddenNames: CLAUDE_SUBAGENT_FORBIDDEN_NAMES,
  },
};

async function main(): Promise<void> {
  if ((cli !== 'codex' && cli !== 'claude') || !tracePath) {
    throw new Error('usage: subagent-check.ts codex|claude <trace.jsonl>');
  }
  const policy = policies[cli];
  if (!policy) throw new Error(`no policy for ${cli}`);
  const trace = new Trace();
  const onWire = (dir: 'client' | 'server', message: unknown) => {
    trace.add(dir, message);
  };
  const factory: AgentFactory =
    cli === 'codex'
      ? createCodexAgentFactory({
          executable: await resolveCodexExecutable({
            configuredPath: env['CODEX_EXECUTABLE'] ?? '',
          }),
          cwd: workspace,
          model: env['OOC_CODEX_MODEL'] ?? 'gpt-6-luna',
          effort: env['OOC_CODEX_EFFORT'] ?? 'low',
          requestTimeoutMs: 120_000,
          onWire,
        })
      : createClaudeAgentFactory({
          executable: await resolveClaudeExecutable({
            configuredPath: env['CLAUDE_EXECUTABLE'] ?? '',
          }),
          cwd: workspace,
          model: env['OOC_CLAUDE_MODEL'] ?? 'haiku',
          effort: env['OOC_CLAUDE_EFFORT'] ?? 'low',
          onWire,
        });
  const session = await factory({
    instructions: 'Sei un agente di Only One Chat. Lavori in sola lettura nel workspace.',
    subagents: { ...policy, rules: subagentRules(policy) },
  });
  const prompt =
    cli === 'codex'
      ? `L'utente chiede esplicitamente UN sotto-agente: crea un sotto-agente interno che ${TASK} Poi riporta la sua risposta in una riga.`
      : `Usa lo strumento Agent per creare UN sotto-agente che ${TASK} Poi riporta la sua risposta in una riga.`;
  process.stdout.write(`${session.name}: ${prompt}\n\n`);

  const subagents = new Map<string, SubagentState>();
  let violation: string | undefined;
  const show = (state: SubagentState) => {
    subagents.set(state.id, state);
    process.stdout.write(`  ↳ ${subagentLabel(session.name, state)}\n`);
    if (violation !== undefined || state.status !== 'running') return;
    const runningNow = [...subagents.values()].filter((s) => s.status === 'running').length;
    const reason = checkSubagent(policy, state, runningNow);
    if (reason === undefined) return;
    violation = reason;
    process.stdout.write(`✖ sotto-agente non conforme: ${reason}; interrompo il turno\n`);
    void turn.stop();
  };
  const turn = session.runTurn(prompt, {
    onText: (text) => process.stdout.write(text),
    onApprovalRequest: (request) => {
      process.stdout.write(`\n⛔ approvazione rifiutata: ${request.summary}\n`);
      return Promise.resolve('decline');
    },
    onActivity: ({ kind, detail }) =>
      process.stdout.write(`\n  · ${kind}: ${detail.slice(0, 160)}\n`),
    onSubagent: (event) => {
      const known = subagents.get(event.id);
      if (event.type === 'started') {
        show({
          id: event.id,
          name: event.name,
          model: event.model,
          effort: event.effort,
          status: 'running',
        });
      } else if (event.type === 'identified' && known) {
        show({ ...known, model: event.model ?? known.model, effort: event.effort ?? known.effort });
      } else if (event.type === 'finished' && known) {
        show({ ...known, status: event.status });
      } else if (event.type === 'text') {
        process.stdout.write(`    [${event.id.slice(0, 12)}] ${event.text}\n`);
      } else if (event.type === 'activity') {
        process.stdout.write(`    · ${event.kind}: ${event.detail.slice(0, 160)}\n`);
      }
    },
  });
  try {
    const result = await turn.done;
    process.stdout.write(`\n\n✔ ${agentLabel(result.identity)}\n${result.text}\n`);
  } catch (error) {
    process.stdout.write(`\n✖ ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  } finally {
    await session.close();
  }
  process.stdout.write(
    `\nSotto-agenti: ${String(subagents.size)}; violazione: ${violation ?? 'nessuna'}\n`,
  );
  const meta =
    cli === 'codex'
      ? { scenario: 'subagent-turn', ...codexVersion(trace) }
      : { scenario: 'subagent-turn', claudeVersion: 'see init' };
  if (
    trace.write(
      tracePath,
      {
        ...meta,
        platform: `${process.platform}-${process.arch}`,
        commands: { checker: `subagent-check.ts ${cli}` },
      },
      workspace,
    )
  ) {
    process.stdout.write(`Trace (redacted): ${tracePath.replace(homedir(), '~')}\n`);
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `subagent-check: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
