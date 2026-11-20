# 0027. Unified chat history and grouped recipient dial

Status: Accepted (iteration 3). Clarifies R5 (resuming a chat), ADR 0011 (role sessions), and ADR 0023 (nodes).

## Context

- **History failed to open chats.** The click reached the host, but closing the current chat waited for its CLIs to exit. Errors during webview message handling were invisible.
- **Nodes introduced multiple conversations.** The leader and implementer share one thread, and each node has another. This raised the question of whether history should be per agent.
- **The recipient dial presented roles and nodes as peers,** even though the implementer works under the leader.

## Decision

1. **Unified history.** An entry covers the whole chat, including the leader and implementer thread, node threads, CLI session IDs, providers, a pending brief, unread reports, and checkpoints. Nodes belong to the work represented by that chat.
2. **Entries show who worked.** Each shows the leader (LDR) and implementer (IMP) models, dimming roles that have never run, plus the names of the nodes that received messages.
3. **A selected chat opens immediately.** Its predecessor is already saved, and that chat's CLIs shut down in the background.
   - Sessions resume on demand, at the leader's first message, the implementer's first job, or a node's first message.
   - If the CLI session has been deleted or expired, a new session replaces it and the chat warns the user that prior conversation context is unavailable to the agent.
   - A webview message handling error appears as a notice in the chat.
4. **A removed node's thread stays readable.** For any chat that included it, the node appears after other nodes on the dial with its composer disabled.
5. **The recipient dial groups choices.** ADR 0028 supersedes this decision. A label selects the group and the ring selects its roles.

## Consequences

- Grouping history by day, searching by title, and moving node threads between chats are deferred.
- Claude resumes a session only at turn time (`--resume`). The fallback to a new session runs at session creation, so it covers Codex and ACP nodes. Claude is outside its current coverage.
