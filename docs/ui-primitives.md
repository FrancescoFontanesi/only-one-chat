# UI primitives and references

This survey dates to 2026-10-27 and predates the panel layout ADR. It draws on publicly
visible Codex and Claude Code extension features and a read-only study of usturlab
(`references/usturlab`, MIT). [ADR 0002](decisions/0002-reuse-policy.md) limits reuse to
ideas.

## Primitives for Only One Chat

| Primitive              | Reference behavior                                                                                                                                                                                                                                 | Proposal                                                                                                                                                 |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Views                  | usturlab has a sidebar container listing sessions and opens each chat in an editor tab (`vscode/package.json:34-62`, `chatViewProvider.ts:100-104`).                                                                                               | Sidebar views for Chat, Squad, Roles, and Quotas, with the chat optionally available in a tab.                                                           |
| Attachments            | usturlab passes file **paths** ("Attached files: …") and includes selections shorter than 4,000 characters inline (`chatViewProvider.ts:830-835`, `workspaceContext.ts:61-91`).                                                                    | Pass file paths so the leader can have subagents read them. Include only small selections inline.                                                        |
| Model and reasoning    | Official extensions use composer selectors. usturlab uses `@provider/model` mentions and routes effort automatically.                                                                                                                              | Per-role selectors that can change during a chat. The user chooses effort (ADR 0010).                                                                    |
| Permission levels      | usturlab offers Plan / Edit / Full, plus "ask before every step" (`Composer.tsx:86-202`).                                                                                                                                                          | Map per-role levels to native modes with permission checks enabled. usturlab's Full uses `--dangerously-skip-permissions`, which this project prohibits. |
| Approvals              | A blocking card in the thread (Allow / Always / Deny), with a notification if the tab is out of focus (`Transcript.tsx:170-225`).                                                                                                                  | Use the same interaction and scope "Always" to the complete command. usturlab uses the first token (`permission.ts:63-83`, threat T5).                   |
| Messages during a turn | Claude accepts messages over stdin with `stream-json`. Codex accepts `turn/steer` (`claude.ts:178-189`, `codex.ts:317-330`).                                                                                                                       | Consider this for correcting the leader during work.                                                                                                     |
| Context indicator      | Official extensions show this. usturlab lacks it.                                                                                                                                                                                                  | For Claude, show the last assistant message's usage relative to the model window. For Codex, use thread token notifications.                             |
| Agent visualization    | usturlab's `AgentLanes.tsx` shows each subagent in a lane with status, activity, duration, and an "N in parallel" summary.                                                                                                                         | Squad shows User → Leader → Implementer, with nested subagents and a highlight on the active agent.                                                      |
| Persistence            | usturlab keeps up to 50 chats and their UI event logs in `globalState`, plus a map of native sessions. Claude resumes with `--resume`. Codex uses `thread/resume` with a fallback to `thread/start` (`sessionStore.ts:48-58`, `codex.ts:289-302`). | Use the same design in workspace storage. Codex needs persistent threads with `ephemeral` disabled.                                                      |
| Other                  | A line identifying the responding provider and why, single-line tool summaries, "retry last", and an "in progress" marker in the session list.                                                                                                     | The leader's "Via:" line already identifies the responding provider.                                                                                     |

## Claude approvals in headless mode

usturlab uses `--permission-prompt-tool` with its own small stdio MCP server. The server
forwards the request to the extension over a socket at 127.0.0.1, secured by a random
token, denies requests if the extension fails to respond, and times out after 10 minutes
(`permission/bridge.ts:91-118`, `permission/mcpServer.ts`). Its comment says that manual
permission mode silently falls back to behavior without prompts in `stream-json`
(`mcpServer.ts:4-7`).

The survey proposed an MCP permission tool for interactive Claude approvals, implemented
as a minimal stdio JSON-RPC server in the project without adding the MCP SDK. The design
decision belongs in the ADR.

## Excluded practices

| usturlab practice                                                                                                                                      | Reason                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------ |
| Reading Claude quota by using the OAuth token in `.credentials.json` to call an undocumented endpoint (`claudeCredentials.ts`, `claudeUsagePoller.ts`) | Prohibited by project rule 2   |
| Reading Codex quota from rollout files under `$CODEX_HOME/sessions` (`codexUsageReader.ts`)                                                            | Prohibited                     |
| Keying "Always" approvals on the first command token                                                                                                   | Scope is too broad (threat T5) |

The survey identified three sources that use no model quota:

- **Codex** uses `account/rateLimits/read`.
- **Claude** emits `rate_limit_event` for each turn.
- **Antigravity** responds to `agy -p /quota --output-format json` without a model turn
  (ADR 0023).
