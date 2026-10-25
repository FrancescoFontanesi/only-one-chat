// Claude Code as an agent session for the runtime: each runtime turn is one
// headless `claude -p` turn (src/claude/turn.ts); later turns resume the same
// Claude session, so the worker keeps its context across exchanges.

import type { AgentFactory, AgentSession, AgentTurn, AgentTurnHandlers } from '../agent.js';
import { startClaudeTurn, type ClaudeTurn, type ClaudeTurnOptions } from './turn.js';

export type ClaudeAgentConfig = Omit<
  ClaudeTurnOptions,
  'prompt' | 'appendSystemPrompt' | 'resumeSessionId' | 'onEvent'
>;

export function createClaudeAgentFactory(config: ClaudeAgentConfig): AgentFactory {
  return ({ instructions }): Promise<AgentSession> => {
    let sessionId: string | undefined;
    let running: ClaudeTurn | undefined;

    function runTurn(prompt: string, handlers: AgentTurnHandlers): AgentTurn {
      const turn = startClaudeTurn({
        ...config,
        prompt,
        appendSystemPrompt: instructions,
        ...(sessionId ? { resumeSessionId: sessionId } : {}),
        onEvent(event) {
          if (event.type === 'text') handlers.onText(event.text);
          else if (event.type === 'tool_use') {
            handlers.onActivity?.({
              kind: 'tool',
              detail: `${event.name} ${JSON.stringify(event.input)}`,
            });
          } else if (event.type === 'init') {
            handlers.onActivity?.({
              kind: 'session',
              detail: `${event.model} (${event.sessionId})`,
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
        if (result.isError) throw new Error(`Claude turn failed: ${result.text}`);
        return { text: result.text };
      });
      void done
        .finally(() => {
          if (running === turn) running = undefined;
        })
        .catch(() => undefined);
      return { done, stop: () => turn.stop() };
    }

    return Promise.resolve({
      name: `Claude (${config.model ?? 'default model'})`,
      runTurn,
      close: async () => {
        await running?.stop();
      },
    });
  };
}
