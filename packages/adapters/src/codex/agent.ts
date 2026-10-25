// Codex as an agent session for the runtime: one app-server connection and one
// thread per session, read-only. Each turn streams `item/agentMessage/delta`
// and ends with `turn/completed`; stop() sends `turn/interrupt`. Approval
// requests from the server go to the runtime, which declines them in this
// iteration; the protocol answer is built here. Shapes: codex-rs
// app-server-protocol v2 (thread.rs, turn.rs, item.rs), docs/codex-app-server.md.
//
// Native sub-agents (Codex's own multi-agent tools) are allowed and held to the
// runtime's policy with per-thread overrides (subagentThreadConfig, D13). They
// cannot be approved before they start, only seen: `subAgentActivity` on the
// parent thread announces one with its resolved model and effort, and its own
// thread's messages and commands arrive on the same connection. Each becomes a
// sub-agent event for the runtime, which checks the policy; stop() interrupts
// the sub-agents' turns too.

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

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
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

/** Commands and MCP calls, the same for the parent and its sub-agents. */
function itemActivity(item: Json): { kind: string; detail: string } | undefined {
  if (item['type'] === 'commandExecution') {
    return { kind: 'command', detail: String(item['command']) };
  }
  if (item['type'] === 'mcpToolCall') {
    return {
      kind: 'mcp_tool',
      detail: `${String(item['server'])}/${String(item['tool'])} ${JSON.stringify(item['arguments'])}`,
    };
  }
  return undefined;
}

type TurnOutcome = { text: string; identity: AgentIdentity } | Error;

interface RunningTurn {
  readonly handlers: AgentTurnHandlers;
  turnId?: string;
  readonly messages: string[];
  settle(outcome: TurnOutcome): void;
}

/** A sub-agent seen during the current turn, by its thread id. */
interface Child {
  turnId?: string;
  finished: boolean;
}

const FINISHED: Readonly<Record<string, 'completed' | 'interrupted' | 'failed'>> = {
  completed: 'completed',
  interrupted: 'interrupted',
  failed: 'failed',
};

export function createCodexAgentFactory(config: CodexAgentConfig): AgentFactory {
  return async ({ instructions, subagents }): Promise<AgentSession> => {
    const { cwd, model, effort, interruptTimeoutMs = 10_000, ...sessionOptions } = config;
    let current: RunningTurn | undefined;
    let threadId = '';
    let identity: AgentIdentity = { provider: 'Codex', model: '', effort: null, sessionId: '' };
    const children = new Map<string, Child>();

    function finishChild(
      handlers: AgentTurnHandlers,
      id: string,
      status: 'completed' | 'interrupted' | 'failed',
    ): void {
      const child = children.get(id);
      if (!child || child.finished) return;
      child.finished = true;
      handlers.onSubagent?.({ type: 'finished', id, status });
    }

    /** Notifications of a sub-agent's own thread. */
    function onChildNotification(
      turn: RunningTurn,
      id: string,
      method: string,
      params: Json,
    ): void {
      const child = children.get(id);
      if (!child) return;
      if (method === 'turn/started' && isRecord(params['turn'])) {
        const childTurn = stringOrNull(params['turn']['id']);
        if (childTurn !== null) child.turnId = childTurn;
      } else if (method === 'item/agentMessage/delta' && typeof params['delta'] === 'string') {
        turn.handlers.onSubagent?.({ type: 'text', id, text: params['delta'] });
      } else if (method === 'item/started' && isRecord(params['item'])) {
        const activity = itemActivity(params['item']);
        if (activity) turn.handlers.onSubagent?.({ type: 'activity', id, ...activity });
      } else if (method === 'turn/completed' && isRecord(params['turn'])) {
        finishChild(turn.handlers, id, FINISHED[String(params['turn']['status'])] ?? 'failed');
      }
    }

    /** `subAgentActivity` on the parent thread: a sub-agent started, ended or was used. */
    function onSubagentActivity(turn: RunningTurn, item: Json): void {
      const id = String(item['agentThreadId']);
      const kind = item['kind'];
      if (kind === 'started' && !children.has(id)) {
        children.set(id, { finished: false });
        turn.handlers.onSubagent?.({
          type: 'started',
          id,
          name: String(item['agentPath']),
          model: stringOrNull(item['model']),
          effort: stringOrNull(item['reasoningEffort']),
        });
      } else if (kind === 'completed' || kind === 'interrupted') {
        finishChild(turn.handlers, id, kind);
      }
    }

    const session = await connectCodex({
      ...sessionOptions,
      clientInfo: { name: 'only-one-chat', title: 'Only One Chat', version: '0.0.0' },
      onNotification(method, params) {
        const turn = current;
        if (!turn || !isRecord(params)) return;
        const notifiedThread = params['threadId'];
        if (typeof notifiedThread === 'string' && notifiedThread !== threadId) {
          onChildNotification(turn, notifiedThread, method, params);
          return;
        }
        if (notifiedThread !== threadId) return;
        if (method === 'item/agentMessage/delta' && typeof params['delta'] === 'string') {
          turn.handlers.onText(params['delta']);
        } else if (method === 'item/completed' && isRecord(params['item'])) {
          const item = params['item'];
          if (item['type'] === 'agentMessage' && typeof item['text'] === 'string') {
            turn.messages.push(item['text']);
          }
        } else if (method === 'item/started' && isRecord(params['item'])) {
          const item = params['item'];
          if (item['type'] === 'subAgentActivity') onSubagentActivity(turn, item);
          else if (item['type'] === 'collabAgentToolCall') {
            turn.handlers.onActivity?.({ kind: 'collab', detail: String(item['tool']) });
          } else {
            const activity = itemActivity(item);
            if (activity) turn.handlers.onActivity?.(activity);
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
        ...(subagents ? { config: subagentThreadConfig(subagents) } : {}),
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

    /** Interrupts the turn and every sub-agent turn still running. */
    async function interruptAll(turn: RunningTurn): Promise<void> {
      const targets = [...children]
        .filter(([, child]) => !child.finished && child.turnId !== undefined)
        .map(([id, child]) => ({ threadId: id, turnId: child.turnId }));
      if (turn.turnId !== undefined) targets.push({ threadId, turnId: turn.turnId });
      await Promise.all(
        targets.map((target) => session.request('turn/interrupt', target).catch(() => undefined)),
      );
    }

    function runTurn(prompt: string, handlers: AgentTurnHandlers): AgentTurn {
      if (current) throw new Error('A Codex turn is already running in this session');
      children.clear();
      let settle!: (outcome: TurnOutcome) => void;
      const done = new Promise<{ text: string; identity: AgentIdentity }>((resolve, reject) => {
        settle = (outcome) => {
          if (current === turn) current = undefined;
          if (outcome instanceof Error) reject(outcome);
          else resolve(outcome);
        };
      });
      const turn: RunningTurn = { handlers, messages: [], settle };
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
          await interruptAll(turn);
          const timer = setTimeout(() => {
            settle(new Error('Codex turn interrupted (no completion reported)'));
          }, interruptTimeoutMs);
          await done.catch(() => undefined);
          clearTimeout(timer);
          for (const id of children.keys()) finishChild(turn.handlers, id, 'interrupted');
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
