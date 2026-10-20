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
  type InitializeResponse,
  type RequestOptions,
} from './codex/app-server.js';
export { resolveCodexExecutable, type ResolveCodexOptions } from './codex/executable.js';
export {
  CodexAuthError,
  type CodexAuthState,
  type CodexLoginMethod,
  type CodexLoginStart,
  type CodexRejection,
  type CodexUnauthorizedState,
} from './codex/auth.js';
export { connectCodex, type CodexSession, type CodexSessionOptions } from './codex/session.js';
