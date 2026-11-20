# 0013. Settings page and assessment of proposed features

Status: Accepted (iteration 3).

## Context

- **Enter now sends a message** under ADR 0012. The user needs a way to change this behavior and other preferences, including notifications, role instructions, and how to handle unsaved files.
- **The user brought a feature list written outside the project** and wanted to keep only the features that address a real need.

## Decision

### Where settings live

- **Use native VS Code settings** (`contributes.configuration`) for user and folder scope, Settings Sync, and edits in `settings.json`.
- **Provide a dedicated page** that groups and writes settings. Open it through "Only One Chat: Settings", the SETTINGS button in chat, or the gear in the Roles view.
  - Each option shows where its value comes from (default, user, or folder).
  - SAVE FOR selects where to write. RESET clears the value at that scope.
  - CLI paths, allowed commands, and role instructions use `machine` scope to prevent a cloned repository from changing them (security.md, T13).
  - The page can write only keys listed in `src/settings.ts` and validates each value against its declared type.
  - OPEN IN VS CODE opens native settings filtered to the extension.

### New settings

| Key                            | Behavior                                                                  |
| ------------------------------ | ------------------------------------------------------------------------- |
| `leader.instructions`          | Appends the user's instructions to the leader's instructions              |
| `implementer.instructions`     | Appends the user's instructions to the implementer's instructions         |
| `composer.enterSends`          | Enter sends and Shift+Enter inserts a newline. When off, Ctrl+Enter sends |
| `saveBeforeSend`               | Ask, save, or leave unsaved folder files as they are before sending       |
| `notifications.waiting`        | Notify when an agent is waiting and the chat is out of view               |
| `notifications.turnEnd`        | Notify when a message finishes and the chat is out of view                |
| `notifications.usageThreshold` | Notify when a usage window exceeds the threshold. 0 disables it           |

### Proposed features to keep

Small features implemented at this stage.

- **Require a folder (A2).** If the folder is absent or untrusted, the status is NOT READY and sending is disabled. Provide OPEN FOLDER and show the folder name under the title.
- **Provider status (A3, partial).** Roles and Settings show whether a CLI is missing or disconnected. Claude uses `claude auth status`, and Codex verifies the account while reading the model catalog. Usage shows the reason in place of "—". Sign-in stays in the terminal with the CLI command, keeping authentication under the user's control.
- **Approvals (A9, partial).** Notify when an agent blocks waiting for approval.
- **Transcript (A10).** Label the user's message YOU. The leader and implementer were already labeled and technical actions already grouped under ACTIVITY.
- **Commands (A16).** Add new chat, stop, settings, and open chat to the Command Palette.
- **Role instructions, Enter behavior, notifications, unsaved files, and usage threshold** (section B).

Features that already existed.

- **Stop (A1).** STOP cancels the whole cycle and denies waiting requests. Send becomes Stop during a turn.
- **Delegation as an object (A5).** With manual approval, the DELEGATION card shows the full editable brief and offers Approve and Cancel. The implementer waits for approval.
- **Agent status (A8).** Activity shows an agent as working, waiting for you, or idle, along with its latest action.

Follow-up work in the proposed order.

1. **Change review and code checkpoints (A6 and A7).** Use one mechanism. Before each turn, copy files into a shadow repository in extension storage. Show added and removed lines by file at the end of each turn, provide native VS Code diffs, offer per-file Accept or Reject, and support restoring to a checkpoint. Explain that shell commands fall outside this mechanism.
2. **Prompt context (A4).** Include files and folders through `@`, and pass the open file and selection as paths (ADR 0011). Defer images because they use context and are rarely needed.
3. **History (A14).** Search, rename, and delete chats.
4. **Errors (A13).** Retry and Copy Details.
5. **Messages during execution (A15).** Queue at most one message.

### Proposed features to defer or leave out

- **Stop a single agent (A1).** One agent works at a time. Revisit when implementers run in parallel.
- **Conversation restore (A7).** CLI sessions cannot be reliably shortened. Restoring the visible conversation with the original model context intact would mislead the user.
- **End-of-turn summary (A11).** Verified facts and the leader's review already summarize the work. Another summary would cost a turn.
- **Automatic leader–implementer loops (A12, B).** They consume quota without user involvement. Keep the leader review and let the user choose whether to defer it.
- **Redirect a running agent (A15).** The CLI protocols differ. Implement the queue first.
- **A unified approval list (A9).** The thread already shows approval cards, and the notification opens them.
- **Pass project instruction files (B).** Codex already reads AGENTS.md and Claude reads CLAUDE.md. Providing them again doubles the context they use.
- **Always show the brief (B).** Manual approval already provides this behavior.
- **Network, access outside the folder, and always-denied commands (B).** These options change the security model. Codex network access stays off and out-of-folder actions require approval until the user decides otherwise.
- **Displayed providers, usage refresh interval, and default recipient (B).** There are two providers, the refresh interval is already conservative, and the composer lets the user select the recipient.
- **History retention (B).** The 50-chat limit suffices until history supports search.

## Consequences

- **Settings page code** lives in `SettingsPanel`, `src/settings.ts`, and `webview/Settings.tsx`.
- **Chat sessions** receive the user's role instructions starting with the next chat.
- **Notifications** live in `src/notifications.ts`.
