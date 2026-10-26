// Orchestration runtime: one conversation, a leader, workers, delegation,
// persistent tasks and failover (see docs/architecture.md).
//
// Implemented so far: the minimal D6 loop (orchestrator → intercepted
// delegation → worker → intercepted review → orchestrator, or a single
// question to the worker), provider-agnostic
// agent interfaces and the JSONL event log. TODO(orchestrator): persistent
// tasks, failover and mediated approvals come in later iterations. This package
// must stay free of any `vscode` import so it can be tested in plain Node and
// reused outside the extension host.

import pkg from '../package.json' with { type: 'json' };

export interface RuntimeInfo {
  readonly name: string;
  readonly version: string;
}

export function getRuntimeInfo(): RuntimeInfo {
  return { name: pkg.name, version: pkg.version };
}

export type {
  AgentFactory,
  AgentIdentity,
  AgentSession,
  AgentSessionOptions,
  AgentTurn,
  AgentTurnHandlers,
  AgentTurnResult,
  ApprovalDecision,
  ApprovalRequest,
  QuotaSnapshot,
  SubagentEvent,
  SubagentPolicy,
  TokenUsage,
  TurnUsage,
} from './agent.js';
export {
  DELEGATION_END,
  DELEGATION_SECTIONS,
  DELEGATION_START,
  delegationTemplate,
  parseDelegation,
  type Delegation,
  type DelegationParse,
  type DelegationSection,
} from './delegation.js';
export { openEventLog, type EventLog, type LoggedEvent } from './event-log.js';
export {
  APPROVAL_DENIED_MESSAGE,
  MAX_EXCHANGES,
  ORCHESTRATOR_INSTRUCTIONS,
  WORKER_INSTRUCTIONS,
  agentLabel,
  WORKER_ANSWER_END,
  WORKER_ANSWER_START,
  fixPrompt,
  frameWorkerAnswer,
  questionInstructions,
  subagentRules,
  checkSubagent,
  falseAttributions,
  subagentLabel,
  type SubagentState,
  requestPrompt,
  reviewPrompt,
  runLoop,
  type InterceptDecision,
  type InterceptedMessage,
  type Loop,
  type LoopOptions,
  type LoopOutcome,
  type MalformedDecision,
  type MalformedDelegation,
  type Role,
  type ThreadEvent,
} from './loop.js';
