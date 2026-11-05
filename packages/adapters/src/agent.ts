import type { ContextUsage, QuotaSnapshot, TurnUsage } from './usage.js';

// The agent shape the runtime expects (packages/runtime/src/agent.ts), restated
// here so adapters do not depend on the runtime: TypeScript checks the two
// structurally wherever they are wired together (the demo, later the extension).

export interface AgentApprovalRequest {
  readonly kind: string;
  readonly summary: string;
}

/** What an agent reports about its own sub-agents (runtime: SubagentEvent). */
export type AgentSubagentEvent =
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
export interface AgentUserQuestion {
  readonly id: string;
  readonly header: string;
  readonly question: string;
  readonly options: readonly { readonly label: string; readonly description: string }[] | null;
  readonly other: boolean;
  readonly secret: boolean;
}

/** The user's answers by question id; null when the user did not answer. */
export type AgentQuestionAnswers = Readonly<Record<string, readonly string[]>> | null;

/**
 * One step of a turn as it happens (ADR 0019), sent again whole on every
 * change and replaced by id: an intermediate message, the reasoning, a
 * command with its output, file changes, the turn's plan, another tool.
 */
export type AgentStepStatus = 'running' | 'done' | 'failed';

export interface AgentFileChange {
  readonly path: string;
  readonly change: 'add' | 'delete' | 'update';
  readonly added: number;
  readonly removed: number;
  /** Unified diff, cut to its first part when long. */
  readonly diff: string;
}

export type AgentTurnStep =
  | { readonly kind: 'message'; readonly id: string; readonly text: string }
  /** The reasoning; `text` is its summary, empty when the CLI gives none. */
  | { readonly kind: 'reasoning'; readonly id: string; readonly text: string }
  | {
      readonly kind: 'command';
      readonly id: string;
      readonly command: string;
      readonly status: AgentStepStatus;
      readonly exitCode: number | null;
      readonly durationMs: number | null;
      /** The last part of what it printed. */
      readonly output: string;
    }
  | {
      readonly kind: 'file';
      readonly id: string;
      readonly status: AgentStepStatus;
      readonly changes: readonly AgentFileChange[];
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
      readonly status: AgentStepStatus;
    };

export interface AgentTurnHandlers {
  onText(text: string): void;
  /** `acceptForSession` as the CLI scopes it; see the runtime's ApprovalDecision. */
  onApprovalRequest(
    request: AgentApprovalRequest,
  ): Promise<'accept' | 'acceptForSession' | 'decline'>;
  onActivity?(activity: { readonly kind: string; readonly detail: string }): void;
  onSubagent?(event: AgentSubagentEvent): void;
  onQuestion?(questions: readonly AgentUserQuestion[]): Promise<AgentQuestionAnswers>;
  onStep?(step: AgentTurnStep): void;
}

/** Who answered, as observed on the wire: the runtime writes the label from it. */
export interface AgentIdentity {
  readonly provider: string;
  readonly model: string;
  readonly effort: string | null;
  readonly sessionId: string;
}

export interface AgentTurn {
  readonly done: Promise<{
    readonly text: string;
    readonly identity: AgentIdentity;
    readonly usage?: TurnUsage;
    readonly quota?: QuotaSnapshot | null;
    /** The main session's context after the turn, when the CLI reports it. */
    readonly context?: ContextUsage | null;
  }>;
  stop(): Promise<void>;
}

/** A skill of the CLI named for a turn (ADR 0019); the path where the CLI needs it (Codex). */
export interface AgentSkillRef {
  readonly name: string;
  readonly path?: string;
}

export interface AgentSession {
  readonly name: string;
  /** Recipient name in delegation blocks. */
  readonly id: string;
  runTurn(
    prompt: string,
    handlers: AgentTurnHandlers,
    options?: { readonly skill?: AgentSkillRef },
  ): AgentTurn;
  /** Reasoning effort of the next turns, without a new session. */
  setEffort?(effort: string): void;
  /** Model of the next turns, in the same session. */
  setModel?(model: string): void;
  close(): Promise<void>;
}

/** Policy for the agent's own sub-agents and the runtime's rules text (D13). */
export interface AgentSubagentOptions {
  readonly model: string;
  readonly effort: string;
  readonly maxConcurrent: number;
  readonly forbiddenNames: readonly string[];
  /** Sub-agents may be created unasked, to read and explore (see the runtime's SubagentPolicy). */
  readonly proactive?: boolean;
  readonly rules: string;
}

export type AgentFactory = (options: {
  readonly instructions: string;
  readonly subagents?: AgentSubagentOptions;
  /** The CLI's own session to continue; see the runtime's AgentSessionOptions. */
  readonly resume?: string;
}) => Promise<AgentSession>;
