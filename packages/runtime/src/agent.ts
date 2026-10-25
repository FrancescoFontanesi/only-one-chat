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

export type ApprovalDecision = 'decline';

export interface AgentTurnHandlers {
  /** Text as it streams (deltas or whole messages, depending on the agent). */
  onText(text: string): void;
  /** The agent wants an approval; the runtime decides. */
  onApprovalRequest(request: ApprovalRequest): Promise<ApprovalDecision>;
  /** Anything else worth showing (tool use, rate limits, …). */
  onActivity?(activity: { readonly kind: string; readonly detail: string }): void;
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

export interface AgentTurnResult {
  /** The agent's final message for the turn. */
  readonly text: string;
  readonly identity: AgentIdentity;
}

export interface AgentTurn {
  readonly done: Promise<AgentTurnResult>;
  /** Interrupts the turn (or terminates the process); `done` then rejects. */
  stop(): Promise<void>;
}

export interface AgentSession {
  /** Display name, e.g. "Codex (gpt-6-luna)". */
  readonly name: string;
  /** Recipient name in delegation blocks (`<<<DELEGA @<id>`), e.g. "claude". */
  readonly id: string;
  runTurn(prompt: string, handlers: AgentTurnHandlers): AgentTurn;
  close(): Promise<void>;
}

export interface AgentSessionOptions {
  /** Role instructions from the runtime, never read from repository files. */
  readonly instructions: string;
}

/** Creates a session for one role; model and effort are the factory's configuration. */
export type AgentFactory = (options: AgentSessionOptions) => Promise<AgentSession>;
