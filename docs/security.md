# Initial security threat model

This model dates to the bootstrap. Future features must identify the threats they
affect and how they mitigate them.

## Mandatory rules

1. **Permission checks stay enabled by default.** This applies to
   `dangerously-skip-permissions` and equivalents such as `--yolo`, `bypassPermissions`,
   and `approval-policy never` with sandboxing disabled. Any future exception would
   require a visible, explicit opt-in per session, with no persistence.
2. **Paid APIs are excluded.** The extension leaves API keys unmanaged and pauses
   providers that run out of quota. It does not fall back to metered endpoints.
3. **The CLIs own credentials.** The extension leaves tokens and authentication files
   unread, uncopied, and unmodified (`~/.codex`, `~/.claude`, Antigravity profiles).
4. **Changes to the user's global CLI configuration require their knowledge.**
5. **Workspace Trust is respected.** The user controls whether a workspace is trusted.

## Assets to protect

- Credentials and sessions for the user's AI subscriptions.
- Workspace code and data.
- Operational state integrity (tasks and checkpoints).
- User quotas and budgets.
- Transcripts and logs, which may contain secrets.

## Threats and mitigations

### T1. Credential protection

- **Threat.** Token exfiltration or corruption, such as by an adapter that copies or logs
  tokens.
- **Mitigations.** Official CLIs handle authentication and retain exclusive access to
  credential files. Child processes receive an explicit allow-list of environment
  variables. Logs must redact secrets.
- **Reference finding.** usturlab rewrites `settings.json` in the CLI profile
  (`packages/core/src/adapters/gemini.ts:32-52`). This behavior is prohibited.

### T2. Process isolation

- **Threat.** A CLI or worker executes commands outside its scope.
- **Mitigations.** Keep native CLI sandboxes active, use an explicit working directory,
  and isolate workers that write in separate worktrees when possible. Use timeouts and
  cancellation, and clean up child processes on VS Code exit.

### T3. Workspace security

- **Threat.** Opening a malicious repository triggers automatic execution of agents or
  commands.
- **Mitigations.** Agent execution requires a trusted workspace. Loading workspace
  instructions, rules, and configuration also requires approval of their contents.
- **Bootstrap TODO.** When agent execution is introduced, change
  `capabilities.untrustedWorkspaces` in `apps/vscode/package.json` from `true` to
  `"limited"` or `false`.
- **Reference finding.** usturlab sets `GEMINI_CLI_TRUST_WORKSPACE=true`
  (`packages/core/src/adapters/gemini.ts:63`). This behavior is prohibited.

### T4. Prompt injection from files and worker output

- **Threat.** Repository content, web pages, tool output, and worker output can include
  hostile instructions, such as requests to ignore rules and run a command.
- **Mitigations.** Treat worker output as _data_ for review. Turning it into an instruction
  for the leader requires explicit framing. Permission requests from delegated tasks
  show their origin. Task contracts specify scope and allowed paths. Destructive actions
  always require user approval.

### T5. Command authorization

- **Threat.** An overly broad "allow always" rule authorizes dangerous commands.
- **Mitigations.** Scope approvals to a full command or explicit pattern, working
  directory, and session. Keep them visible and revocable. Exclude destructive commands
  from persistent approvals.
- **Reference finding.** usturlab's `PermissionMemory`
  (`packages/core/src/adapters/permission.ts:59-73`) keys commands on their first token
  (`git status` also authorizes `git push --force`) and keys other requests only on the
  type. Both scopes are too broad.

### T6. Webview protection

- **Threat.** XSS in the Webview could send arbitrary messages to the host.
- **Active mitigations.** The CSP uses `default-src 'none'`, requires a nonce for scripts,
  and omits `unsafe-inline`, `unsafe-eval`, and `connect-src`. The host restricts
  `localResourceRoots`, sets `enableForms: false` and `enableCommandUris: false`, and
  validates every message. Model-generated Markdown renders as Preact elements
  (`webview/markdown.tsx`). Literal HTML remains visible as text, and links outside the
  working folder display only their text. The only inserted markup is MathML generated
  from formulas by KaTeX with `trust: false` and size limits (ADR 0024).
- **Verification.** `apps/vscode/test/unit/html.test.ts` and `protocol.test.ts`.

### T7. Transcript and log persistence

- **Threat.** Transcripts and logs retain secrets or sensitive code in plaintext
  indefinitely.
- **Mitigations.** Use extension storage. Storing transcripts in the repository requires
  opt-in. Provide configurable retention, redaction of secret patterns, and deletion
  commands.

### T8. State integrity during crashes and failover

- **Threat.** A crash during a write or a failover during a task corrupts state, loses
  work, or executes it twice.
- **Mitigations.** Use atomic writes (temporary file followed by rename), a versioned
  schema, checkpoints before every handoff, and idempotent recovery. Flag uncertain task
  state for the user before any rerun.
- **Reference finding.** usturlab advances to the next failover target with the partial
  output in memory (`packages/core/src/orchestrator/orchestrator.ts:300-320`). It lacks a
  persisted checkpoint and a way to reconcile side effects of the interrupted attempt.
  Augani's atomic JSON writes (`cli_agent_job.py:540-551`) provide a pattern to study.

### T9. Unauthorized API costs

- **Threat.** An environment variable such as `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, or
  `GEMINI_API_KEY` switches a CLI to metered billing.
- **Mitigations.** Filter API keys from child process environments. Verify the CLI
  authentication mode before use and reject sessions without a subscription.
- **Active for Codex** as of milestone 1.2, with an environment allow-list, a dedicated
  profile, and a fail-closed gate on `account/read`. See [codex-auth.md](codex-auth.md).

### T10. Clipboard reads (ADR 0009)

- **Threats.**
  - The clipboard can contain passwords, tokens, and personal data. Continuous monitoring
    would expose them to the runtime or logs.
  - Copied text from a web page or document could contain the brief marker and trigger
    an unintended loop.
- **Monitoring mitigations.**
  - Read the clipboard once when the window receives focus, and only when the panel is
    open, the workspace is trusted, and monitoring is enabled.
  - Use focus events exclusively to avoid polling.
  - Keep the monitoring status visible in the panel.
  - Immediately discard text without the marker before logging or persistence.
- **Captured brief mitigations.**
  - Require confirmation if the project ID belongs to another project.
  - Limit brief size and validate it like any other untrusted message.
  - Treat the brief as a request for verification by the recipient, with user-level
    authority.
  - Notify the user when automatic mode captures a brief.

### T11. Agents launched from the panel (ADR 0010)

- **Threat.** The leader and implementer may write files and run commands on the user's
  machine from the panel.
- **Workspace mitigations.**
  - The first folder open in VS Code is the agent workspace boundary.
  - Agents start only if Workspace Trust marks that folder as trusted. The panel can
    still open in an untrusted workspace (`untrustedWorkspaces: limited`).
  - On the first request, a modal asks for consent for that folder.
- **Permission mitigations.**
  - Sandbox permissions apply (ADR 0008). Claude writes with `Edit(./**)` and runs the
    programs in `onlyOneChat.allowedCommands` without prompting. Codex writes with
    `workspace-write` and has no network access.
  - At level `auto`, Claude uses Claude Code's auto mode (ADR 0021). Claude Code's
    classifier handles operations that would otherwise prompt. The turn stops if the
    session reports a mode other than `auto` or `default`. `bypassPermissions` is
    prohibited.
  - `onlyOneChat.ignoredPaths` excludes paths from verified facts and checkpoints. It
    is restricted in untrusted folders because excluded files could hide changes from
    review.
  - The reviewer (ADR 0029) runs commands and writes tests in the folder with the same
    native CLI permissions as the implementer. To keep implementation code intact, the
    runtime snapshots the folder before each reviewer turn and restores every changed
    non-test file. If a snapshot is unavailable, the reviewer runs in read-only mode.
    Reviewer instructions have `machine` scope, as do instructions for other roles.
  - Other CLI approval requests are denied and shown to the user. R9 was pending at this
    stage.
  - Executable paths, allowed commands, and the verification command have `machine`
    scope, preventing repositories from setting them through workspace settings.
- **Webview mitigations.**
  - Validate each message from the Webview and enforce a 50,000-character limit.
  - Render model output as text.
- **Known limit.** An allowed command such as `python` retains all the capabilities of
  that program within the sandbox. Claude's `auto` level delegates decisions to a
  classifier. Choose `ask` for direct control. Test the extension in a separate folder
  with `pnpm playground`.

### T12. Interactive approvals (R9, ADR 0011)

- **Threats.**
  - A user grants approval accidentally or with too broad a scope.
  - A local process impersonates the Claude hook to approve itself.
- **Codex mitigations.** Requests arrive through the app-server protocol. Responses
  are `accept`, `acceptForSession`, or `decline`. Codex applies the session approval to
  the same request.
- **Claude mitigations.** A `PermissionRequest` hook supplied with `--settings` for the
  current turn contacts a bridge at 127.0.0.1.
  - The bridge listens only on localhost at a random port, requires a random 32-byte
    token per role and compares it in constant time, and accepts one line up to 1 MB.
  - Missing tokens, an unavailable bridge, missing or malformed responses, and timeouts
    all result in denial.
  - "For this session" applies only to the same tool with the same complete input.
    Program names and command prefixes are too broad (T5).
- **Shared mitigations.** Stopping a request denies any pending approval. Approval
  remains unavailable for requests other than commands or file edits, including sandbox
  permissions and MCP elicitation.
- **Known limit.** The token is in the environment of the Claude process and its
  commands. An already allowed command can read it and send a request to the bridge.
  The bridge still displays that request to the user, so the command can only use an
  existing session approval for an identical request.

### T13. Model catalog and role settings (ADR 0012)

- **Threats.**
  - Reading the model catalog could consume quota or access account data.
  - A choice from Roles could pass an arbitrary argument to the CLI.
- **Catalog read mitigations.**
  - Codex uses only `model/list` on the already filtered session, with the same
    denied methods and API keys removed from the environment.
  - Claude uses only the `initialize` control request in a temporary folder, without
    a user message or model turn. API keys are removed from the environment. Only model
    IDs, names, and effort levels are retained from the response. Account data is ignored.
- **Selection mitigations.** The view sends the CLI, model, reasoning, and permissions.
  Closed lists and a model pattern that disallows a leading `-` validate the values.
  The host rejects models absent from the loaded catalog and reasoning levels that a
  model does not support.
- **Settings page (ADR 0013).** Only the keys listed in `src/settings.ts` can be written,
  and each value is type-checked. CLI paths, allowed commands, the verification command,
  and role instructions have `machine` scope. This prevents workspace overrides,
  including through the settings page.

### T14. Review, restore, and file references (ADR 0014, 0015)

- **Threat.** The Webview causes a write, deletion, or read outside the workspace folder.
- **Mitigations.**
  - Reject and restore operate only on paths recorded in the chat checkpoint. The
    Webview names a file on the card and the host looks it up in that checkpoint.
  - The host rejects paths that resolve outside the workspace folder.
  - Agents receive `@` references only when the real path stays inside the folder
    after resolving links. Only short line ranges are copied.
  - Read diff contents from a read-only schema for valid hashes only.

## Supply-chain security at bootstrap

- Pin exact versions and use the lockfile (`pnpm install --frozen-lockfile`).
- pnpm blocks dependency installation scripts by default. `pnpm-workspace.yaml` records
  exceptions. At bootstrap, zero scripts were approved.
- Pin GitHub Actions by SHA, use `permissions: contents: read`, and keep secrets out
  of CI.
- Keep the repositories in `references/` uninstalled and unexecuted.
