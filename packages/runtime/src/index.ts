// Orchestration runtime: one conversation, a leader, an implementer, an
// optional reviewer, delegation and the JSONL event log (see
// docs/architecture.md).
//
// TODO(orchestrator): persistent tasks, failover and mediated approvals come in
// later iterations. This package must stay free of any `vscode` import so it
// can be tested in plain Node and reused outside the extension host.

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
  AgentQuestion,
  AgentSession,
  AgentSessionOptions,
  AgentTurn,
  AgentTurnHandlers,
  ApprovalDecision,
  ContextUsage,
  QuotaSnapshot,
  QuestionAnswers,
  SkillRef,
  TurnOptions,
  SubagentEvent,
  SubagentPolicy,
  TokenUsage,
  TurnUsage,
} from './agent.js';
export { parseDelegation } from './delegation.js';
export { extractResult, parseBrief, resultTemplate, type Brief } from './brief.js';
export { openEventLog, type EventLog, type LoggedEvent } from './event-log.js';
export {
  changedFiles,
  checkReport,
  checkReview,
  contractFacts,
  criteriaOf,
  criterionStatuses,
} from './contract.js';
export {
  FINDINGS_END,
  FINDINGS_START,
  REVIEW_END,
  REVIEW_START,
  parseReviewerTurn,
  reportOutcome,
  reviewVerdict,
} from './review.js';
export {
  BRIEF_AGENT_INSTRUCTIONS,
  EMPTY_REVIEW,
  IMPLEMENTER_ROLE_INSTRUCTIONS,
  LIGHT_IMPLEMENTER_INSTRUCTIONS,
  NO_COMMANDS_NOTE,
  REPORT_END,
  REPORT_START,
  REVIEWER_ROLE_INSTRUCTIONS,
  WORKER_ANSWER_END,
  WORKER_ANSWER_START,
  agentSessionOptions,
  briefAgentPrompt,
  frameWorkerAnswer,
  leaderInstructions,
  pendingReportsPreface,
  requestPrompt,
  reviewRequestPrompt,
  subagentRules,
  type PendingReport,
} from './prompts.js';
export { checkSubagent, subagentLabel, type SubagentState } from './subagents.js';
export {
  APPROVAL_DENIED_MESSAGE,
  agentLabel,
  runLoop,
  type InterceptDecision,
  type InterceptedMessage,
  type LoopOptions,
  type LoopOutcome,
  type MalformedDecision,
  type MalformedDelegation,
  type ThreadEvent,
} from './loop.js';
