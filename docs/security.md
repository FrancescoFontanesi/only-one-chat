# Security threat model

Written at the bootstrap and aligned with the code by ADR 0050. Future features must
identify the threats they affect and how they mitigate them. What is declared but not
implemented is listed under [Known limits and security backlog](#known-limits-and-security-backlog-post-v01).

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
  credential files. Child processes inherit the extension host's environment minus a
  deny-list of API key variables (ADR 0006, `packages/adapters/src/environment.ts`), so
  a CLI cannot switch to metered billing. Logs are not redacted (see the backlog).
- **Reference finding.** usturlab rewrites `settings.json` in the CLI profile
  (`packages/core/src/adapters/gemini.ts:32-52`). This behavior is prohibited.

### T2. Process isolation

- **Threat.** A CLI or worker executes commands outside its scope.
- **Mitigations.** Keep native CLI sandboxes active and use an explicit working
  directory. Stop ends a turn: Claude's process tree is killed, Codex is interrupted.
  Closing the panel closes the sessions and their processes. Worktrees for workers that
  write, and a cleanup in `deactivate` itself, are in the backlog.
- **Codex read-only on Windows (ADR 0018, 0050).** A live probe ran one turn with the
  leader's configuration (`sandbox: 'read-only'`, `approvalPolicy: 'never'`). Reading a
  file in the folder succeeded. PowerShell writes inside and outside the folder failed
  with `PermissionDenied`, and no file was created. Not verified: `apply_patch`, and a
  read-only implementer or node (`approvalPolicy: 'on-request'`).

### T3. Workspace security

- **Threat.** Opening a malicious repository triggers automatic execution of agents or
  commands.
- **Mitigations.** Agent execution requires a trusted workspace, and no CLI starts in an
  untrusted one, not even to list its skills (ADR 0050). `capabilities.untrustedWorkspaces`
  is `"limited"`: the panel opens, no agent runs, and the settings that name programs,
  commands or ignored paths are restricted. The CLIs load the workspace's own
  instructions and configuration (`AGENTS.md`, `CLAUDE.md`, `.claude/`) themselves; Workspace
  Trust is the only gate on them. Approving their contents is in the backlog.
- **Verification.** `apps/vscode/test/unit/security-gates.test.ts`, `manifest.test.ts`,
  `skills.test.ts`.
- **Reference finding.** usturlab sets `GEMINI_CLI_TRUST_WORKSPACE=true`
  (`packages/core/src/adapters/gemini.ts:63`). This behavior is prohibited.

### T4. Prompt injection from files and worker output

- **Threat.** Repository content, web pages, tool output, and worker output can include
  hostile instructions, such as requests to ignore rules and run a command.
- **Mitigations.** Treat worker output as _data_ for review. Turning it into an instruction
  for the leader requires explicit framing. Permission requests from delegated tasks
  show their origin. Task contracts specify scope and allowed paths; files changed outside them are
  reported after the turn, not prevented. Destructive actions are not always put to the
  user: see T5.

### T5. Command authorization

- **Threat.** An overly broad "allow always" rule authorizes dangerous commands.
- **Mitigations (ADR 0050).**
  - In `auto`, the operations inside the workspace are governed by the CLI's sandbox and
    by the checkpoints, which can put each file back; they are not put to the user one by
    one, destructive ones included.
  - For every request that is put to the user, a command of the closed destructive list
    (`packages/adapters/src/destructive.ts`: deletions, history rewrites such as
    `git push --force` or `git reset --hard`, permission and process changes, `DROP TABLE`,
    `npm publish`) never offers "for the session": the button is hidden, and the host and
    the adapter turn an `acceptForSession` into a single `accept`.
  - Claude's session approvals match the same tool with the same complete input. They are
    listed under the usage dial and revocable one by one or all at once, on the open
    bridge. Codex keeps its own session approvals inside its thread: they cannot be
    listed one by one and end when the session closes or the chat is reset. Antigravity
    is never given "for the session" (T15).
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
- **Mitigations.** Transcripts, checkpoints and event logs live in the extension's
  storage, never in the repository. Deleting a chat removes its history and its
  checkpoints. The JSONL event logs (`globalStorage/logs`) are kept and not redacted:
  retention and redaction are in the backlog.

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
- **Active for Codex** with the environment deny-list, the user's own profile (ADR 0006
  replaced the dedicated one of ADR 0005), and a fail-closed gate on `account/read`. See
  [codex-auth.md](codex-auth.md). Claude must report `apiKeySource: none` before a turn.

### T10. Clipboard reads (ADR 0009)

Not implemented: the extension never reads the clipboard; it only writes to it. The
mitigations below stay as the requirements of that feature, listed in the backlog.

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
    `workspace-write`; network access is not set by the extension, so Codex's own default
    for that sandbox applies.
  - At level `auto`, Claude uses Claude Code's auto mode (ADR 0021). Claude Code's
    classifier handles operations that would otherwise prompt. The turn stops if the
    session reports a mode other than `auto` or `default`. `bypassPermissions` is
    prohibited.
  - `onlyOneChat.ignoredPaths` excludes paths from verified facts and checkpoints. It
    is restricted in untrusted folders because excluded files could hide changes from
    review.
  - The reviewer (ADR 0029) runs commands and writes tests in the folder at level `auto`,
    whatever its settings say, when the folder can be recorded; without that record at the
    start of the review it runs read-only. The runtime snapshots the folder before each
    reviewer turn and restores every changed non-test file. A later snapshot that fails
    stops the review before the reviewer's turn starts, with a warning (fail-closed).
    Reviewer instructions have `machine` scope, as do instructions for other roles.
  - Approval requests reach the user as in T12.
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
  permissions and MCP elicitation, with one exception: the calls to the extension's own
  handoff server `ooc` are accepted without asking (T16). Destructive commands are never
  approved for the session (T5).
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
  model does not support. The models read from the settings (leader, implementer,
  reviewer, nodes, sub-agents) pass the same pattern, and the catalog once read (not for
  the sub-agents' full ids); one set aside falls back to its default when the read catalog offers it, else to the CLI's own,
  with a warning (ADR 0049 commit 0A, ADR 0050).
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

### T15. Antigravity over ACP (ADR 0023)

- **Threat.** A node on Antigravity acts in the folder with agy's own rules, which the
  extension cannot inspect.
- **Mitigations.** Antigravity runs only as a node on Squad: no delegation, review or
  checkpoint of its work. A read-only node declines every permission request. Its answers
  never pick `allow_always`, whose lifetime agy decides: "for the session" is not offered
  and counts as once (ADR 0050). Its environment has no API keys.
- **Known limit.** Read-only is enforced only on what agy asks; ACP gives no sandbox of
  its own. agy's own approvals and sub-agents are not limited by the extension.

### T16. The handoff MCP server `ooc` (ADR 0035)

- **Threat.** A tool call between roles becomes a channel to run actions without the user.
- **Mitigations.** The server runs as its own process from the extension's bundle, with
  only the handoff tools of the role (`delegate`, `report`, `findings`, `review`), and
  validates each call against its schema. Its calls have no effect outside the chat, so
  Codex's elicitation for `ooc` and Antigravity's permission for it are accepted without
  asking, also in read-only roles. The runtime reads their content as data, framed for
  the role that receives it.

## Known limits and security backlog (post-v0.1)

Declared above as requirements, not implemented; kept here so they stay traceable.

- **Log redaction (T1, T7).** Event logs and transcripts keep secrets as written.
- **Event log retention (T7).** No setting or command deletes the JSONL logs.
- **Approval of workspace instructions (T3).** The CLIs load them under Workspace Trust only.
- **Clipboard monitoring (T10).** Not built; its mitigations apply if it is.
- **Process cleanup at VS Code exit (T2).** Relies on the panel's disposal.
- **Worktrees for writing workers (T2).** Waits for parallel workers (R6).
- **Codex read-only confinement (T2).** Verified for PowerShell writes in the leader's
  configuration only.

## Supply-chain security at bootstrap

- Pin exact versions and use the lockfile (`pnpm install --frozen-lockfile`).
- pnpm blocks dependency installation scripts by default. `pnpm-workspace.yaml` records
  exceptions. At bootstrap, zero scripts were approved.
- Pin GitHub Actions by SHA, use `permissions: contents: read`, and keep secrets out
  of CI.
- Keep the repositories in `references/` uninstalled and unexecuted.
