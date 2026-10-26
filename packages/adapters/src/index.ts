// Provider adapters: drive the official CLIs (Codex, Claude Code, Antigravity)
// through the user's existing subscriptions, never through paid API keys.
// Like the runtime, this package must not import `vscode`.
//
// TODO(adapters): only the Codex App Server connection exists so far; threads,
// turns and the Claude/Antigravity adapters come in later milestones.

export {
  AppServerError,
  startAppServer,
  type AppServerClient,
  type AppServerErrorKind,
  type AppServerOptions,
  type ClientInfo,
  type ExitInfo,
  type ForcedShutdownReport,
  type InitializeResponse,
  type RequestOptions,
} from './codex/app-server.js';
export { resolveCodexExecutable, type ResolveCodexOptions } from './codex/executable.js';
export {
  CodexAuthError,
  isUsable,
  type CodexAuthState,
  type CodexProvider,
  type CodexRejection,
  type CodexUnauthorizedState,
  type CodexUsableState,
} from './codex/auth.js';
export {
  connectCodex,
  deniedReason,
  type CodexSession,
  type CodexSessionOptions,
} from './codex/session.js';
export { API_KEY_VARIABLES, withoutApiKeys } from './environment.js';
export type {
  AgentApprovalRequest,
  AgentFactory,
  AgentIdentity,
  AgentSubagentEvent,
  AgentSubagentOptions,
  AgentSession,
  AgentTurn,
  AgentTurnHandlers,
} from './agent.js';
export {
  subagentThreadConfig,
  CODEX_SUBAGENT_FORBIDDEN_NAMES,
  createCodexAgentFactory,
  declineResponse,
  type CodexAgentConfig,
} from './codex/agent.js';
export { createClaudeAgentFactory, type ClaudeAgentConfig } from './claude/agent.js';
export {
  ExecutableNotFoundError,
  resolveNativeExecutable,
  type ResolveExecutableOptions,
} from './executable.js';
export { resolveClaudeExecutable } from './claude/executable.js';
export {
  ClaudeError,
  CLAUDE_SUBAGENT_FORBIDDEN_NAMES,
  isOfficialAnthropicUrl,
  SANDBOX_TOOLS,
  SUBAGENT_TOOL,
  sandboxAllowedTools,
  subagentEnv,
  READ_ONLY_TOOLS,
  checkClaudeBilling,
  claudeTurnArgs,
  startClaudeTurn,
  type ClaudeBilling,
  type ClaudeErrorKind,
  type ClaudeEvent,
  type ClaudeTurn,
  type ClaudeTurnOptions,
  type ClaudeTurnResult,
} from './claude/turn.js';
