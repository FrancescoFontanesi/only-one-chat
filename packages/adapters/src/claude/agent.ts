// Claude Code as an agent session for the runtime: each runtime turn is one
// headless `claude -p` turn (src/claude/turn.ts); later turns resume the same
// Claude session, so the worker keeps its context across exchanges.
//
// Sub-agents (D13): an Agent tool call in the main conversation starts one,
// its messages carry the call's id as parent_tool_use_id (and the model that
// actually ran), and the call's tool_result ends it. They become sub-agent
// events for the runtime; stopping the turn ends the whole process tree, and
// with it every sub-agent.

import type {
  AgentFactory,
  AgentSession,
  AgentSkillRef,
  AgentTurn,
  AgentTurnHandlers,
  AgentTurnStep,
} from '../agent.js';
import { tail } from '../steps.js';
import {
  AUTO_PERMISSION_MODE,
  ClaudeError,
  SUBAGENT_TOOL,
  startClaudeTurn,
  type ClaudeTurn,
  type ClaudeTurnOptions,
} from './turn.js';
import { NO_TOKENS, subtractTokens, type TokenUsage } from '../usage.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export type ClaudeAgentConfig = Omit<
  ClaudeTurnOptions,
  'prompt' | 'appendSystemPrompt' | 'resumeSessionId' | 'onEvent' | 'subagents'
>;

const lines = (text: string) => (text === '' ? [] : text.split('\n'));

/**
 * The step of a Claude tool call (ADR 0019): Bash a command, Edit and Write a
 * file change with its diff, anything else a tool with its main argument.
 */
export function claudeToolStep(id: string, name: string, input: unknown): AgentTurnStep {
  const args =
    typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {};
  const text = (key: string) => (typeof args[key] === 'string' ? args[key] : '');
  if (name === 'Bash') {
    return {
      kind: 'command',
      id,
      command: text('command'),
      status: 'running',
      exitCode: null,
      durationMs: null,
      output: '',
    };
  }
  if (name === 'Edit' || name === 'Write') {
    const before = name === 'Edit' ? lines(text('old_string')) : [];
    const after = lines(name === 'Edit' ? text('new_string') : text('content'));
    const diff = [...before.map((l) => `-${l}`), ...after.map((l) => `+${l}`)].join('\n');
    return {
      kind: 'file',
      id,
      status: 'running',
      changes: [
        {
          path: text('file_path'),
          change: 'update',
          added: after.length,
          removed: before.length,
          diff: diff.length > 20_000 ? `${diff.slice(0, 20_000)}\n…` : diff,
        },
      ],
    };
  }
  const detail =
    text('file_path') ||
    text('pattern') ||
    text('skill') ||
    text('query') ||
    text('url') ||
    JSON.stringify(input ?? null).slice(0, 240);
  return { kind: 'tool', id, name, detail, status: 'running' };
}

/** A tool call's step once its result is back. */
function endStep(step: AgentTurnStep, failed: boolean, output: string): AgentTurnStep {
  const status = failed ? 'failed' : 'done';
  if (step.kind === 'command') return { ...step, status, output: tail(output) };
  if (step.kind === 'file' || step.kind === 'tool') return { ...step, status };
  return step;
}

/**
 * What Claude receives as the user's text (ADR 0019). In -p a leading `/` runs
 * one of Claude Code's own commands (`/clear` resets the conversation), so a
 * text that starts with one gets a space before it and stays text. A skill the
 * user named is invoked as `/name`, then the text.
 */
export function claudePrompt(prompt: string, skill?: AgentSkillRef): string {
  if (skill) return prompt.trim() === '' ? `/${skill.name}` : `/${skill.name} ${prompt}`;
  return prompt.startsWith('/') ? ` ${prompt}` : prompt;
}

export function createClaudeAgentFactory(config: ClaudeAgentConfig): AgentFactory {
  return ({ instructions, subagents, resume }): Promise<AgentSession> => {
    let sessionId: string | undefined = resume;
    let running: ClaudeTurn | undefined;
    // A resumed turn reports the whole session's usage and cost so far, not
    // its own: each turn is the difference from the previous one.
    let sessionUsage: Readonly<Record<string, TokenUsage>> = {};
    let sessionCost = 0;
    /**
     * A session reopened from an earlier chat: its totals before this process
     * are unknown, so the first turn's own usage cannot be told apart and is
     * not reported; the turns after it are.
     */
    let baselineUnknown = resume !== undefined;
    /**
     * The effort of the next turns; the user can change it during the chat.
     * CLAUDE_CODE_EFFORT_LEVEL also sets the main session's effort, so the
     * sub-agents' effort follows it (docs/subagents.md).
     */
    let effort = config.effort;
    /** The model of the next turns: each turn is its own process with --model. */
    let model = config.model;
    /** Claude Code's auto mode fell back to another mode, and the thread was told. */
    let autoUnavailableSaid = false;

    function runTurn(
      prompt: string,
      handlers: AgentTurnHandlers,
      options?: { readonly skill?: AgentSkillRef },
    ): AgentTurn {
      const startedAt = Date.now();
      /** Sub-agents of this turn, by Agent tool call id. */
      const children = new Map<string, { identified: boolean }>();
      /** The tool calls shown as steps, waiting for their result (ADR 0019). */
      const toolSteps = new Map<string, AgentTurnStep>();
      let stepCount = 0;
      /** The first message of a sub-agent tells which model actually ran it. */
      function identify(id: string, model: string | null): void {
        const subagent = children.get(id);
        if (!subagent || subagent.identified) return;
        subagent.identified = true;
        handlers.onSubagent?.({ type: 'identified', id, model, effort: null });
      }
      const turn = startClaudeTurn({
        ...config,
        ...(model ? { model } : {}),
        ...(effort ? { effort } : {}),
        prompt: claudePrompt(prompt, options?.skill),
        appendSystemPrompt: subagents ? `${instructions}\n\n${subagents.rules}` : instructions,
        ...(subagents
          ? { subagents: { model: subagents.model, effort: effort ?? subagents.effort } }
          : {}),
        ...(sessionId ? { resumeSessionId: sessionId } : {}),
        onEvent(event) {
          if (event.type === 'text' && event.parentToolUseId !== null) {
            identify(event.parentToolUseId, event.model);
            handlers.onSubagent?.({ type: 'text', id: event.parentToolUseId, text: event.text });
          } else if (event.type === 'text' && event.withTools === true) {
            // Text before a tool call: an intermediate message, a step of the turn (ADR 0019).
            handlers.onStep?.({
              kind: 'message',
              id: `m-${String(++stepCount)}`,
              text: event.text,
            });
          } else if (event.type === 'text') handlers.onText(event.text);
          else if (event.type === 'thinking' && event.parentToolUseId === null) {
            handlers.onStep?.({
              kind: 'reasoning',
              id: `r-${String(++stepCount)}`,
              text: event.text,
            });
          } else if (event.type === 'tool_use' && event.parentToolUseId !== null) {
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
            const step = claudeToolStep(event.id, event.name, event.input);
            toolSteps.set(event.id, step);
            handlers.onStep?.(step);
          } else if (event.type === 'tool_result' && toolSteps.has(event.toolUseId)) {
            const step = toolSteps.get(event.toolUseId);
            toolSteps.delete(event.toolUseId);
            if (step) handlers.onStep?.(endStep(step, event.isError, event.content ?? ''));
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
            if (
              config.sandbox?.auto === true &&
              event.permissionMode !== AUTO_PERMISSION_MODE &&
              !autoUnavailableSaid
            ) {
              // Said once per session: Claude Code turned its auto mode off by itself (ADR 0021).
              autoUnavailableSaid = true;
              handlers.onStep?.({
                kind: 'message',
                id: `m-${String(++stepCount)}`,
                text: `La modalità auto di Claude Code non è disponibile qui (piano, modello o impostazioni): Claude lavora in modalità ${event.permissionMode} e chiede per ciò che non è consentito.`,
              });
            }
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
        const byModel = Object.fromEntries(
          Object.entries(result.usage).map(([model, total]) => [
            model,
            subtractTokens(total, sessionUsage[model] ?? NO_TOKENS),
          ]),
        );
        const costUsd = result.costUsd === null ? null : result.costUsd - sessionCost;
        sessionUsage = result.usage;
        if (result.costUsd !== null) sessionCost = result.costUsd;
        const ownUsageKnown = !baselineUnknown;
        baselineUnknown = false;
        return {
          text: result.text,
          ...(ownUsageKnown
            ? { usage: { byModel, costUsd, durationMs: Date.now() - startedAt } }
            : {}),
          quota: result.quota,
          // Unlike usage, the context is the session's own size, known even after a resume.
          context: result.context,
          identity: {
            provider: 'Claude Code',
            model: result.model,
            effort: effort ?? null,
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
      get name() {
        return `Claude (${model ?? 'default model'})`;
      },
      id: 'claude',
      runTurn,
      setEffort(next) {
        // Each turn is its own process: the next one starts with --effort next.
        effort = next;
      },
      setModel(next) {
        model = next;
      },
      close: async () => {
        await running?.stop();
      },
    });
  };
}
