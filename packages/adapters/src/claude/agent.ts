// Claude Code as an agent session for the runtime: each runtime turn is one
// headless `claude -p` turn (src/claude/turn.ts); later turns resume the same
// Claude session, so the worker keeps its context across exchanges.
//
// Sub-agents (D13): an Agent tool call in the main conversation starts one,
// its messages carry the call's id as parent_tool_use_id (and the model that
// actually ran), and the call's tool_result ends it. They become sub-agent
// events for the runtime; stopping the turn ends the whole process tree, and
// with it every sub-agent.

import type { AgentFactory, AgentSession, AgentTurn, AgentTurnHandlers } from '../agent.js';
import {
  ClaudeError,
  SUBAGENT_TOOL,
  startClaudeTurn,
  type ClaudeTurn,
  type ClaudeTurnOptions,
} from './turn.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export type ClaudeAgentConfig = Omit<
  ClaudeTurnOptions,
  'prompt' | 'appendSystemPrompt' | 'resumeSessionId' | 'onEvent' | 'subagents'
>;

export function createClaudeAgentFactory(config: ClaudeAgentConfig): AgentFactory {
  return ({ instructions, subagents }): Promise<AgentSession> => {
    let sessionId: string | undefined;
    let running: ClaudeTurn | undefined;

    function runTurn(prompt: string, handlers: AgentTurnHandlers): AgentTurn {
      /** Sub-agents of this turn, by Agent tool call id. */
      const children = new Map<string, { identified: boolean }>();
      /** The first message of a sub-agent tells which model actually ran it. */
      function identify(id: string, model: string | null): void {
        const subagent = children.get(id);
        if (!subagent || subagent.identified) return;
        subagent.identified = true;
        handlers.onSubagent?.({ type: 'identified', id, model, effort: null });
      }
      const turn = startClaudeTurn({
        ...config,
        prompt,
        appendSystemPrompt: subagents ? `${instructions}\n\n${subagents.rules}` : instructions,
        ...(subagents ? { subagents: { model: subagents.model, effort: subagents.effort } } : {}),
        ...(sessionId ? { resumeSessionId: sessionId } : {}),
        onEvent(event) {
          if (event.type === 'text' && event.parentToolUseId !== null) {
            identify(event.parentToolUseId, event.model);
            handlers.onSubagent?.({ type: 'text', id: event.parentToolUseId, text: event.text });
          } else if (event.type === 'text') handlers.onText(event.text);
          else if (event.type === 'tool_use' && event.parentToolUseId !== null) {
            identify(event.parentToolUseId, event.model);
            handlers.onSubagent?.({
              type: 'activity',
              id: event.parentToolUseId,
              kind: 'tool',
              detail: `${event.name} ${JSON.stringify(event.input)}`,
            });
          } else if (event.type === 'tool_use' && event.name === SUBAGENT_TOOL) {
            const input = isRecord(event.input) ? event.input : {};
            const name = input['subagent_type'] ?? input['description'];
            children.set(event.id, { identified: false });
            handlers.onSubagent?.({
              type: 'started',
              id: event.id,
              name: typeof name === 'string' ? name : SUBAGENT_TOOL,
              // Requested, if anything: the model that runs comes with its messages.
              model: typeof input['model'] === 'string' ? input['model'] : null,
              effort: null,
            });
          } else if (event.type === 'tool_use') {
            handlers.onActivity?.({
              kind: 'tool',
              detail: `${event.name} ${JSON.stringify(event.input)}`,
            });
          } else if (event.type === 'tool_result' && children.has(event.toolUseId)) {
            children.delete(event.toolUseId);
            handlers.onSubagent?.({
              type: 'finished',
              id: event.toolUseId,
              status: event.isError ? 'failed' : 'completed',
            });
          } else if (event.type === 'init') {
            handlers.onActivity?.({
              kind: 'session',
              detail: `${event.model} (${event.sessionId}), permission mode ${event.permissionMode}`,
            });
          }
        },
      });
      running = turn;
      const done = turn.done.then((result) => {
        sessionId = result.sessionId;
        for (const denial of result.permissionDenials) {
          handlers.onActivity?.({ kind: 'permission_denied', detail: JSON.stringify(denial) });
        }
        if (result.isError && result.apiErrorStatus === 429) {
          throw new ClaudeError(
            'usage_limit',
            `Claude usage limit reached: ${result.text}. Not retried: try again after the reset.`,
          );
        }
        if (result.isError) throw new Error(`Claude turn failed: ${result.text}`);
        return {
          text: result.text,
          identity: {
            provider: 'Claude Code',
            model: result.model,
            effort: config.effort ?? null,
            sessionId: result.sessionId,
          },
        };
      });
      void done
        .finally(() => {
          if (running === turn) running = undefined;
        })
        .catch(() => undefined);
      return {
        done,
        async stop() {
          await turn.stop();
          // The process tree is gone, and every sub-agent with it.
          for (const id of children.keys()) {
            handlers.onSubagent?.({ type: 'finished', id, status: 'interrupted' });
          }
          children.clear();
        },
      };
    }

    return Promise.resolve({
      name: `Claude (${config.model ?? 'default model'})`,
      id: 'claude',
      runTurn,
      close: async () => {
        await running?.stop();
      },
    });
  };
}
