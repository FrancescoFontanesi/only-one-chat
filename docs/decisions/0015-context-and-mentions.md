# 0015. Context indicator and file mentions with `@`

Status: Accepted (iteration 3).

## Context

- **The user could not see how full the recipient session's context was.** The indicator helps decide when to open a new chat and will support continuity between sessions. That design is still open and will involve the user's memory layer (ADR 0011).
- **Users had to type file paths manually.** ADR 0011 decided to pass attachments as paths to preserve the leader's context.

## Decision

### Context indicator

- **Measure the token count of the main session's latest request to the model** against the model's context window. This represents the conversation in its current state.
  - Codex uses `thread/tokenUsage/updated` for the main thread, specifically `last` (`totalTokens`) and `modelContextWindow`. Subagents have separate threads and are excluded.
  - Claude uses `usage` from the last assistant message in the main conversation, including input, cache writes and reads, and output. The result's `modelUsage` gives the model's `contextWindow`.
- **Turn usage stays in the turn card** and sums all requests in that turn.
- **Show context under the composer for the selected recipient** (`CONTEXT 25k / 258k · 10%`) and in Activity for each role. Save it with the chat.

### File mentions with `@`

- **In the composer**, typing `@` opens a list of files and directories in the working folder. It uses the same exclusions as checkpoints, up to 5,000 files, and filters as the user types. Arrow keys navigate, Enter or Tab selects, and Esc closes the list. The file list reloads each time the user types `@`.
- **From the editor**, "Only One Chat: Add File or Selection to Chat" (Ctrl+Alt+K, also available in the context menu) inserts `@file` or `@file#L10-20` for a selection.
- **On send**, the host looks for mentions in the text and appends an attachments block for agents.
  - Files and directories appear as relative paths. Agents read them directly or use subagents.
  - A line range is copied into the message only if it has at most 80 lines and 8,000 characters. Longer ranges stay as references.
  - Keep at most 20 paths per message. Each must exist and resolve inside the working folder. Other text, including a leading `@impl` and email addresses, stays as written.
- **In the thread**, the message shows the user's text and an attachment list.
- **Images are deferred** (ADR 0013).

## Consequences

- **Codex and Claude adapters** return `context` in the turn result, and the runtime forwards it with the message.
- **Session continuity** may use this measure as a threshold once that feature is designed.
