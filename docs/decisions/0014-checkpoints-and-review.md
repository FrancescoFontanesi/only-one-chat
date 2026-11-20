# 0014. Folder checkpoints and change review

Status: Accepted (iteration 3).

## Context

- **After a message**, users saw only a list of changed files. They needed diffs, per-file rejection, and the ability to restore the folder to review and undo delegated work on a real project (ADR 0013, A6 and A7).
- **The CLIs differ in checkpoint support.** Claude has its own checkpoints, and Codex App Server exposes no comparable feature for external clients. The extension needs a common mechanism under its own control.

## Decision

### Checkpoints

- **Before each user message**, the extension records the folder's files.
  - Store each distinct content blob once under its SHA-256 in the extension's storage for the chat (`checkpoints/<chat>/blobs`). Writes are atomic.
  - Record a path-to-hash manifest for each checkpoint (`checkpoints/<chat>/checkpoints/<id>.json`).
- **Use the same storage mechanism for every folder**, independent of Git or a shadow repository. The extension needs no additional dependency and keeps `.git` untouched.
- **Reuse the exclusions from verified facts** (`.git`, `node_modules`, `__pycache__`, `.venv`, `venv`, `dist`, and `out`) and cap checkpoints at 5,000 files.
- **Skip files over 2 MB.** If they change, the card marks them as not reversible. Restoration keeps those files as they are.
- **Deleting a chat from history** also deletes its checkpoints.

### Review

- **A CHANGES card at the end of each message** shows the type of change (added, modified, removed) and the number of inserted and deleted lines per file. This replaces the plain list of changed files. The leader continues to receive verified facts as before.
- **Open the native VS Code diff** between the recorded content from before and after the message. The diff represents that message even if the file changes again.
- **ACCEPT** marks the file as reviewed. **REJECT** restores it to its state before the message and asks for confirmation if it has changed again in the meantime.
- **Restore Here** on a user message restores the folder to its state before the message, after confirmation.
- **The conversation continues after a restore** (ADR 0013). CLI sessions cannot be shortened. On the next message the runtime tells the leader and implementer which files were restored, because their context still includes the earlier changes.
- **Reject and restore** are available only when no message is running.

### Security

- **The webview names a file and the host looks it up in the stored card.** Only paths recorded by the checkpoint are in scope, and each resolved path must stay inside the folder.
- **Serve diff contents through the read-only scheme** `only-one-chat-checkpoint:` and require valid hashes.

## Consequences

- **Explain the checkpoint boundary to the user.** The extension can restore only eligible files inside the folder. Shell effects outside the folder or in excluded directories, and files over 2 MB, are outside that boundary.
- **Storage.** The first checkpoint copies the eligible files in the folder. Subsequent checkpoints copy only new contents.
- **Restoration notes** are saved per role with the chat until that role receives them. They survive closing VS Code and return when the chat reopens.
