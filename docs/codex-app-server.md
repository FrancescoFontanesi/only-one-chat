# Codex App Server client

Milestone 1 implemented the connection, including startup, the handshake, requests,
notifications, errors, and shutdown of the full process tree. Verification used the
real Codex CLI 0.164.0. Threads, turns, and approvals were still pending at that stage.

The client lives in `packages/adapters/src/codex/` (`app-server.ts`, `executable.ts`,
`../process-tree.ts`). Tests are in `packages/adapters/test/` and the transcript
recorder is in `packages/adapters/dev/`.

## Verified protocol

| Aspect                | Behavior                                                                                                         | Source                                                                                                   |
| --------------------- | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Transport             | stdio (the default for `codex app-server`)                                                                       | Official documentation                                                                                   |
| Framing               | One JSON object per line, terminated by `\n` (JSONL)                                                             | Official documentation and `codex-rs/app-server/tests/suite/v2/connection_handling_stdio_tests.rs:72-86` |
| Version               | JSON-RPC 2.0 shapes without a `"jsonrpc"` field                                                                  | Documentation and `codex-rs/app-server-protocol/src/rpc.rs:1-2`                                          |
| ID                    | Integer or string                                                                                                | `rpc.rs:17-21`                                                                                           |
| Error                 | `{ id, error: { code, message, data? } }`                                                                        | `rpc.rs:76-88`                                                                                           |
| Handshake             | `initialize { clientInfo: { name, title?, version }, capabilities? }`, followed by an `initialized` notification | Documentation and `protocol/v1.rs:29-41`                                                                 |
| `initialize` response | `{ userAgent, codexHome, platformFamily, platformOs }`                                                           | `protocol/v1.rs:74-84`                                                                                   |
| Before the handshake  | "Not initialized" error. A second `initialize` yields "Already initialized".                                     | Documentation                                                                                            |
| Server requests       | The server can send requests such as `item/permissions/requestApproval` and waits for a response.                | Documentation                                                                                            |
| stderr                | Drain the pipe to prevent transport stalls when it fills.                                                        | `connection_handling_stdio_tests.rs:88-96`                                                               |
| Shutdown              | EOF on stdin initiates shutdown.                                                                                 | `connection_handling_stdio_tests.rs` (`Shutdown::Eof`)                                                   |
| Cancellation          | The protocol has no generic request cancellation.                                                                | Search of `app-server-protocol/src`                                                                      |
| Unknown method        | Error `-32600` "Invalid request: unknown variant …" (standard unknown-method code `-32601`).                     | 0.164.0 transcript (`startup.jsonl`)                                                                     |
| Notifications         | `emittedAtMs` (Unix milliseconds) is a sibling of `method` and `params`.                                         | 0.164.0 transcript and `protocol/common.rs:2101-2114`                                                    |
| After the handshake   | Unsolicited `remoteControl/status/changed` notification before later responses.                                  | 0.164.0 transcript                                                                                       |
| `userAgent`           | `<clientInfo.name>/<Codex version> (<os>; <arch>) <terminal> (<name>; <version>)`                                | 0.164.0 transcript                                                                                       |

The [official documentation](https://developers.openai.com/codex/app-server) redirected to
<https://learn.chatgpt.com/docs/app-server> when accessed on 2026-10-20.
[reference-sources.md](reference-sources.md) lists the pinned Codex source commit. The
usturlab sources (`packages/core/src/adapters/codex.ts`, `jsonRpc.ts`, `spawn.ts`) provided
background on npm shims and stderr. The implementation is original (ADR 0002).

## Client contract

- **Startup.** Spawn without a shell, set `windowsHide`, and pipe stdin, stdout, and
  stderr. `startAppServer` resolves only after `initialize` succeeds and the client
  sends `initialized`. Failure stops the process before rejecting.
- **Every request settles** with a result or one of `rpc`, `timeout` (default 60 s),
  `cancelled` (AbortSignal), `exited` (process exit), or `closed` (`close()` called).
- **Process exit.** Pending requests reject on the process `close` event, after stdout
  ends, so a response already written can still be read. Errors include the stderr tail.
- **Invalid lines** (malformed JSON, non-object values, messages with neither `method`
  nor `id`) and **unknown response IDs** are reported to `onProtocolError` and
  ignored. The connection remains usable.
- **Invalid response to a pending ID.** A response with neither a valid `result` nor a
  valid `error` immediately rejects that request as `protocol`.
- **Server requests.** `onServerRequest` handles them. The client replies `-32601`
  when the handler is absent and `-32603` if it throws, so the server never waits
  indefinitely.
- **Cancellation and timeout** are local because the protocol lacks generic cancellation.
  A late response is reported as an unknown ID.
- **`close()`** is idempotent and resolves once the process has exited and stdio has
  closed, or once cleanup finishes. Each step has `shutdownTimeoutMs` (default 5 s).
  1. Reject pending requests and close stdin (EOF) to initiate a clean shutdown.
  2. If Codex stays alive, terminate its process tree. On Windows, run
     `taskkill.exe /PID <pid> /T /F` from `SystemRoot` without a shell. On POSIX,
     send the process group `SIGTERM` and then `SIGKILL`. Codex starts in its own group.
  3. After exit, wait for stdio to close. If a descendant keeps the pipes open, send
     `SIGKILL` to the process group on POSIX. On Windows, find processes with
     `ParentProcessId` matching the Codex PID and created between Codex startup and exit,
     since that PID can be reassigned after exit. Run `taskkill /PID <pid> /T /F` for each
     match. Only this slow path runs `powershell.exe` from `SystemRoot` with
     `-NoProfile -NonInteractive`.
- **Reporting.** Forced termination calls `onForcedShutdown` with
  `{ reason: 'exit-timeout' | 'stdio-open', terminated, errors }`. Clean shutdowns skip
  the callback. A process that has exited with closed stdio requires no search or
  termination.
- **Environment.** The client defaults to `process.env` and leaves Codex configuration
  and credentials untouched.
- **`onWire`** receives every outbound message and every inbound JSON object in order,
  before redaction. The demo removed by ADR 0034 used it with `OOC_CODEX_TRACE` and
  wrote the output only after redaction and scanning.

## Executable resolution

`resolveCodexExecutable({ configuredPath?, env? })` uses these rules:

- A configured path must be absolute and point to an existing file, executable on POSIX.
- Otherwise, search `PATH` for `codex.exe` on Windows or `codex` on POSIX.
- Exclude private binaries bundled in VS Code extensions.
- On Windows, reject `.cmd`, `.bat`, and `.ps1`, including npm shims, because they
  require a shell. The error identifies the shim and asks for the native executable path.

## Tests

- **Fake server** (`test/fixtures/fake-app-server.mjs`). An independent Node process
  implements the documented framing and handshake plus several `test/*` methods. It
  writes through `fs.writeSync` to exercise real chunk fragmentation and pipe backpressure.
- **Real Codex** (`test/codex-app-server.real.test.ts`). Opt in with
  `CODEX_EXECUTABLE=<path to codex.exe>`. It uses a temporary `CODEX_HOME` without model
  calls. An installed version absent from the recorded fixtures produces a warning and
  a skip with the reason.
- **Real transcripts** (`test/fixtures/codex/<version>/*.jsonl`). The scenarios are
  `startup`, `custom-provider`, and `personal-startup` (read-only in the user's
  profile, with `config/read` limited to the provider). `dev/record-codex.ts`
  (`pnpm record:codex`, with the scenario set in `CODEX_RECORD_SCENARIO`) speaks the
  protocol independently of the client under test. It launches Codex through
  `prepareCodexLaunch`, as `connectCodex` does. Each file starts with a `meta` line
  containing the version, `userAgent`, date, and commands. The recordings use only
  interactions that consume no model quota. Redaction happens in memory, and the
  recorder skips writing a file if the scanner still finds anything.
  `test/fixtures-leaks.test.ts` repeats the scan for all fixtures.
- **Contract tests** (`test/codex-contract.test.ts`). Test client parsing and validation
  against real messages and verify fake-server parity. Replaying the recorded client
  messages against the fake must yield the same response shapes, error codes, and order.
  Differences require correcting the fake.
- **Real turn** (`question-turn.jsonl`). The mini-conversation Codex turn was recorded
  with the demo removed by ADR 0034. The comparison with the fake covers the fields
  consumed by the client (`thread/start` response, `turn/started`, `turn/completed`,
  `agentMessage`, and deltas). The real turn also has user hooks, MCP startup status,
  token usage, and rate limits, so the comparison is field-based.

## Rate limits

`account/rateLimits/read` with empty parameters reads `GET /wham/usage` and
`GET /wham/rate-limit-reset-credits` without consuming model quota
(`backend-client/src/client/rate_limit_resets.rs:73-85`,
`app-server/src/request_processors/account_processor.rs:1150-1190`, tag `rust-v0.164.0`).
Without login, it responds with `-32600` before any network access. Exclude
`supportsLunaReserve: true`, which records exposure to an experiment, and
`account/rateLimitResetCredit/consume`, whose `POST` spends a reset credit.

## Known limitations

- Windows requires the native `codex.exe` path when npm installs shims. TODO(adapters):
  evaluate resolving the shim to the npm package's native binary.
- Process tree termination has platform-specific limits.
  - After Codex exits on Windows, the search finds only its direct children and their
    subtrees. A grandchild whose parent has already exited is unreachable. If it
    retains the pipes, the client stops reading them, reports the condition in
    `errors`, and leaves the process running until the extension host exits and the
    libuv job object terminates it.
  - The Windows time window uses milliseconds as observed by Node. A recycled PID and
    its child created between actual exit and the `exit` event may pass the check.
  - On POSIX, a descendant that creates its own session or group with `setsid` leaves
    the original process group and becomes unreachable.
- When a living grandchild inherits stdout, the `close` event waits for its exit or for
  `close()` to terminate it. Pending requests time out in the meantime.
- `startAppServer` passes through the environment. Use `connectCodex` to remove API
  keys and apply account policy. See [codex-auth.md](codex-auth.md).
- The `initialize` response is validated only for `userAgent`, with no further version
  or schema checks.
