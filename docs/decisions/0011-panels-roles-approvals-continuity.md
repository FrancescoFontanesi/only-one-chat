# 0011. Panels, roles, approvals, and implementer continuity

Status: Partially accepted (iteration 3).

- The experiment below decided who makes small changes, how the implementer session continues, how to use `@impl`, and how to queue reports.
- Switching workstreams remains an open design question.
- Approvals and persistence are implemented. ADR 0012 supersedes the views.

## Context

- **ADR 0010** centered the chat with the leader. At this point one panel showed the chat, delegation approvals, and runtime facts.
- **The user wants controls available in the Codex and Claude extensions**, including file attachments, a context indicator, model and reasoning selectors, and permission levels.
- **The user also wants separate views** to assign extensible roles, see quota for all connected models, and see the flow between agents with the active model highlighted.
- **The user can talk directly to the implementer.**
- **The implementer currently starts fresh for every delegation.** In `calc-session`, a follow-up made a new session reread 56k of context.
- **The research covered official extensions and usturlab.** [ui-primitives.md](../ui-primitives.md)

## Decision

### Views

- **One sidebar container** holds four views.
  - **Chat** shows the conversation, approvals, and facts.
  - **Flow** shows You → Leader → Implementer, with subagents nested under the agent that spawned them. The working model is highlighted, and briefs and reports appear as they pass between agents.
  - **Roles** shows the CLI, model, reasoning, and permission level for each role. The current roles are leader and implementer, and the structure supports adding roles such as reviewer, writer, or explorer.
  - **Quotas** shows the five-hour and weekly windows for each connected subscription, with the last read time.
- **Chat** can also open in an editor tab.

### Composer

- **Recipient.** The leader is the default. Prefix a message with `@impl` to send it straight to the implementer.
- **Commands for choosing the leader route.** Use `/fai`, `/delega`, or `/chiedi`.
- **Attachments are passed as paths.** The leader has subagents read them to preserve its context. Include selection text only if it is small.
- **Model and reasoning selectors** affect the recipient's next turn in the same session. Codex accepts effort per turn, and each Claude turn is a process with its own `--effort`.
- **The context indicator** tracks the recipient's session.
  - Claude uses the last assistant message's usage relative to the model context window.
  - Codex uses thread token notifications.

### Permissions

- **Three levels per role.** Read only, ask, or automatic within the folder. They map to native modes.
  - Codex uses `read-only` or `workspace-write`, with `approvalPolicy` set to `on-request`.
  - Claude uses a list of tools and commands plus permission requests.
- **All levels enforce permission checks.**
- **Approvals** appear as blocking cards in the thread with Allow, Allow for Session, and Deny. Allow for Session applies to the complete command, so sharing a first token is insufficient (threat T5).
- **Codex** already sends approval requests over its protocol. Forward those requests to the user instead of denying them by default.
- **Headless Claude uses a `PermissionRequest` hook.**
  - **The Claude Code documentation specifies the hook contract**, including its input and output. The contract for the alternative MCP option, `--permission-prompt-tool`, is undocumented.
  - **Pass the hook with `--settings` on each turn**, leaving the user's settings intact.
  - **The script** (`packages/adapters/hooks/permission-request.mjs`, run by the editor's Node) asks the extension through a bridge on 127.0.0.1, with a random token per role. It denies if the token is missing, the bridge fails to respond, or no decision arrives within nine minutes.
  - **Ask mode** supplies no `--allowedTools`, so edits and commands that require permission go to the user.
  - **Auto mode** applies the folder boundary and allowed commands. Other permission requests go to the user.
  - **The bridge remembers session approval** only for the same tool with exactly the same full input (threat T5).
  - **Requests the hook does not decide** remain denied through `--permission-prompts none`.
  - **Verified with Claude 2.1.308 on a real Haiku turn.** The hook was called, the allow decision applied, and the command ran.
  - **Verified in the editor.** The smoke test uses the configured command line to run the script in `dist/hooks` with VS Code's Node and receives the decision.
  - **Short Windows paths require special handling.** If a folder path uses an 8.3 name such as `FRANCE~1`, Claude requires manual approval that hooks cannot provide. The extension always expands the folder to its long name.
  - **Threat model.** See T12 in [security.md](../security.md).

### Implementer continuity

- **Session per workstream.** The leader indicates in the delegation block whether it is continuing the previous workstream or starting a new one. The implementer resumes its session in the same workstream.
- **Reset the session** on a new workstream, when context exceeds a threshold (for example, 65% of the window), or when the user opens a New Chat.
- **Work map.** The implementer report includes a compact map of files and symbols touched. When the session starts fresh, the runtime attaches it to the next brief.
- **Direct messages** (`@impl`) use the current workstream's session.

### Persistence (implemented)

- **Each chat has an atomic JSON file in the extension's workspace storage.** Write a temporary file and rename it. It contains the following.
  - Thread updates to reconstruct the UI. The final text subsumes chunks from completed turns.
  - The native leader and implementer session IDs.
  - Implementer reports the leader has yet to read. Save them at the end of each turn. If the chat closes during a leader turn, the previous unread reports remain and the leader reads them again.
- **Limits.** Keep up to 50 chats and 3,000 updates per chat.
- **When the panel reopens**, it restores the latest chat. The header lets the user select earlier chats or open a blank one with New Chat. Previously running or waiting items appear interrupted.
- **Resuming native sessions.**
  - Claude uses `--resume`.
  - Codex uses `thread/resume`, the same rules as at startup for folder, sandbox, policy, and instructions, plus `excludeTurns`. The extension uses persistent threads, which Codex saves in its history as its own extension does. Benchmarks still use `ephemeral` threads.
  - Start a new thread if the previous one is gone.
- **The first resumed turn omits usage.** The CLI reports a session total including earlier processes, and the baseline is unavailable. Subsequent turns can report the difference.

### Outcome for small changes

The `calc-small` test used one run per variant at low effort.

- **Direct implementation by the leader cost the most.** Sol read 180k of context for a one-line edit because each tool call resent its whole session. Delegation cost it 48k.
- **Reusing the implementer session** roughly halved the cost of a follow-up (55% less on Claude).
- **A direct message** was cheapest and fastest. The leader did not see it immediately.

The experiment led to these decisions.

- **The leader delegates all changes, including small ones.** A short, focused message is enough for a follow-up. The leader implements directly only with `/fai` or if the implementer is unavailable.
- **The implementer session lasts for the whole chat.** Workstream boundaries still need a design, such as a context threshold or a handoff with the work map and role instructions.
- **`@impl`** sends a message directly to the implementer.
- **Unread reports** from direct messages or deferred review accompany the next user message as data. They add text to that turn without requiring a separate turn.
- **Review after delegation** is configurable through `onlyOneChat.leaderReview`.
  - `always` (default) runs an immediate leader review.
  - `deferred` waits for the next user message, saving a leader turn.

### Experiment on small changes

1. The leader delegates a small change to Claude and receives the report.
2. The user requests a small related change.

**Five variants for the second request**, all at low reasoning effort.

| Variant | Recipient                            | Implemented by | Implementer session      |
| ------- | ------------------------------------ | -------------- | ------------------------ |
| V1      | Leader                               | Leader         | —                        |
| V2      | Leader, who writes a focused message | Claude         | New                      |
| V3      | Leader, who writes a focused message | Claude         | Same as the first change |
| V4      | Claude, by direct message            | Claude         | New                      |
| V5      | Claude, by direct message            | Claude         | Same as the first change |

**Measurements** include hidden tests, tokens and cost per subscription for the second request alone, elapsed time, and leader context growth.

## Consequences

- **The runtime** accepts existing implementer and leader sessions, supports direct messages, and includes a workstream in delegations.
- **The Codex adapter** supports per-turn effort and persistent threads.
- **Sandbox mode** (ADR 0008) remains the automatic-within-folder level until approvals reach the panel.
