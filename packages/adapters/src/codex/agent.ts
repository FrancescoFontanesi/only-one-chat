// Codex as an agent session for the runtime: one app-server connection and one
// thread per session, read-only. Each turn streams `item/agentMessage/delta`
// and ends with `turn/completed`; stop() sends `turn/interrupt`. Approval
// requests from the server go to the runtime, which declines them in this
// iteration; the protocol answer is built here. Shapes: codex-rs
// app-server-protocol v2 (thread.rs, turn.rs, item.rs), docs/codex-app-server.md.

import type { AgentFactory, AgentSession, AgentTurn, AgentTurnHandlers } from '../agent.js';
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

interface RunningTurn {
  readonly handlers: AgentTurnHandlers;
  turnId?: string;
  readonly messages: string[];
  settle(outcome: { text: string } | Error): void;
}

export function createCodexAgentFactory(config: CodexAgentConfig): AgentFactory {
  return async ({ instructions }): Promise<AgentSession> => {
    const { cwd, model, effort, interruptTimeoutMs = 10_000, ...sessionOptions } = config;
    let current: RunningTurn | undefined;
    let threadId = '';

    const session = await connectCodex({
      ...sessionOptions,
      clientInfo: { name: 'only-one-chat', title: 'Only One Chat', version: '0.0.0' },
      onNotification(method, params) {
        const turn = current;
        if (!turn || !isRecord(params) || params['threadId'] !== threadId) return;
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
          }
        } else if (method === 'error' && isRecord(params['error'])) {
          turn.handlers.onActivity?.({ kind: 'error', detail: String(params['error']['message']) });
        } else if (method === 'turn/completed' && isRecord(params['turn'])) {
          const completed = params['turn'];
          if (turn.turnId !== undefined && completed['id'] !== turn.turnId) return;
          const status = completed['status'];
          if (status === 'completed') turn.settle({ text: turn.messages.join('\n\n') });
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
      });
      const thread = isRecord(started) && isRecord(started['thread']) ? started['thread'] : {};
      threadId = typeof thread['id'] === 'string' ? thread['id'] : '';
      if (threadId === '') throw new Error('thread/start returned no thread id');
    } catch (error) {
      await session.close();
      throw error;
    }
    const resolvedModel = model ?? 'default model';

    function runTurn(prompt: string, handlers: AgentTurnHandlers): AgentTurn {
      if (current) throw new Error('A Codex turn is already running in this session');
      let settle!: (outcome: { text: string } | Error) => void;
      const done = new Promise<{ text: string }>((resolve, reject) => {
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
      runTurn,
      close: () => session.close(),
    };
  };
}
