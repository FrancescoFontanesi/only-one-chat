// An agent spoken to over the Agent Client Protocol (ADR 0023): one JSON-RPC
// 2.0 object per line on the stdio of a CLI's ACP server (Antigravity's
// `agy acp`; any other ACP agent the same way). One process per session; the
// session continues across turns and is reopened with `session/load`.
//
// The client offers no file system and no terminal: the agent works with its
// own tools, and asks with `session/request_permission` what its mode does
// not allow by itself. A read-only role declines every such request unasked,
// except the calls to the handoff tools of the MCP server `ooc` (ADR 0035).

import { startJsonRpc, type JsonRpcClient } from '../codex/app-server.js';
import { longPath, withoutApiKeys } from '../environment.js';
import { StepStream, tail } from '../steps.js';
import {
  HANDOFF_SERVER_NAME,
  handoffEnv,
  type AgentFactory,
  type AgentIdentity,
  type AgentSession,
  type AgentStepStatus,
  type AgentTurn,
  type AgentTurnHandlers,
  type AgentTurnStep,
  type HandoffCall,
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
      evidence: 'title',
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

/**
 * The permission option the user's decision picks, by ACP's option kinds.
 * Never `allow_always` (ADR 0050): how long the agent keeps it is its own
 * choice, so "for the session" is not offered and counts as once.
 */
export function acpOption(
  options: unknown,
  decision: 'accept' | 'acceptForSession' | 'decline',
): string | null {
  if (!Array.isArray(options)) return null;
  const byKind = (kind: string) =>
    options.find((o): o is Json => isRecord(o) && o['kind'] === kind)?.['optionId'];
  const picked = decision === 'decline' ? byKind('reject_once') : byKind('allow_once');
  return typeof picked === 'string' ? picked : null;
}

/** The title Antigravity gives a call to a tool of the MCP server `ooc`: "Run mcp_ooc_<tool>". */
const HANDOFF_TITLE = new RegExp(`^Run mcp_${HANDOFF_SERVER_NAME}_([A-Za-z0-9_-]+)$`);

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
  /** Requests declined unasked since the last prompt (a read-only role). */
  refused: number;
}

/**
 * Antigravity ends its turn, with no answer, when a command is refused (live,
 * 2026-11-18): in a read-only role the work goes on, told why, at most this often.
 */
const REFUSED_CONTINUATIONS = 2;
export const REFUSED_NOTICE =
  'A command you ran was refused: this session is read-only and cannot run commands. ' +
  'Continue the same work with your file reading and search tools.';

/** Read anew: a turn is stopped from outside while it waits. */
const stoppedNow = (turn: Running): boolean => turn.stopped;

export function createAcpAgentFactory(config: AcpAgentConfig): AgentFactory {
  return async ({ instructions, resume, handoff }): Promise<AgentSession> => {
    const handoffNames = new Set(handoff?.tools.map((tool) => tool.name));
    /** The handoff tool a tool call's title names, if it is one of ours. */
    const handoffTool = (title: unknown): string | undefined => {
      const name = HANDOFF_TITLE.exec(text(title))?.[1];
      return name !== undefined && handoffNames.has(name) ? name : undefined;
    };
    const mcpServers = handoff
      ? [
          {
            name: HANDOFF_SERVER_NAME,
            command: handoff.server.command,
            args: [...handoff.server.args],
            env: Object.entries(handoffEnv(handoff)).map(([name, value]) => ({ name, value })),
          },
        ]
      : [];
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
      // No effects, nobody to ask: allowed, also in a read-only role.
      if (handoffTool(call['title']) !== undefined)
        return picked(acpOption(params['options'], 'accept'));
      if (config.readOnly) {
        turn.refused++;
        return picked(acpOption(params['options'], 'decline'));
      }
      const decision = await turn.handlers.onApprovalRequest({
        kind: text(call['kind']) || 'tool',
        summary: text(call['title']) || text(call['name']) || 'tool',
        sessionAllowed: false,
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
          cwd: longPath(config.cwd),
          mcpServers,
        });
        sessionId = resume;
        fresh = false;
      } else {
        const created = await client.request('session/new', {
          cwd: longPath(config.cwd),
          mcpServers,
        });
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
        refused: 0,
      };
      const ask = (body: string) =>
        client.request(
          'session/prompt',
          { sessionId, prompt: [{ type: 'text', text: body }] },
          { timeoutMs: NO_TIMEOUT },
        );
      const handoffs = (): HandoffCall[] =>
        // The last update of each call carries its input; first appearance orders them.
        [...turn.calls.values()].flatMap((call) => {
          const tool = handoffTool(call['title']);
          return tool === undefined ? [] : [{ tool, arguments: call['rawInput'] }];
        });
      /** Ended by a refused command, with nothing to give: the work is not over. */
      const cutShort = (result: unknown): boolean =>
        !turn.stopped &&
        turn.refused > 0 &&
        isRecord(result) &&
        result['stopReason'] === 'end_turn' &&
        turn.text.trim() === '' &&
        handoffs().length === 0;
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
        .then(async () => {
          let result = await ask(first);
          const spent: unknown[] = [result];
          for (let again = 0; again < REFUSED_CONTINUATIONS && cutShort(result); again++) {
            turn.refused = 0;
            result = await ask(REFUSED_NOTICE);
            spent.push(result);
          }
          return { result, spent };
        })
        .then(({ result, spent }) => {
          // A turn that ends with no text for any reason but its own end is an error, not an empty answer.
          const stopReason = isRecord(result) ? text(result['stopReason']) : '';
          if (
            turn.text.trim() === '' &&
            stopReason !== '' &&
            stopReason !== 'end_turn' &&
            stopReason !== 'cancelled'
          ) {
            throw new Error(`${config.provider}: the turn ended without an answer (${stopReason})`);
          }
          const tokens = spent
            .map((each) => (isRecord(each) ? acpTokens(each['usage']) : null))
            .reduce<TokenUsage | null>(
              (sum, each) =>
                each === null
                  ? sum
                  : sum === null
                    ? each
                    : {
                        input: sum.input + each.input,
                        cachedInput: sum.cachedInput + each.cachedInput,
                        cacheWrite: sum.cacheWrite + each.cacheWrite,
                        output: sum.output + each.output,
                        reasoning: sum.reasoning + each.reasoning,
                      },
              null,
            );
          const usage: TurnUsage = {
            byModel: tokens ? { [model || config.provider]: tokens } : {},
            costUsd: null,
            durationMs: Date.now() - startedAt,
          };
          const calls = handoffs();
          return {
            text: turn.text,
            identity: identity(),
            usage,
            ...(calls.length > 0 ? { handoffs: calls } : {}),
          };
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
