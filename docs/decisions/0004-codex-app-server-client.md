# 0004. Codex App Server client over stdio

- Status: Accepted (2026-10-20)

## Context

The first adapter talks to `codex app-server`. See the protocol details and sources in [../codex-app-server.md](../codex-app-server.md).

## Decision

1. **Use stdio with JSONL framing.** The documentation identifies it as the only nonexperimental transport. WebSocket and Unix sockets are out of scope.
2. **Use `spawn` to launch the native executable directly.** Reject `.cmd`, `.bat`, and `.ps1` shims to avoid quoting and injection issues from invoking them through `cmd.exe` (CVE-2024-27980).
3. **Keep transport and protocol in one module.** Tests exercise both together over real pipes.
4. **Settle every request.** Reject pending requests on the process's `close` event, after stdout ends. The `exit` event can occur while stdout still has data.
5. **Report invalid lines and unknown IDs to `onProtocolError`.** These errors are recoverable. Process termination and `close()` end the session.
6. **Use built-in modules only.** The client uses `node:child_process`, `node:readline`, and `node:fs`.

## Consequences

- On Windows, users who installed the CLI through npm must point the client at the native `codex.exe`.
- Before running real turns, the adapter needs environment filtering and process tree termination.

## Note on process tree termination (2026-10-25)

Testing with Codex 0.164.0 showed that `codex app-server` exits cleanly immediately after EOF but can leave child processes alive with its pipes open. The observed child was `git` during plugin synchronization. The `close()` contract changes as follows.

- `close()` resolves when the process has exited and its stdio has closed, or once cleanup finishes. Previously, it resolved when the direct child exited.
- If Codex is still running after `shutdownTimeoutMs`, terminate the live process tree (Windows `taskkill /T /F`, POSIX process group). If it has exited and the pipes are still open, terminate its descendants (on Windows, find children by `ParentProcessId` created between launch and exit, and on POSIX, use the process group).
- On POSIX, launch Codex as `detached` to give it its own process group. On Windows, keep it in the libuv job object.
- Report every forced termination through `onForcedShutdown`. Shutdown remains idempotent and follows the sequence EOF, clean exit, then forced termination.

See details and remaining limitations in [../codex-app-server.md](../codex-app-server.md).
