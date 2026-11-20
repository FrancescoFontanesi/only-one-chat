# 0037. Persist implementer handoffs until the replacement session is resumable

Status: Accepted.

## Context

[ADR 0017](0017-implementer-handoff.md) lets the user start a fresh implementer session with a
summary written by the previous one. The original implementation clears the old CLI session ID
and keeps the summary in memory. Closing the chat before the next request loses the summary.
Opening the replacement session can also fail after the summary has already been cleared.

## Decision

1. Store the pending handoff in the existing chat record. Save the summary and remove the old
   implementer session ID in one atomic write before closing that session. An empty summary,
   a summary over 32,768 characters, or a failed write leaves the old session available.
2. On reopen, a valid pending handoff takes precedence over a stale implementer session ID.
   Older records can omit the field. Invalid field values are ignored.
3. Put the summary in the implementer's work prompt as framed background data. Use the existing
   worker-answer delimiters, neutralize delimiters in the summary, and preserve the precedence of
   the role instructions and the current request. Deliver it for direct messages and delegated
   work. A request to hand off again while one is pending leaves the pending handoff in place.
4. Consume the handoff only when a work turn completes, the CLI reports a nonempty replacement
   session ID, and the extension saves that ID and clears the summary in one atomic write.
   Keep it pending when session startup, a work turn, or saving the new ID fails. Recovery waits
   for a user request. The extension never replays the interrupted request automatically.

5. Stop during session startup prevents dispatch of the work turn. A Codex transport exit
   ends any unfinished turn. The next explicit request opens a new implementer connection
   and can use the pending handoff.

## Consequences

- A pending summary survives closing the chat, restarting the extension, and an unsuccessful
  first attempt to use it.
- Changes the interrupted turn already made are handled by the existing checkpoint and review
  flow. Provider switching and automatic failover remain outside this decision.

## Completion criteria

- Tests with fake CLIs verify the normal transition, reopen and resume, startup failure, an
  interrupted first turn, a failed save, and successful consumption after a direct or delegated
  turn.
- Tests cover malformed or oversized stored values, a stale session ID next to a valid summary,
  and delimiter text in a summary.
- Tests cover Stop during direct and delegated startup, Codex process exits before and after
  turn acknowledgment, a blank replacement ID, and a failed atomic replacement of a saved record.
- `pnpm check` and `pnpm test:e2e` pass.
