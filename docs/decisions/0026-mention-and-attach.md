# 0026. Mention a file with @ and attach it with +

Status: Accepted (iteration 3). Clarifies attachments in ADR 0015 and references in ADR 0018.

## Context

- **One key handled two actions.** `@` in the composer opened a list of files and turned the selected file into an attachment above the text. The agent received an attachments block, including the selected lines when the range was short.
- **Claude Code and Codex use `@` for inline file references.** It identifies a path in the message.

## Decision

1. **`@` mentions a file.** Selecting a file inserts `@path`, relative to the open folder. The thread renders it as a clickable reference (ADR 0018). The agent receives an ordinary path in the message (`plainRefs`).
2. **+ attaches a file.** The button before CTX and the attachment command (historically `/allega`) open VS Code's file picker at the workspace folder. Files inside the folder appear as attachments above the text. Files outside it are rejected with a notice. Ctrl+Alt+K still attaches the open file or selected lines.
3. **Attachments travel in a separate `send` field.** The host validates up to 20 paths. Only attachments populate the ADR 0015 attachments block.

## Consequences

- A manually typed `@path` that exists in the folder reaches the agent as a plain path. An `@` reference that names no workspace file is preserved as typed.
- The `@path` format does not allow spaces, so an attachment with a space in its path is skipped.
