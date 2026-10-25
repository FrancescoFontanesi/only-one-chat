// The agent shape the runtime expects (packages/runtime/src/agent.ts), restated
// here so adapters do not depend on the runtime: TypeScript checks the two
// structurally wherever they are wired together (the demo, later the extension).

export interface AgentApprovalRequest {
  readonly kind: string;
  readonly summary: string;
}

export interface AgentTurnHandlers {
  onText(text: string): void;
  onApprovalRequest(request: AgentApprovalRequest): Promise<'decline'>;
  onActivity?(activity: { readonly kind: string; readonly detail: string }): void;
}

export interface AgentTurn {
  readonly done: Promise<{ readonly text: string }>;
  stop(): Promise<void>;
}

export interface AgentSession {
  readonly name: string;
  runTurn(prompt: string, handlers: AgentTurnHandlers): AgentTurn;
  close(): Promise<void>;
}

export type AgentFactory = (options: { readonly instructions: string }) => Promise<AgentSession>;
