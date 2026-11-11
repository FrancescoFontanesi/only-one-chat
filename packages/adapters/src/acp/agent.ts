// An agent spoken to over the Agent Client Protocol (ADR 0023): one JSON-RPC
// 2.0 object per line on the stdio of a CLI's ACP server (Antigravity's
// `agy acp`; any other ACP agent the same way). One process per session; the
// session continues across turns and is reopened with `session/load`.
//
// The client offers no file system and no terminal: the agent works with its
// own tools, and asks with `session/request_permission` what its mode does
// not allow by itself. A read-only role declines every such request unasked.

import { startJsonRpc, type JsonRpcClient } from '../codex/app-server.js';
import { withoutApiKeys } from '../environment.js';
import { StepStream, tail } from '../steps.js';
import type {
  AgentFactory,
  AgentIdentity,
  AgentSession,
  AgentStepStatus,
  AgentTurn,
  AgentTurnHandlers,
  AgentTurnStep,
} from '../agent.js';
import type { TokenUsage, TurnUsage } from '../usage.js';

export interface AcpAgentConfig {
  /** Absolute path of the CLI. */
  readonly executable: string;
  /** What starts its ACP server, e.g. `['acp']`. */
  readonly args: readonly string[];
  /** The provider's name, shown in the thread: "Antigravity". */
  readonly provider: string;
  readonly cwd: string;
  /** The session's model, by the agent's own model id. */
  readonly model?: string;
  /**
   * The agent's own mode (`session/set_mode`), e.g. Antigravity's `auto`;
   * absent: its default, which asks before edits and commands.
   */
  readonly mode?: string;
  /** Every permission request is declined, nobody asked: a read-only role. */
  readonly readOnly?: boolean;
  /** Child environment before the API keys are removed; defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
}

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const count = (value: unknown): number => (typeof value === 'number' ? value : 0);

/** A turn waits for the agent as long as it works: the longest timer Node allows. */
const NO_TIMEOUT = 2_147_483_647;

/** ACP's token usage of a prompt turn, in the adapters' shape. */
export function acpTokens(usage: unknown): TokenUsage | null {
  if (!isRecord(usage)) return null;
  return {
    input: count(usage['inputTokens']),
    cachedInput: count(usage['cachedReadTokens']),
    cacheWrite: count(usage['cachedWriteTokens']),
    output: count(usage['outputTokens']),
    reasoning: count(usage['thoughtTokens']),
  };
}

const STATUS: Readonly<Record<string, AgentStepStatus>> = {
  pending: 'running',
  in_progress: 'running',
  completed: 'done',
  failed: 'failed',
};

/** The text a tool call printed, from its content blocks. */
function toolOutput(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .map((block) =>
      isRecord(block) && isRecord(block['content']) ? text(block['content']['text']) : '',
    )
    .filter(Boolean)
    .join('\n');
}

/** A `tool_call` or `tool_call_update` as a step; the update merges into what is known. */
export function acpToolStep(call: Json): Extract<AgentTurnStep, { kind: 'command' | 'tool' }> {
  const id = text(call['toolCallId']);
  const status = STATUS[text(call['status'])] ?? 'running';
  const title = text(call['title']);
  if (call['kind'] === 'execute') {
    return {
      kind: 'command',
      id,
      command: title,
      status,
      exitCode: null,
      durationMs: null,
      output: tail(toolOutput(call['content'])),
    };
  }
  return {
    kind: 'tool',
    id,
    name: text(call['name']) || text(call['kind']) || 'tool',
    detail: title,
    status,
  };
}

/** The permission option the user's decision picks, by ACP's option kinds. */
export function acpOption(
  options: unknown,
  decision: 'accept' | 'acceptForSession' | 'decline',
): string | null {
  if (!Array.isArray(options)) return null;
  const byKind = (kind: string) =>
    options.find((o): o is Json => isRecord(o) && o['kind'] === kind)?.['optionId'];
  const picked =
    decision === 'decline'
      ? byKind('reject_once')
      : decision === 'acceptForSession'
        ? (byKind('allow_always') ?? byKind('allow_once'))
        : byKind('allow_once');
  return typeof picked === 'string' ? picked : null;
}

interface Running {
  readonly handlers: AgentTurnHandlers;
  readonly steps: StepStream;
  /** The tool calls so far, merged update after update. */
  readonly calls: Map<string, Json>;
  text: string;
  /** The reasoning step being written, until something else comes. */
  thought: { id: string; text: string } | null;
  stepCount: number;
  stopped: boolean;
}

/** Read anew: a turn is stopped from outside while it waits. */
const stoppedNow = (turn: Running): boolean => turn.stopped;

export function createAcpAgentFactory(config: AcpAgentConfig): AgentFactory {
  return async ({ instructions, resume }): Promise<AgentSession> => {
    let current: Running | undefined;
    let model = config.model ?? '';
    /** The model the user chose during the chat, set before the next turn. */
    let nextModel: string | undefined;
    const client: JsonRpcClient = await startJsonRpc({
      executable: config.executable,
      args: config.args,
      name: `${config.provider} ACP`,
      jsonrpc: true,
      cwd: config.cwd,
      env: withoutApiKeys(config.env ?? process.env),
      onNotification(method, params) {
        if (method === 'session/update' && isRecord(params) && isRecord(params['update'])) {
          onUpdate(params['update']);
        }
      },
      onServerRequest(method, params) {
        if (method === 'session/request_permission' && isRecord(params)) {
          return permission(params);
        }
        return Promise.reject(new Error(`Method not supported: ${method}`));
      },
    });

    function onUpdate(update: Json): void {
      const turn = current;
      if (!turn) return; // the history `session/load` replays, or nothing running
      const kind = update['sessionUpdate'];
      const content = isRecord(update['content']) ? update['content'] : {};
      if (kind === 'agent_thought_chunk') {
        const started = turn.thought === null;
        turn.thought ??= { id: `r-${String(++turn.stepCount)}`, text: '' };
        turn.thought.text += text(content['text']);
        turn.steps.put(
          { kind: 'reasoning', id: turn.thought.id, text: turn.thought.text },
          started,
        );
        return;
      }
      if (turn.thought) {
        // Something else came: the reasoning is whole, sent at once.
        turn.steps.put({ kind: 'reasoning', id: turn.thought.id, text: turn.thought.text }, true);
        turn.thought = null;
      }
      if (kind === 'agent_message_chunk') {
        const chunk = text(content['text']);
        turn.text += chunk;
        if (chunk) turn.handlers.onText(chunk);
      } else if (kind === 'tool_call' || kind === 'tool_call_update') {
        const id = text(update['toolCallId']);
        const call = { ...turn.calls.get(id), ...update };
        turn.calls.set(id, call);
        const step = acpToolStep(call);
        // At once when it starts or ends; its output in between, at most every 250 ms.
        turn.steps.put(step, kind === 'tool_call' || step.status !== 'running');
      } else if (kind === 'plan' && Array.isArray(update['entries'])) {
        turn.steps.put(
          {
            kind: 'plan',
            id: 'plan',
            explanation: '',
            steps: update['entries'].filter(isRecord).map((entry) => ({
              step: text(entry['content']),
              status:
                entry['status'] === 'completed'
                  ? 'completed'
                  : entry['status'] === 'in_progress'
                    ? 'inProgress'
                    : 'pending',
            })),
          },
          true,
        );
      }
    }

    async function permission(params: Json): Promise<Json> {
      const turn = current;
      const call = isRecord(params['toolCall']) ? params['toolCall'] : {};
      const picked = (optionId: string | null): Json => ({
        outcome: optionId ? { outcome: 'selected', optionId } : { outcome: 'cancelled' },
      });
      if (!turn || turn.stopped) return picked(null);
      if (config.readOnly) return picked(acpOption(params['options'], 'decline'));
      const decision = await turn.handlers.onApprovalRequest({
        kind: text(call['kind']) || 'tool',
        summary: text(call['title']) || text(call['name']) || 'tool',
      });
      // Stopped while the user was deciding: the request is cancelled.
      return picked(stoppedNow(turn) ? null : acpOption(params['options'], decision));
    }

    let sessionId: string;
    let fresh: boolean;
    try {
      await client.request('initialize', {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: 'only-one-chat', version: '0.0.0' },
      });
      if (resume) {
        await client.request('session/load', {
          sessionId: resume,
          cwd: config.cwd,
          mcpServers: [],
        });
        sessionId = resume;
        fresh = false;
      } else {
        const created = await client.request('session/new', { cwd: config.cwd, mcpServers: [] });
        sessionId = isRecord(created) ? text(created['sessionId']) : '';
        if (!sessionId) throw new Error(`${config.provider}: session/new gave no session id`);
        fresh = true;
        if (!model && isRecord(created) && isRecord(created['models'])) {
          model = text(created['models']['currentModelId']);
        }
      }
      if (config.model) await client.request('session/set_model', { sessionId, modelId: model });
      if (config.mode) {
        await client.request('session/set_mode', { sessionId, modeId: config.mode });
      }
    } catch (error) {
      await client.close();
      throw error;
    }

    const identity = (): AgentIdentity => ({
      provider: config.provider,
      model,
      effort: null,
      sessionId,
    });

    function runTurn(prompt: string, handlers: AgentTurnHandlers): AgentTurn {
      const startedAt = Date.now();
      const turn: Running = {
        handlers,
        steps: new StepStream((step) => {
          handlers.onStep?.(step);
        }),
        calls: new Map(),
        text: '',
        thought: null,
        stepCount: 0,
        stopped: false,
      };
      current = turn;
      // The role's instructions open a new session: ACP has no system prompt of its own.
      const first = fresh ? `${instructions}\n\n---\n\n${prompt}` : prompt;
      fresh = false;
      const switched = nextModel;
      nextModel = undefined;
      const done = (
        switched === undefined
          ? Promise.resolve()
          : client.request('session/set_model', { sessionId, modelId: switched }).then(() => {
              model = switched;
            })
      )
        .then(() =>
          client.request(
            'session/prompt',
            { sessionId, prompt: [{ type: 'text', text: first }] },
            { timeoutMs: NO_TIMEOUT },
          ),
        )
        .then((result) => {
          const tokens = isRecord(result) ? acpTokens(result['usage']) : null;
          const usage: TurnUsage = {
            byModel: tokens ? { [model || config.provider]: tokens } : {},
            costUsd: null,
            durationMs: Date.now() - startedAt,
          };
          return { text: turn.text, identity: identity(), usage };
        })
        .finally(() => {
          turn.steps.flush();
          if (current === turn) current = undefined;
        });
      return {
        done,
        async stop() {
          turn.stopped = true;
          client.notify('session/cancel', { sessionId });
          await done.catch(() => undefined);
        },
      };
    }

    return {
      name: `${config.provider} (${model})`,
      id: config.provider.toLowerCase(),
      runTurn,
      setModel(next) {
        nextModel = next;
      },
      close: () => client.close(),
    };
  };
}
