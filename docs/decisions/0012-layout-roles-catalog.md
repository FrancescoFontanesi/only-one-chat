# 0012. Chat layout, sidebar views, and model catalog

Status: Accepted (iteration 3). Supersedes the Views section of ADR 0011 and the reasoning selectors in the header.

## Context

- **The chat header held every control**, including roles, reasoning, folder, approvals, and history. In the Codex and Claude extensions, the header contains the conversation title, new-chat control, and history. The composer and its controls sit at the bottom.
- **Models were fixed setting strings.** The extension had no catalog of the models each CLI offered or the reasoning levels each model supported. Sol supports up to `ultra`, and Haiku 4.5 exposes no reasoning levels.
- **The usage panel** used one card per subscription with notes and per-chat counters, which made it hard to scan.
- **The interface lacked live feedback** on who was working and what agents were exchanging.

## Decision

### Chat

- **At the top**, show the conversation title, status, HISTORY (the folder's chats), and + NEW.
- **At the bottom**, place the composer above a divider and the message controls below it.
  - Recipient, LEADER or IMPLEMENTER (equivalent to `@impl`).
  - The leader's route, with choices to let the leader decide, delegate, implement directly, or ask first. The corresponding typed commands `/delega`, `/fai`, and `/chiedi` remain valid.
  - Whether messages between agents require user approval or pass automatically.
  - The recipient's model, SEND, and STOP.
- **Enter** sends and **Shift+Enter** inserts a newline, as in the official extensions.

### Sidebar views in the Only One Chat container

- **Roles** shows the model for each role, grouped by provider and selected from models the CLIs offer. It also shows the model's reasoning levels and permissions. Roles such as reviewer and writer fit the same structure.
- **Activity** shows each role with its model, status (working, waiting for you, or idle), last activity, and active subagents. The event log below shows the most recent event first. This view starts with basic activity tracking. Further functions can be decided later.
- **Usage** shows a table with provider, 5h, and 1w columns and usage bars. The read time and notes appear in tooltips.

### Model catalog

- **Read the catalog from the CLIs without running turns or consuming quota.**
  - Codex uses all pages of App Server's `model/list` and includes only visible models.
  - Claude Code uses the stream-json `initialize` control request with `-p` and no user message, then closes stdin. Claude Code 2.1.308 was verified to return models and effort levels and exit with code 0 without running a turn.
- **Keep model fields only.** The Claude response also includes account data, which is neither read nor retained (security.md, T13).
- **Launch Claude in a temporary directory** away from the project settings.
- **Read once per window**, then on demand with the button in Roles.

### Roles during a chat

- **Settings remain the source of truth.** The Roles view writes them to their existing scope (folder or user), and the open chat receives the updates.
- **With the same provider, apply changes in the role's next turn within the same session.**
  - For model and reasoning, Codex accepts per-turn changes (`turn/start`), while each Claude turn is a process with `--model` and `--effort`.
  - For permissions, reopen the CLI session with the new rules and the same context (`thread/resume`, `--resume`).
- **The leader keeps the model selected when the chat starts** (user decision, 2026-11-02). Changing the leader model within a conversation requires a handoff and a memory layer. Reasoning and permissions can still change. The new model applies to the next chat.
- **Provider changes apply to the next chat.** A chat retains its original providers when reopened from history. Changing providers mid-chat requires a handoff with shared context, including where to resume and project history. The user is designing that context separately, and the handoff still needs a joint decision.

## Consequences

- **Adapters** expose `listCodexModels`, `listClaudeModels`, and `setModel` on Codex and Claude sessions as applicable.
- **Fake CLIs** respond to `model/list` and `initialize`.
- **History** saves the roles for each chat.
- **Usage** drops per-chat counters. Each turn card still shows that turn's usage.
