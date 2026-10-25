// Codex as an agent session for the runtime: one app-server connection and one
// thread per session, read-only. Each turn streams `item/agentMessage/delta`
// and ends with `turn/completed`; stop() sends `turn/interrupt`. Approval
// requests from the server go to the runtime, which declines them in this
// iteration; the protocol answer is built here. Shapes: codex-rs
// app-server-protocol v2 (thread.rs, turn.rs, item.rs), docs/codex-app-server.md.
//
// Native sub-agents (Codex's own multi-agent tools) bypass the runtime: no
// interception, their own model and effort. With `nativeSubagents: false` they
// are switched off for this thread only (thread/start `config`, the user's
// configuration is untouched) and, as a safety net, a turn that still starts
// one is interrupted and fails with CodexSubagentError.

import type {
  AgentFactory,
  AgentIdentity,
  AgentSubagentOptions,
  AgentSession,
  AgentTurn,
  AgentTurnHandlers,
} from '../agent.js';
import { CodexAuthError, isUsable } from './auth.js';
import { connectCodex, type CodexSessionOptions } from './session.js';

export interface CodexAgentConfig extends Omit<
  CodexSessionOptions,
  'onNotification' | 'onServerRequest' | 'clientInfo'
> {
  /** Working directory of the thread: the workspace. */
  readonly cwd: string;
  /** Model id from `model/list` (e.g. `gpt-6-luna`); default: the user's configuration. */
  readonly model?: string;
  /** Reasoning effort for every turn (e.g. `low`); default: the user's configuration. */
  readonly effort?: string;
  /** Time allowed for an interrupted turn to report completion, default 10 s. */
  readonly interruptTimeoutMs?: number;
  /** False: no native sub-agents in this thread (see above). Default: the user's configuration. */
  readonly nativeSubagents?: boolean;
}

/**
 * Per-thread overrides (thread/start `config`) that hold Codex's own sub-agents
 * to a policy, without touching the user's configuration. Keys from
 * codex-rs/core/config.schema.json at rust-v0.164.0, where multi-agent v2 is
 * the active backend:
 * - the default model and effort of a spawned sub-agent, used when the spawn
 *   call selects none; the spawn tool does not expose model or effort, so it
 *   cannot select them;
 * - the number of sub-agent threads open at once, for the selected backend and
 *   for v2;
 * - the mode hint (when to spawn) and the root and sub-agent usage hints.
 *   Configured hints replace Codex's built-in texts whole, so they also say
 *   what the multi-agent tools do.
 */
export function subagentThreadConfig(policy: AgentSubagentOptions): Record<string, unknown> {
  const v2 = 'features.multi_agent_v2';
  return {
    'agents.default_subagent_model': policy.model,
    'agents.default_subagent_reasoning_effort': policy.effort,
    'agents.max_concurrent_threads_per_session': policy.maxConcurrent,
    [`${v2}.max_concurrent_threads_per_session`]: policy.maxConcurrent,
    [`${v2}.expose_spawn_agent_model_overrides`]: false,
    [`${v2}.multi_agent_mode_hint_text`]:
      'Crea sotto-agenti solo se l’utente lo chiede esplicitamente; altrimenti lavora da solo. ' +
      'Nessuna istruzione precedente che chiede di delegare in modo proattivo vale più.',
    [`${v2}.root_agent_usage_hint_text`]: [
      'Sei `/root`, l’agente principale di questa sessione Codex.',
      'Con `spawn_agent` crei un sotto-agente interno, con `followup_task` gli dai un nuovo compito',
      'e con `send_message` gli mandi un messaggio; i suoi risultati ti arrivano come messaggi con',
      'Message Type, Task name, Sender e Payload. I sotto-agenti sono istanze interne di Codex.',
      '',
      policy.rules,
    ].join('\n'),
    [`${v2}.subagent_usage_hint_text`]: [
      'Sei un sotto-agente interno di Codex, creato da un altro agente Codex per un compito.',
      'Quello che scrivi nel canale finale torna all’agente che ti ha creato. Non sei un agente',
      'esterno e non devi presentarti come tale.',
      '',
      policy.rules,
    ].join('\n'),
  };
}

/** Per-thread overrides that switch the multi-agent tools off (`codex features list`). */
export const NO_SUBAGENTS_CONFIG: Readonly<Record<string, boolean>> = {
  'features.multi_agent': false,
  'features.multi_agent_v2': false,
};

/** Thread items that mean Codex is starting or driving a sub-agent of its own. */
const SUBAGENT_ITEMS = new Set(['subAgentActivity', 'collabAgentToolCall']);

export class CodexSubagentError extends Error {
  override readonly name = 'CodexSubagentError';

  readonly itemType: string;

  // A plain field rather than a parameter property: runnable with Node's type stripping.
  constructor(itemType: string) {
    super(
      `Codex started a native sub-agent (${itemType}) although they are disabled for this ` +
        'thread; the turn was interrupted',
    );
    this.itemType = itemType;
  }
}

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Answer that declines what an approval request asks for, per request method. */
export function declineResponse(method: string): unknown {
  switch (method) {
    case 'item/commandExecution/requestApproval':
    case 'item/fileChange/requestApproval':
      return { decision: 'decline' };
    case 'item/permissions/requestApproval':
      return { permissions: {}, scope: 'turn' }; // nothing granted
    case 'mcpServer/elicitation/request':
      return { action: 'decline', content: null };
    default:
      throw new Error(`${method} is not supported by this client`);
  }
}

function summarize(method: string, params: unknown): string {
  if (!isRecord(params)) return method;
  const command = params['command'];
  const reason = params['reason'];
  const parts = [
    Array.isArray(command) ? command.join(' ') : typeof command === 'string' ? command : undefined,
    typeof reason === 'string' ? reason : undefined,
  ].filter((part): part is string => part !== undefined && part !== '');
  return parts.length > 0 ? parts.join(' — ') : method;
}

type TurnOutcome = { text: string; identity: AgentIdentity } | Error;

interface RunningTurn {
  readonly handlers: AgentTurnHandlers;
  turnId?: string;
  readonly messages: string[];
  settle(outcome: TurnOutcome): void;
  /** Interrupts the turn and fails it with `error`. */
  abort(error: Error): Promise<void>;
}

export function createCodexAgentFactory(config: CodexAgentConfig): AgentFactory {
  return async ({ instructions, subagents }): Promise<AgentSession> => {
    const {
      cwd,
      model,
      effort,
      interruptTimeoutMs = 10_000,
      nativeSubagents,
      ...sessionOptions
    } = config;
    const subagentsOff = nativeSubagents === false;
    let current: RunningTurn | undefined;
    let threadId = '';
    let identity: AgentIdentity = { provider: 'Codex', model: '', effort: null, sessionId: '' };

    const session = await connectCodex({
      ...sessionOptions,
      clientInfo: { name: 'only-one-chat', title: 'Only One Chat', version: '0.0.0' },
      onNotification(method, params) {
        const turn = current;
        if (!turn || !isRecord(params)) return;
        // Checked on every thread: a sub-agent's own items carry its thread id.
        if (method === 'item/started' && isRecord(params['item'])) {
          const type = String(params['item']['type']);
          if (SUBAGENT_ITEMS.has(type)) {
            turn.handlers.onActivity?.({
              kind: 'subagent',
              detail: JSON.stringify(params['item']),
            });
            if (subagentsOff) void turn.abort(new CodexSubagentError(type));
            return;
          }
        }
        if (params['threadId'] !== threadId) return;
        if (method === 'item/agentMessage/delta' && typeof params['delta'] === 'string') {
          turn.handlers.onText(params['delta']);
        } else if (method === 'item/completed' && isRecord(params['item'])) {
          const item = params['item'];
          if (item['type'] === 'agentMessage' && typeof item['text'] === 'string') {
            turn.messages.push(item['text']);
          }
        } else if (method === 'item/started' && isRecord(params['item'])) {
          const item = params['item'];
          if (item['type'] === 'commandExecution') {
            turn.handlers.onActivity?.({ kind: 'command', detail: String(item['command']) });
          } else if (item['type'] === 'mcpToolCall') {
            turn.handlers.onActivity?.({
              kind: 'mcp_tool',
              detail: `${String(item['server'])}/${String(item['tool'])} ${JSON.stringify(item['arguments'])}`,
            });
          }
        } else if (method === 'error' && isRecord(params['error'])) {
          turn.handlers.onActivity?.({ kind: 'error', detail: String(params['error']['message']) });
        } else if (method === 'turn/completed' && isRecord(params['turn'])) {
          const completed = params['turn'];
          if (turn.turnId !== undefined && completed['id'] !== turn.turnId) return;
          const status = completed['status'];
          if (status === 'completed') turn.settle({ text: turn.messages.join('\n\n'), identity });
          else {
            const error = isRecord(completed['error']) ? String(completed['error']['message']) : '';
            turn.settle(new Error(`Codex turn ${String(status)}${error ? `: ${error}` : ''}`));
          }
        }
      },
      async onServerRequest(method, params) {
        const summary = summarize(method, params);
        // The runtime records the request; without a turn there is nobody to ask.
        // Its only possible decision in this iteration is to decline.
        if (current) await current.handlers.onApprovalRequest({ kind: method, summary });
        return declineResponse(method);
      },
    });
    if (!isUsable(session.auth)) {
      const state = session.auth;
      await session.close();
      throw new CodexAuthError(state);
    }

    try {
      const started = await session.request('thread/start', {
        cwd,
        sandbox: 'read-only',
        approvalPolicy: 'on-request',
        // Approvals go to us, never to Codex's own automatic reviewer.
        approvalsReviewer: 'user',
        developerInstructions: instructions,
        ephemeral: true,
        ...(model ? { model } : {}),
        ...(subagentsOff
          ? { config: NO_SUBAGENTS_CONFIG }
          : subagents
            ? { config: subagentThreadConfig(subagents) }
            : {}),
      });
      const response = isRecord(started) ? started : {};
      const thread = isRecord(response['thread']) ? response['thread'] : {};
      threadId = typeof thread['id'] === 'string' ? thread['id'] : '';
      if (threadId === '') throw new Error('thread/start returned no thread id');
      // As Codex reports them for this thread, not as configured here.
      const provider = session.provider;
      const route =
        provider?.unofficialBaseUrl === true ? ` via ${provider.name ?? provider.id}` : '';
      const threadEffort = response['reasoningEffort'];
      identity = {
        provider: `Codex${route}`,
        model: typeof response['model'] === 'string' ? response['model'] : (model ?? 'unknown'),
        effort: effort ?? (typeof threadEffort === 'string' ? threadEffort : null),
        sessionId: threadId,
      };
    } catch (error) {
      await session.close();
      throw error;
    }
    const resolvedModel = model ?? 'default model';

    function runTurn(prompt: string, handlers: AgentTurnHandlers): AgentTurn {
      if (current) throw new Error('A Codex turn is already running in this session');
      let settle!: (outcome: TurnOutcome) => void;
      const done = new Promise<{ text: string; identity: AgentIdentity }>((resolve, reject) => {
        settle = (outcome) => {
          if (current === turn) current = undefined;
          if (outcome instanceof Error) reject(outcome);
          else resolve(outcome);
        };
      });
      const turn: RunningTurn = {
        handlers,
        messages: [],
        settle,
        async abort(error) {
          if (turn.turnId !== undefined) {
            await session
              .request('turn/interrupt', { threadId, turnId: turn.turnId })
              .catch(() => undefined);
          }
          settle(error);
        },
      };
      current = turn;
      session
        .request('turn/start', {
          threadId,
          input: [{ type: 'text', text: prompt }],
          ...(model ? { model } : {}),
          ...(effort ? { effort } : {}),
        })
        .then((response) => {
          if (isRecord(response) && isRecord(response['turn'])) {
            const id = response['turn']['id'];
            if (typeof id === 'string') turn.turnId = id;
          }
        })
        .catch((error: unknown) => {
          settle(error instanceof Error ? error : new Error(String(error)));
        });

      return {
        done,
        async stop() {
          if (current !== turn) return;
          if (turn.turnId !== undefined) {
            await session
              .request('turn/interrupt', { threadId, turnId: turn.turnId })
              .catch(() => undefined);
          }
          const timer = setTimeout(() => {
            settle(new Error('Codex turn interrupted (no completion reported)'));
          }, interruptTimeoutMs);
          await done.catch(() => undefined);
          clearTimeout(timer);
        },
      };
    }

    return {
      name: `Codex (${resolvedModel})`,
      id: 'codex',
      runTurn,
      close: () => session.close(),
    };
  };
}
