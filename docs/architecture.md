# Planned architecture

This document describes intended boundaries and responsibilities. Internal APIs were
still open at this stage. Their design depends on verifying the actual CLI protocols.
See [Open questions before implementation](requirements.md#open-questions-before-implementation).

## Components and boundaries

```text
┌───────────────────────── VS Code ─────────────────────────┐
│                                                           │
│  Webview (browser sandbox, Preact)                        │
│    thread rendering, input, approvals                     │
│        ▲  postMessage (typed and validated protocol)      │
│        ▼                                                  │
│  Extension host (apps/vscode)                             │
│    commands, panel, diffs, Workspace Trust,               │
│    storage, approvals UI                                  │
│        │  in-process TypeScript API                       │
│        ▼                                                  │
│  Orchestration runtime (packages/runtime)    [no vscode]  │
│    thread, leader, tasks, delegation, scheduling,         │
│    quotas, failover, persistent state                     │
│        │                                                  │
│        ▼                                                  │
│  Provider adapters (packages/adapters)       [no vscode]  │
│    official CLI child processes, stdio                    │
└────────┬──────────────────────────────────────────────────┘
         ▼
   codex / claude / agy  (official CLIs, user authentication)
         │
         ▼
   optional external tools (MCP, Graft, Basic Memory, ...)
```

### ChatGPT web bridge

The original proposal in [ADR 0009](decisions/0009-chatgpt-web-and-three-turn-layer.md)
used a ChatGPT web conversation outside VS Code and a clipboard bridge on window focus.
[ADR 0034](decisions/0034-remove-experimental-modes.md) removed the gateway. Users can
still paste briefs and copy results between the two chats, as described in
[ADR 0035](decisions/0035-handoff-tools-and-english.md).

```text
ChatGPT web ──(user clicks Copy)──► clipboard ──(focus, marker + ID)──► extension host
ChatGPT web ◄──(user pastes and sends)── clipboard ◄──(T3 response)──── extension host
```

- The proposed bridge used `vscode.env.clipboard` in the extension host. The runtime
  would receive the validated brief as data.
- The ChatGPT page was outside the bridge's read and write scope.

### Webview

- Source lives in `apps/vscode/webview/` and builds to `dist/webview/main.js`.
- It communicates only through `postMessage`, with no access to Node, the filesystem,
  the network, or CLIs.
- A restrictive CSP requires a nonce and disallows remote resources.
  `localResourceRoots` is limited to `dist/webview` and `media`.
- The host treats the Webview as **untrusted**. It validates each incoming message with
  `parseWebviewMessage` and discards unknown fields.

### Extension host

- Source lives in `apps/vscode/src/`. This is the only component that imports `vscode`.
- It adapts VS Code to the runtime by registering commands, managing the panel, opening
  diffs, checking Workspace Trust, persisting state where specified, and presenting
  approval requests.
- Orchestration logic lives in the runtime.
- **The leader chat** (ADR 0010) lives in `apps/vscode/src/session/`. `chat.ts` connects
  runtime `leader` mode to the adapters and turns runtime events into thread updates.
  `facts.ts` derives verified facts. Both files run without `vscode` and are tested
  against fake CLIs.
- **The panel** (`webview/panel.ts`) reads `onlyOneChat.*` settings and checks the folder,
  Workspace Trust, and consent.
- **The Webview** (`apps/vscode/webview/`) displays the header, thread, approvals, and
  input field.

### Orchestration runtime

- `packages/runtime` runs in Node without `vscode`. `tests/boundaries.test.ts` and ESLint
  enforce this boundary.
- Intended responsibilities include the thread model, roles (leader, backup, worker),
  task contracts, the task lifecycle, worker questions, parallel scheduling, quota status,
  transactional failover, checkpoints, and recovery.
- The bootstrap exposed only `getRuntimeInfo()`.

### Provider adapters

- `packages/adapters` runs in Node without `vscode`.
- Each adapter launches an **official CLI** as a child process and converts its protocol
  (stdio, JSON-RPC, or NDJSON) to runtime events.
- The CLI handles authentication and owns all credential access.
- At this stage, the adapters included the
  [Codex App Server client](codex-app-server.md) and a
  [session that verifies the ChatGPT subscription](codex-auth.md). The general adapter
  contract was still open.

### Persistent operational state

- Persist tasks, events, questions, checkpoints, and CLI session mappings.
- Persistence requires atomic writes (temporary file followed by rename), a versioned
  schema, and idempotent recovery.
- Storage candidates include `ExtensionContext.storageUri` (per workspace) and a
  dedicated local directory. Storing state in the user's repository requires opt-in.

### Permissions

- The runtime has one decision point for permissions. The host provides its UI.
- CLI approval requests flow through the adapter, runtime, host, and Webview. Responses
  follow the reverse path.
- See [security.md](security.md) for the policies.

### External tools

- The user configures MCP servers, Graft, Basic Memory, and skills. Provider CLIs or the
  runtime use them only when available.
- These tools are optional for the core.

## Repository layout

| Path                      | Content                                                            |
| ------------------------- | ------------------------------------------------------------------ |
| `apps/vscode/src/`        | Extension host (`extension.ts`, `commands/`, host-side `webview/`) |
| `apps/vscode/webview/`    | Webview browser code with a separate DOM and JSX tsconfig          |
| `apps/vscode/media/`      | CSS and static assets served to the Webview                        |
| `apps/vscode/test/unit/`  | Vitest unit tests outside the Extension Host                       |
| `apps/vscode/test/suite/` | Integration tests in the Extension Host                            |
| `packages/runtime/`       | Orchestration runtime                                              |
| `packages/adapters/`      | CLI adapters                                                       |
| `tests/`                  | Cross-package architecture tests                                   |
| `references/`             | Read-only reference sources outside version control                |

Internal packages expose their TypeScript sources directly and esbuild includes them in
the extension bundle. See [ADR 0003](decisions/0003-monorepo-layout.md).

## Deferred decisions

- Host–Webview protocol beyond the bootstrap messages (`ready`, `status`, `ping`, `pong`).
- Adapter interface and event model.
- Persistence engine, with JSON and JSONL files or SQLite as candidates. The bootstrap
  required running without a database.
- Git worktree support for workers.
