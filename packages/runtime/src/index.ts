// Orchestration runtime: one conversation, a leader, an implementer, an
// optional reviewer, the handoff tools between them and the JSONL event log (see
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
  HandoffCall,
  HandoffServer,
  HandoffSpec,
  HandoffTools,
  QuotaSnapshot,
  QuestionAnswers,
  SkillRef,
  TurnOptions,
  SubagentEvent,
  SubagentPolicy,
  TokenUsage,
  TurnUsage,
} from './agent.js';
export { extractResult, parseBrief, resultTemplate, type Brief } from './brief.js';
export { CommandEvidence } from './command-evidence.js';
export {
  readTaskProgress,
  type TaskProgress,
  type TaskJournal,
  type TaskWork,
  type TaskReview,
} from './task.js';
export type {
  TestSelection,
  VerificationResult,
  VerificationEvidence,
  WorkVerification,
} from './verification.js';
export { openEventLog, type EventLog, type LoggedEvent } from './event-log.js';
export {
  TEST_FILE,
  TURN_FILES_HEADER,
  changedFiles,
  checkReferences,
  checkReport,
  checkReview,
  contractFacts,
  criteriaOf,
  isTestFile,
  type ReferenceKind,
} from './contract.js';
export {
  handoffTools,
  readHandoff,
  renderBrief,
  renderFindings,
  renderReport,
  renderReview,
  type CriterionResult,
  type CriterionStatus,
  type Delegate,
  type Findings,
  type HandoffName,
  type Report,
  type ReportOutcome,
  type Review,
  type ReviewVerdict,
  type Severity,
} from './handoff.js';
export {
  BRIEF_AGENT_INSTRUCTIONS,
  EMPTY_REVIEW,
  IMPLEMENTER_ROLE_INSTRUCTIONS,
  LIGHT_IMPLEMENTER_INSTRUCTIONS,
  NO_COMMANDS_NOTE,
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
  type ThreadHandoff,
} from './loop.js';
