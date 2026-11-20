# Claude Code CLI adapter

Iteration 1 runs one read-only headless turn at a time in the user's personal profile.
See [ADR 0006](decisions/0006-personal-cli-profiles.md).

The adapter lives in `packages/adapters/src/claude/` (`turn.ts`, `executable.ts`). It
shares `src/environment.ts` and `src/process-tree.ts` with Codex.
`test/claude-turn.test.ts` uses `test/fixtures/fake-claude.mjs` to replay output
recorded from Claude Code 2.1.308 in `test/fixtures/claude/2.1.308/turn-ok.jsonl`.
The fixture is redacted and checked by `test/fixtures-leaks.test.ts`.

## Executable

`resolveClaudeExecutable({ configuredPath?, env? })` follows the Codex rules in
`src/executable.ts`. It uses a configured absolute path or looks for `claude.exe`
on Windows and `claude` on POSIX in `PATH`. It rejects `.cmd`, `.bat`, and `.ps1`
files and excludes binaries bundled with the VS Code extension or desktop app.
The adapter launches the executable without a shell.

The verification used Claude Code 2.1.308 (the `stable` channel) from
`https://downloads.claude.ai/claude-code-releases/2.1.308/win32-x64/claude.exe`.
Its SHA-256 digest
`c9796ba22a9221586b36371b36f5b66198d66eb4badf6a4cf4a5f7b07becea53` matched the
release `manifest.json`, and its Authenticode signature from "Anthropic, PBC" was
valid. The verification ran without `claude install`.

## Flags verified with `claude --help` 2.1.308

| Flag                                        | Purpose                                                           |
| ------------------------------------------- | ----------------------------------------------------------------- |
| `-p`                                        | Headless, non-interactive mode                                    |
| `--input-format stream-json`                | Send the prompt as a JSON message on stdin, avoiding argv quoting |
| `--output-format stream-json` + `--verbose` | Stream JSONL events, which requires `--verbose`                   |
| `--tools Read,Grep,Glob`                    | Enable only read and search tools                                 |
| `--disallowedTools Bash,PowerShell,Edit,…`  | Explicitly deny shell, write, edit, and network access            |
| `--strict-mcp-config`                       | Run without MCP servers, as described below                       |
| `--permission-prompts none`                 | Deny any action that would trigger a permission prompt            |
| `--permission-mode default`                 | Override `defaultMode` from the settings                          |
| `--model <alias>`, `--effort <level>`       | Load from configuration (`haiku` and `low` in iteration 1)        |
| `--append-system-prompt <text>`             | Pass role instructions from the runtime                           |
| `--resume <session id>`                     | Continue an earlier session                                       |

`--help` describes `--permission-prompts` as _"Who answers permission prompts with
--print: "host" (the SDK host or --permission-prompt-tool) or "none" (nobody: anything
that would prompt is denied automatically; the permission mode still decides everything
else)"_. The adapter passes the mode explicitly because the current mode still governs
operations that need no prompt. `--help` lists `acceptEdits`, `auto`,
`bypassPermissions`, `manual`, `dontAsk`, and `plan`. The CLI also accepts `default`
and rejects invented values. The `init` event reports `permissionMode: "default"`.
Reporting any other value stops the turn with `permission_mode`.

The adapter excludes `--dangerously-skip-permissions`,
`--allow-dangerously-skip-permissions`, `--permission-mode bypassPermissions`, and
`acceptEdits`. It preserves user settings and hooks such as rtk by omitting `--restricted`
and `--bare`.

The diagnostic turn showed that `--tools ""` still leaves the claude.ai MCP connectors
active, including the "Claude Docs" `create`, `update`, and `delete` tools that write
to an external service.

## Events

| Event (`type`/`subtype`) | Fields read                                                                  | Adapter output        |
| ------------------------ | ---------------------------------------------------------------------------- | --------------------- |
| `system` / `init`        | `session_id`, `model`, `apiKeySource`, `permissionMode`, `tools`             | `init` and validation |
| `rate_limit_event`       | `rate_limit_info` (`five_hour`, `seven_day`, `overageStatus`)                | `rate_limit`          |
| `assistant`              | `text` and `tool_use` blocks in `message.content`                            | `text`, `tool_use`    |
| `result`                 | `result`, `is_error`, `api_error_status`, `session_id`, `permission_denials` | Turn outcome          |
| Other                    | —                                                                            | `other`               |

The stream emits assistant messages when complete. Text deltas would require
`--include-partial-messages`, which the real CLI fixture did not record and the
adapter leaves disabled.

The `init` event arrives only after the first message on stdin. The verification
observed no events in 12 s without a prompt. This is why billing checks also run
before the turn.

## Billing checks

1. The adapter runs `claude auth status --json` before the turn without consuming quota.
   The turn requires `loggedIn: true`, `apiProvider: "firstParty"`, and
   `authMethod: "claude.ai"`. Otherwise it returns `ClaudeError` `not_logged_in`,
   `unsupported_provider` (separately billed providers such as Bedrock and Vertex), or
   `api_key` without sending the prompt. Users log in from a terminal with
   `claude auth login`.
2. A custom `ANTHROPIC_BASE_URL`, including a proxy, makes the subscription unverifiable.
   The adapter returns `provider_not_verified` unless `allowUnverifiedProvider` is
   enabled, in which case it reports `billing: "unverified_provider"`.
   `isOfficialAnthropicUrl` accepts the official `https://api.anthropic.com` endpoint
   with or without a trailing slash. A different port, a path, credentials, or a query
   makes it custom.
3. The `init` event must report `apiKeySource: "none"`. Otherwise, the adapter immediately
   terminates the process tree and rejects the turn with `api_key`.

## Usage limit (429)

When the subscription quota is exhausted, Claude responds without inference
(`<synthetic>` model, zero cost). It sends `rate_limit_event` with
`status: "rejected"` and a `result` with `is_error: true`, `api_error_status: 429`,
`api_error: "usage_limit_reached"`, and the CLI message, such as "You've hit your session
limit · resets 1:50pm". The agent returns `ClaudeError` `usage_limit` with a clear
message and makes no retry. The loop stops with `failed`. The redacted recording is
`turn-usage-limit.jsonl`.

## Sandbox mode

With `sandbox: { commands: ['python'] }` ([ADR 0008](decisions/0008-sandbox-mode.md)),
the turn adds `Write`, `Edit`, and `Bash` and keeps `--permission-mode default`.
It preapproves only `Edit(./**)` (edits under the working folder, including `Write`)
and `Bash(python *)`. It denies PowerShell, notebooks, and network access.
`--permission-prompts none` denies all other operations that would prompt, including
`rm`, `mv`, and edits elsewhere. Read-only commands in the working folder, such as
`ls`, `cat`, and `cd`, are allowed. `acceptEdits` is excluded because it would also
preapprove `rm`, `mv`, `cp`, and `sed` in the folder. Sandbox mode requires an
explicit configuration.

## Subagents

When the runtime supplies a policy, the adapter adds `Agent` (reported as `Task` in
`init`) and `--forward-subagent-text`. It enforces the model, effort, and depth through
the child process environment. The real stream (`turn-subagent.jsonl`) includes the
`Agent` `tool_use`, subagent messages with `parent_tool_use_id`, `agent_id`, and
`subagent_type`, the `system` events `task_started`, `task_progress`, `task_updated`,
and `task_notification`, and the final `tool_result`. See [subagents.md](subagents.md)
for details and verification.

## Identity label

Each response carries the identity observed by the adapter. The runtime labels it with
`Claude Code`, the `model` from `init` (for example `claude-haiku-5-5`), the effort
passed to the CLI, and the session ID.

## Environment, working directory, session, and termination

- The adapter preserves the user's environment including base URLs and proxies, except
  for API keys filtered by `src/environment.ts`.
- `cwd` is the workspace. `init` and `result` provide the session ID.
- `stop()` is idempotent. It terminates the whole tree with `taskkill /T /F` on Windows
  or a process group on POSIX, where Claude starts `detached`. The turn rejects with
  `stopped`.
- The adapter closes stdin after `result`. `done` resolves only after the process
  exits. The adapter kills the tree after `shutdownTimeoutMs` (default 5 s).

## Known limitations

- A base URL set only in the `env` section of Claude settings is invisible to the
  adapter. `init` omits it, and the adapter leaves configuration files unopened.
  `apiKeySource` and `auth status` remain the effective checks.
- `total_cost_usd` in `result` is a nominal estimate even for subscriptions.
- With `--resume`, `total_cost_usd` and `modelUsage` accumulate over the session. The
  2.1.277 documentation describes "Accumulate costs across multiple calls", and
  verification observed it in 2.1.308. The adapter reports each turn as the difference
  from the previous one.
- The `init` check runs after the first prompt. It can interrupt the active turn and
  protect later ones. `auth status` is the preventive check.
- Sessions persist in the user's profile to support `--resume`. The adapter omits
  `--no-session-persistence`.
- `claude doctor` reports that auto-update is enabled. A manually selected binary
  may update itself.
