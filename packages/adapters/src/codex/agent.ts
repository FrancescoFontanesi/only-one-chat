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
  AgentSkillRef,
  AgentUserQuestion,
} from '../agent.js';
import { CodexAuthError, isUsable } from './auth.js';
import {
  NO_TOKENS,
  addTokens,
  codexQuota,
  codexTokens,
  subtractTokens,
  type ContextUsage,
  type QuotaSnapshot,
  type TokenUsage,
} from '../usage.js';
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
  /**
   * Sandbox mode only (ADR 0008): the thread may write in `cwd`
   * (`workspace-write`, no network). On Windows the thread also asks for
   * Codex's unelevated sandbox, which needs no setup; without it Codex runs
   * commands with no OS sandbox at all. Default: read-only.
   */
  readonly writable?: boolean;
  /**
   * Isolated runs (benchmarks): the thread runs without the hooks of the
   * user's profile (`features.hooks = false`, per thread only). Graft's hooks
   * write their cache into the working directory and add context to each turn.
   * Default: the user's hooks run.
   */
  readonly withoutUserHooks?: boolean;
  /**
   * When Codex asks before acting: `on-request` (default) only to leave the
   * sandbox; `untrusted` before any command it does not know to be safe;
   * `never` never asks: what the sandbox does not allow fails (ADR 0018: the
   * leader, read-only).
   */
  readonly approvalPolicy?: 'on-request' | 'untrusted' | 'never';
  /**
   * The model may ask the user questions in a normal turn (ADR 0019: the
   * leader), through `item/tool/requestUserInput`, which the turn's
   * onQuestion answers. Default: it cannot.
   */
  readonly questions?: boolean;
  /**
   * Threads Codex keeps on disk, in its own history, so a reopened chat can
   * resume them (R5); default ephemeral (benchmarks, checks).
   */
  readonly persistent?: boolean;
}

/** Per-thread overrides for a writable thread; see CodexAgentConfig.writable. */
export function writableThreadConfig(platform: NodeJS.Platform): Record<string, unknown> {
  return platform === 'win32' ? { 'windows.sandbox': 'unelevated' } : {};
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
    [`${v2}.multi_agent_mode_hint_text`]: policy.proactive
      ? 'Crea sotto-agenti per leggere ed esplorare il codice, così il tuo contesto resta piccolo; ' +
        'non per modificarlo. Ti restituiscono una sintesi, non i file interi.'
      : 'Crea sotto-agenti solo se l’utente lo chiede esplicitamente; altrimenti lavora da solo. ' +
        'Nessuna istruzione precedente che chiede di delegare in modo proattivo vale più.',
    [`${v2}.root_agent_usage_hint_text`]: [
      'Sei `/root`, l’agente principale di questa sessione Codex.',
      'Con `spawn_agent` crei un sotto-agente interno, con `followup_task` gli dai un nuovo compito',
      'e con `send_message` gli mandi un messaggio; i suoi risultati ti arrivano come messaggi con',
      'Message Type, Task name, Sender e Payload. I sotto-agenti sono istanze interne di Codex.',
      'Passa sempre `fork_turns: "none"` a `spawn_agent` e scrivi nel compito tutto il contesto',
      'che serve: questa sessione non conserva la cronologia su disco, quindi un sotto-agente non',
      'può ereditarla (con `all`, il valore predefinito, la creazione fallisce).',
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

/**
 * Names a Codex sub-agent must never take: agents and models external to Codex.
 * Matched as whole words by the runtime (checkSubagent).
 */
export const CODEX_SUBAGENT_FORBIDDEN_NAMES = ['claude', 'haiku', 'opus', 'sonnet', 'gemini'];

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/**
 * A turn's input (ADR 0019): a skill the user named goes first, as Codex's own
 * skill input with its file; without a file it is named in the text, as `$name`.
 */
export function codexInput(prompt: string, skill?: AgentSkillRef): Record<string, unknown>[] {
  if (!skill) return [{ type: 'text', text: prompt }];
  if (!skill.path) return [{ type: 'text', text: `$${skill.name} ${prompt}` }];
  return [
    { type: 'skill', name: skill.name, path: skill.path },
    { type: 'text', text: prompt },
  ];
}

/** The questions of an `item/tool/requestUserInput` request, as the runtime takes them. */
export function codexQuestions(params: unknown): AgentUserQuestion[] {
  const list = isRecord(params) && Array.isArray(params['questions']) ? params['questions'] : [];
  return list.flatMap((q): AgentUserQuestion[] => {
    if (!isRecord(q) || typeof q['id'] !== 'string' || typeof q['question'] !== 'string') {
      return [];
    }
    const options = Array.isArray(q['options'])
      ? q['options'].flatMap((o) =>
          isRecord(o) && typeof o['label'] === 'string'
            ? [{ label: o['label'], description: stringOrNull(o['description']) ?? '' }]
            : [],
        )
      : null;
    return [
      {
        id: q['id'],
        header: stringOrNull(q['header']) ?? '',
        question: q['question'],
        options: options && options.length > 0 ? options : null,
        other: q['isOther'] === true,
        secret: q['isSecret'] === true,
      },
    ];
  });
}

/** The user's answers as Codex takes them: `{ answers: { [id]: { answers: [...] } } }`. */
export function codexAnswers(answers: Readonly<Record<string, readonly string[]>>): unknown {
  return {
    answers: Object.fromEntries(
      Object.entries(answers).map(([id, values]) => [id, { answers: [...values] }]),
    ),
  };
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

/**
 * The answer to an approval request. Commands and file changes take the
 * user's decision (Codex: `accept`, `acceptForSession`, `decline`); other
 * requests (permission grants, MCP elicitations) are always declined here.
 */
export function approvalResponse(
  method: string,
  decision: 'accept' | 'acceptForSession' | 'decline',
): unknown {
  if (
    decision !== 'decline' &&
    (method === 'item/commandExecution/requestApproval' ||
      method === 'item/fileChange/requestApproval')
  ) {
    return { decision };
  }
  return declineResponse(method);
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

type TurnOutcome =
  | {
      text: string;
      identity: AgentIdentity;
      /** Absent for the first turn of a resumed thread: its own usage is unknown. */
      usage?: { byModel: Record<string, TokenUsage>; costUsd: null; durationMs: number };
      quota: QuotaSnapshot | null;
      context: ContextUsage | null;
    }
  | Error;

interface RunningTurn {
  readonly handlers: AgentTurnHandlers;
  turnId?: string;
  readonly messages: string[];
  readonly startedAt: number;
  /** The thread's cumulative tokens when the turn started. */
  readonly baseline: TokenUsage;
  quota: QuotaSnapshot | null;
  settle(outcome: TurnOutcome): void;
}

/** A sub-agent seen during the current turn, by its thread id. */
interface Child {
  turnId?: string;
  finished: boolean;
  /** Model reported when it started, for its token usage. */
  model: string;
}

const FINISHED: Readonly<Record<string, 'completed' | 'interrupted' | 'failed'>> = {
  completed: 'completed',
  interrupted: 'interrupted',
  failed: 'failed',
};

export function createCodexAgentFactory(config: CodexAgentConfig): AgentFactory {
  return async ({ instructions, subagents, resume }): Promise<AgentSession> => {
    const {
      cwd,
      model,
      effort,
      interruptTimeoutMs = 10_000,
      writable = false,
      withoutUserHooks = false,
      approvalPolicy = 'on-request',
      persistent = false,
      questions = false,
      ...sessionOptions
    } = config;
    let current: RunningTurn | undefined;
    let threadId = '';
    /** Set when the thread was resumed; see the first completed turn. */
    let baselineUnknown = false;
    /** The main thread's context, from its latest token usage notification. */
    let mainContext: ContextUsage | null = null;
    let identity: AgentIdentity = { provider: 'Codex', model: '', effort: null, sessionId: '' };
    const children = new Map<string, Child>();
    /** Latest cumulative tokens per thread (thread/tokenUsage/updated). */
    const totals = new Map<string, TokenUsage>();

    /** This turn's tokens by model: the parent's growth plus each sub-agent's thread. */
    function turnUsage(turn: RunningTurn): Record<string, TokenUsage> {
      const byModel: Record<string, TokenUsage> = {};
      const add = (model: string, tokens: TokenUsage) => {
        byModel[model] = addTokens(byModel[model] ?? NO_TOKENS, tokens);
      };
      add(identity.model, subtractTokens(totals.get(threadId) ?? NO_TOKENS, turn.baseline));
      for (const [id, child] of children) add(child.model, totals.get(id) ?? NO_TOKENS);
      return byModel;
    }

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
        children.set(id, { finished: false, model: stringOrNull(item['model']) ?? 'unknown' });
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
        if (!isRecord(params)) return;
        // Usage and quota, kept whether or not a turn is running.
        if (method === 'thread/tokenUsage/updated' && typeof params['threadId'] === 'string') {
          const usage = params['tokenUsage'];
          totals.set(params['threadId'], codexTokens(isRecord(usage) ? usage['total'] : undefined));
          // The thread's latest request is its context; sub-agents have their own threads.
          if (params['threadId'] === threadId && isRecord(usage) && isRecord(usage['last'])) {
            const last = usage['last'];
            const window = usage['modelContextWindow'];
            mainContext = {
              used:
                typeof last['totalTokens'] === 'number'
                  ? last['totalTokens']
                  : (typeof last['inputTokens'] === 'number' ? last['inputTokens'] : 0) +
                    (typeof last['outputTokens'] === 'number' ? last['outputTokens'] : 0),
              window: typeof window === 'number' ? window : null,
            };
          }
        }
        const turn = current;
        if (!turn) return;
        if (method === 'account/rateLimits/updated') {
          turn.quota = codexQuota(params['rateLimits']) ?? turn.quota;
          return;
        }
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
          if (status === 'completed') {
            // A resumed thread's totals before this session are unknown: the
            // first turn's own usage cannot be told apart, so it is not reported.
            const ownUsageKnown = !baselineUnknown;
            baselineUnknown = false;
            turn.settle({
              text: turn.messages.join('\n\n'),
              identity,
              ...(ownUsageKnown
                ? {
                    usage: {
                      byModel: turnUsage(turn),
                      costUsd: null,
                      durationMs: Date.now() - turn.startedAt,
                    },
                  }
                : {}),
              quota: turn.quota,
              context: mainContext,
            });
          } else {
            const error = isRecord(completed['error']) ? String(completed['error']['message']) : '';
            turn.settle(new Error(`Codex turn ${String(status)}${error ? `: ${error}` : ''}`));
          }
        }
      },
      async onServerRequest(method, params) {
        if (method === 'item/tool/requestUserInput') {
          // Only a turn that can ask gets an answer; otherwise the request fails.
          const turnHandlers = current?.handlers;
          if (!turnHandlers?.onQuestion) {
            throw new Error(`${method} is not supported by this client`);
          }
          const answers = await turnHandlers.onQuestion(codexQuestions(params));
          if (answers === null) throw new Error('The user did not answer');
          return codexAnswers(answers);
        }
        const summary = summarize(method, params);
        // Without a turn there is nobody to ask: declined.
        const decision = current
          ? await current.handlers.onApprovalRequest({ kind: method, summary })
          : 'decline';
        return approvalResponse(method, decision);
      },
    });
    if (!isUsable(session.auth)) {
      const state = session.auth;
      await session.close();
      throw new CodexAuthError(state);
    }

    try {
      const threadConfig = {
        ...(subagents ? subagentThreadConfig(subagents) : {}),
        ...(writable ? writableThreadConfig(process.platform) : {}),
        ...(withoutUserHooks ? { 'features.hooks': false } : {}),
        ...(questions ? { 'features.default_mode_request_user_input': true } : {}),
      };
      const threadParams = {
        cwd,
        sandbox: writable ? 'workspace-write' : 'read-only',
        approvalPolicy,
        // Approvals go to us, never to Codex's own automatic reviewer.
        approvalsReviewer: 'user',
        developerInstructions: instructions,
        ...(model ? { model } : {}),
        ...(Object.keys(threadConfig).length > 0 ? { config: threadConfig } : {}),
      };
      // A reopened chat continues its thread, with the same rules; if Codex no
      // longer has it, a new thread starts.
      const resumed = resume
        ? await session
            .request('thread/resume', { threadId: resume, ...threadParams, excludeTurns: true })
            .catch(() => undefined)
        : undefined;
      const started =
        resumed ??
        (await session.request('thread/start', { ...threadParams, ephemeral: !persistent }));
      baselineUnknown = resumed !== undefined;
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
    /** The model and effort of the next turns; the user can change them during the chat. */
    let currentModel = model;
    let currentEffort = effort;

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

    function runTurn(
      prompt: string,
      handlers: AgentTurnHandlers,
      options?: { readonly skill?: AgentSkillRef },
    ): AgentTurn {
      if (current) throw new Error('A Codex turn is already running in this session');
      children.clear();
      let settle!: (outcome: TurnOutcome) => void;
      const done = new Promise<Exclude<TurnOutcome, Error>>((resolve, reject) => {
        settle = (outcome) => {
          if (current === turn) current = undefined;
          if (outcome instanceof Error) reject(outcome);
          else resolve(outcome);
        };
      });
      const turn: RunningTurn = {
        handlers,
        messages: [],
        startedAt: Date.now(),
        baseline: totals.get(threadId) ?? NO_TOKENS,
        quota: null,
        settle,
      };
      current = turn;
      session
        .request('turn/start', {
          threadId,
          input: codexInput(prompt, options?.skill),
          ...(currentModel ? { model: currentModel } : {}),
          ...(currentEffort ? { effort: currentEffort } : {}),
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
      get name() {
        return `Codex (${currentModel ?? 'default model'})`;
      },
      id: 'codex',
      runTurn,
      setEffort(next) {
        // turn/start takes the effort per turn: the thread stays the same.
        currentEffort = next;
        identity = { ...identity, effort: next };
      },
      setModel(next) {
        // turn/start takes the model per turn too.
        currentModel = next;
        identity = { ...identity, model: next };
      },
      close: () => session.close(),
    };
  };
}
