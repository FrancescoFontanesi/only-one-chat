// What the runtime needs from an agent, whatever the provider: a session with
// role instructions, turns that stream text, can be stopped, and route
// approval requests to the runtime. Adapters (packages/adapters) provide
// implementations; the runtime never imports them, so roles stay configuration.

/** An approval the agent asks for (a command, a file change, network, …). */
export interface ApprovalRequest {
  /** Protocol-level kind, e.g. `item/commandExecution/requestApproval`. */
  readonly kind: string;
  /** Short human-readable description for the thread. */
  readonly summary: string;
}

/**
 * `accept`: this request only; `acceptForSession`: also the same request again
 * in this session, as the CLI scopes it (Codex: the same command or files,
 * never a whole program); `decline`: refused, the agent goes on.
 */
export type ApprovalDecision = 'accept' | 'acceptForSession' | 'decline';

/**
 * What an agent reports about its own sub-agents (D13). `started` may come
 * without model or effort (Claude reports the model with the sub-agent's first
 * message, as `identified`); null means "not reported", not "default".
 */
export type SubagentEvent =
  | {
      readonly type: 'started';
      readonly id: string;
      readonly name: string;
      readonly model: string | null;
      readonly effort: string | null;
    }
  | {
      readonly type: 'identified';
      readonly id: string;
      readonly model: string | null;
      readonly effort: string | null;
    }
  | { readonly type: 'text'; readonly id: string; readonly text: string }
  | {
      readonly type: 'activity';
      readonly id: string;
      readonly kind: string;
      readonly detail: string;
    }
  | {
      readonly type: 'finished';
      readonly id: string;
      readonly status: 'completed' | 'interrupted' | 'failed';
    };

/**
 * A question the agent asks the user while it works (ADR 0019): the turn
 * waits for the answer. `options` null: a free answer only; `other`: a free
 * answer besides the choices; `secret`: never shown in clear nor kept.
 */
export interface AgentQuestion {
  readonly id: string;
  readonly header: string;
  readonly question: string;
  readonly options: readonly { readonly label: string; readonly description: string }[] | null;
  readonly other: boolean;
  readonly secret: boolean;
}

/** The user's answers by question id; null when the user did not answer. */
export type QuestionAnswers = Readonly<Record<string, readonly string[]>> | null;

/**
 * One step of a turn as it happens (ADR 0019), sent again whole on every
 * change and replaced by id: an intermediate message, the reasoning, a
 * command with its output, file changes, the turn's plan, another tool.
 */
export type StepStatus = 'running' | 'done' | 'failed';

export interface FileStepChange {
  readonly path: string;
  readonly change: 'add' | 'delete' | 'update';
  readonly added: number;
  readonly removed: number;
  /** Unified diff, cut to its first part when long. */
  readonly diff: string;
}

export type TurnStep =
  | { readonly kind: 'message'; readonly id: string; readonly text: string }
  /** The reasoning; `text` is its summary, empty when the CLI gives none. */
  | { readonly kind: 'reasoning'; readonly id: string; readonly text: string }
  | {
      readonly kind: 'command';
      readonly id: string;
      readonly command: string;
      readonly status: StepStatus;
      readonly exitCode: number | null;
      readonly durationMs: number | null;
      /** The last part of what it printed. */
      readonly output: string;
    }
  | {
      readonly kind: 'file';
      readonly id: string;
      readonly status: StepStatus;
      readonly changes: readonly FileStepChange[];
    }
  | {
      readonly kind: 'plan';
      readonly id: string;
      readonly explanation: string;
      readonly steps: readonly {
        readonly step: string;
        readonly status: 'pending' | 'inProgress' | 'completed';
      }[];
    }
  | {
      readonly kind: 'tool';
      readonly id: string;
      readonly name: string;
      readonly detail: string;
      readonly status: StepStatus;
    };

export interface AgentTurnHandlers {
  /** Text as it streams (deltas or whole messages, depending on the agent). */
  onText(text: string): void;
  /** The agent wants an approval; the runtime decides. */
  onApprovalRequest(request: ApprovalRequest): Promise<ApprovalDecision>;
  /** Anything else worth showing (tool use, rate limits, …). */
  onActivity?(activity: { readonly kind: string; readonly detail: string }): void;
  /** The agent's own sub-agents: visible, not approved (D13). */
  onSubagent?(event: SubagentEvent): void;
  /** A step of the turn as it happens (ADR 0019). */
  onStep?(step: TurnStep): void;
  /** The agent asks the user while the turn waits (ADR 0019). Absent: it cannot ask. */
  onQuestion?(questions: readonly AgentQuestion[]): Promise<QuestionAnswers>;
}

/**
 * Who actually answered, as the adapter observed it on the wire (not as the
 * model describes itself): the runtime writes the label shown in the thread.
 */
export interface AgentIdentity {
  /** Product and route, e.g. "Codex via Headroom persistent proxy", "Claude Code". */
  readonly provider: string;
  /** Model reported by the CLI for this session, e.g. "claude-haiku-5-5". */
  readonly model: string;
  /** Effort requested for the turn; null when the CLI default applies. */
  readonly effort: string | null;
  /** Thread or session id reported by the CLI. */
  readonly sessionId: string;
}

/** Tokens as the CLI counts them (not comparable across providers); `reasoning` ⊆ `output`. */
export interface TokenUsage {
  readonly input: number;
  readonly cachedInput: number;
  readonly cacheWrite: number;
  readonly output: number;
  readonly reasoning: number;
}

export interface TurnUsage {
  /** This turn only, sub-agents included, by the model id the CLI reported. */
  readonly byModel: Readonly<Record<string, TokenUsage>>;
  /** Nominal cost the CLI reports, if any (Claude). */
  readonly costUsd: number | null;
  readonly durationMs: number;
}

/** Subscription usage the CLI reported during the turn: windows "5h" and "weekly". */
/**
 * How full the session's context is: the tokens of its latest request to the
 * model (the conversation so far), and the model's window when reported.
 */
export interface ContextUsage {
  readonly used: number;
  readonly window: number | null;
}

export interface QuotaSnapshot {
  readonly windows: readonly {
    readonly name: string;
    readonly usedPercent: number;
    readonly resetsAt: number | null;
  }[];
}

export interface AgentTurnResult {
  /** The agent's final message for the turn. */
  readonly text: string;
  readonly identity: AgentIdentity;
  /** Measured by the adapter; absent when the CLI reports nothing. */
  readonly usage?: TurnUsage;
  readonly quota?: QuotaSnapshot | null;
  /** The main session's context after the turn, when the CLI reports it. */
  readonly context?: ContextUsage | null;
}

export interface AgentTurn {
  readonly done: Promise<AgentTurnResult>;
  /** Interrupts the turn (or terminates the process); `done` then rejects. */
  stop(): Promise<void>;
}

/**
 * A skill of the agent's own CLI the user named for a turn (ADR 0019): its
 * name, and its file where the CLI needs it (Codex).
 */
export interface SkillRef {
  readonly name: string;
  readonly path?: string;
}

export interface TurnOptions {
  /** Invoked at the start of the turn, in the CLI's own way. */
  readonly skill?: SkillRef;
}

export interface AgentSession {
  /** Display name, e.g. "Codex (gpt-6-luna)". */
  readonly name: string;
  /** Recipient name in delegation blocks (`<<<DELEGA #<id>`), e.g. "claude". */
  readonly id: string;
  runTurn(prompt: string, handlers: AgentTurnHandlers, options?: TurnOptions): AgentTurn;
  /**
   * Sets the reasoning effort of the next turns, in the same session; the
   * user chooses it during the chat. Absent: the effort is fixed.
   */
  setEffort?(effort: string): void;
  /**
   * Sets the model of the next turns, in the same session and with the same
   * CLI; the user chooses it during the chat. Absent: the model is fixed.
   */
  setModel?(model: string): void;
  close(): Promise<void>;
}

/**
 * What an agent's own sub-agents are held to (D13): internal instances of the
 * same CLI, created only on explicit request, with the model and effort set
 * here, at most `maxConcurrent` at a time, never named after an external agent.
 */
export interface SubagentPolicy {
  /** Exact model id the CLI must report for every sub-agent, e.g. "gpt-6-luna". */
  readonly model: string;
  /** Effort every sub-agent must run with, e.g. "low". */
  readonly effort: string;
  readonly maxConcurrent: number;
  /** Names of external agents and their models; matched as whole words, any case. */
  readonly forbiddenNames: readonly string[];
  /**
   * The agent may create sub-agents unasked, to read and explore the code so
   * its own context stays small (the leader, ADR 0009). Default: only when the
   * user asks explicitly.
   */
  readonly proactive?: boolean;
}

export interface AgentSessionOptions {
  /** Role instructions from the runtime, never read from repository files. */
  readonly instructions: string;
  /**
   * The policy for the agent's own sub-agents and the rules text written by the
   * runtime; the adapter applies them with its CLI's own mechanisms. Absent:
   * the user's configuration applies.
   */
  readonly subagents?: SubagentPolicy & { readonly rules: string };
  /**
   * The CLI's own session to continue (Claude session id, Codex thread id),
   * for a chat reopened later (R5). When it cannot be resumed, a new one starts.
   */
  readonly resume?: string;
}

/** Creates a session for one role; model and effort are the factory's configuration. */
export type AgentFactory = (options: AgentSessionOptions) => Promise<AgentSession>;
