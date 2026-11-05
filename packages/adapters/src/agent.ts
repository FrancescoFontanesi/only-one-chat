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

export interface AgentTurnHandlers {
  onText(text: string): void;
  /** `acceptForSession` as the CLI scopes it; see the runtime's ApprovalDecision. */
  onApprovalRequest(
    request: AgentApprovalRequest,
  ): Promise<'accept' | 'acceptForSession' | 'decline'>;
  onActivity?(activity: { readonly kind: string; readonly detail: string }): void;
  onSubagent?(event: AgentSubagentEvent): void;
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
