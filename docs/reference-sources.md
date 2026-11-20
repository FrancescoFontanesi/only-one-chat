# Reference sources

The repositories in `references/` are **for study only**. Git and the VSIX exclude
them, and the project does not install or execute them.
[ADR 0002](decisions/0002-reuse-policy.md) permits independent reimplementation of
ideas and patterns and rules out copying or translating code line by line.

`scripts/fetch-references.ps1` fetches commits pinned by SHA with no automatic
updates. The pins date to 2026-10-18.

| Name                      | URL                                                   | Commit                                     | License                            | Checkout            |
| ------------------------- | ----------------------------------------------------- | ------------------------------------------ | ---------------------------------- | ------------------- |
| usturlab                  | https://github.com/mdenesfe/usturlab                  | `2607aa8d1b0724a9083fc66b7d087522fe468ddf` | MIT, © 2026 Enes Demir             | Complete, 175 files |
| augani-agent-orchestrator | https://github.com/Augani/agent-orchestrator          | `8d9b897c49500e8e1b54ec8028352544db95618d` | MIT, © 2026 Augustus Otu           | Complete, 24 files  |
| codex-source              | https://github.com/openai/codex                       | `8d9f6466ff0294785d56f55b1fe363d132fe4133` | Apache-2.0 + NOTICE, © 2025 OpenAI | Sparse, 1806 files  |
| vscode-extension-samples  | https://github.com/microsoft/vscode-extension-samples | `65c1c44800eeac6fb065a54823ee5ae62c79540a` | MIT, © Microsoft Corporation       | Sparse, 73 files    |

## usturlab

A multi-provider VS Code extension built with TypeScript, pnpm, Preact, and esbuild.

**Areas to study**

- Extension structure in `packages/vscode/src/extension.ts`, `commands.ts`, and
  `esbuild.mjs`.
- Webview and UI in `packages/vscode/src/panel/chatViewProvider.ts`, `panel/protocol.ts`,
  `panel/transcript.ts`, and `packages/vscode/webview/` (Preact).
- Codex and Claude adapters in `packages/core/src/adapters/codex.ts` (JSON-RPC to
  app-server), `claude.ts` (NDJSON stream), `jsonRpc.ts`, `ndjson.ts`, `spawn.ts`, and
  `acp.ts`.
- Sessions and streaming in `packages/core/src/session/sessionStore.ts`.
- Authentication and profiles in `packages/core/src/accounts/` and
  `packages/vscode/src/onboarding/`.
- Quotas in `packages/core/src/quota/` (`codexUsageReader.ts` reads Codex rollouts,
  alongside `claudeUsagePoller.ts`) and `adapters/limits.ts` (detects `rate_limit_event`).
- Failover in `packages/core/src/orchestrator/orchestrator.ts`.
- Permissions in `packages/core/src/adapters/permission.ts` and
  `packages/vscode/src/permission/`.
- Realistic test fixtures in `packages/core/test/fixtures/*.ndjson`.

**Observed risks**

- Overly broad persistent permissions. `PermissionMemory` uses the first command token
  or just the request type as its key (`adapters/permission.ts:59-73`).
- Automatic Workspace Trust through `GEMINI_CLI_TRUST_WORKSPACE=true`
  (`adapters/gemini.ts:63`).
- Writes to the CLI profile (Gemini's `settings.json`) in `adapters/gemini.ts:32-52`.
- A "full" mode that passes `--dangerously-skip-permissions` (`adapters/claude.ts:21`).
- Nontransactional failover. It advances to the next target with partial output in
  memory and no persisted checkpoint (`orchestrator/orchestrator.ts:300-320`).
- The general-purpose router (`src/router/`) and OpenRouter support (a paid API) are
  outside this product's scope.

## augani-agent-orchestrator

A Codex orchestration plugin with Python, a skill, and a web dashboard.

**Areas to study**

- Task contract in `skills/orchestrate-cli-agents/references/task-contract.md`. Required
  sections are Objective, Why, Scope, Files to inspect, Implementation guidance,
  Constraints, Acceptance criteria, Validation, and Final report.
- Planning and delegation in `skills/orchestrate-cli-agents/SKILL.md` and
  `references/routing-and-plans.md`.
- Worker lifecycle, heartbeat, logs, and questions in `scripts/cli_agent_job.py`, with
  subcommands `launch`, `status`, `wait`, `logs`, `event`, `ask`, `questions`, `answer`,
  and `cancel` (`:3868-4240`).
- Persistent state and atomic writes in `write_json` (`cli_agent_job.py:540-551`).
- Worktrees and isolation in `workspace_mode` (defaults to `worktree`, `:512-520`).
- Review gate in `review_notes` (`:3433`).
- Local dashboard in `scripts/dashboard_server.py`, which listens on `127.0.0.1`
  and uses a random token.

**Risks and limitations**

- The plugin hardcodes Codex as coordinator and stores state in
  `~/.codex/agent-orchestrator` (`:491-499`). This project uses it only as a reference
  for behavior.
- The 163 KB Python script is monolithic. Study its design separately from its code.
- `cursor-guard` contains Cursor-specific hooks that deny subagents.

## codex-source

Public source for the Codex CLI (Rust), with a sparse checkout of
`codex-rs/app-server`, `codex-rs/app-server-protocol`, `codex-rs/docs`, `codex-rs/exec`,
`codex-rs/protocol`, `docs`, and `sdk`, plus root files including LICENSE and NOTICE.

**Areas to study**

- `codex-rs/app-server/README.md` describes the app-server JSON-RPC protocol for threads,
  turns, approvals, MCP, project trust, and rollback.
- `codex-rs/app-server-protocol/` contains the protocol types and is the authoritative
  source for the adapter.
- `codex-rs/protocol/` contains core events, tool calls, and approvals.
- `codex-rs/exec/` implements non-interactive mode. `codex-rs/exec/src/cli.rs:65` defines
  `codex exec --json`. `docs/exec.md` links to the online documentation.
- `sdk/typescript/` contains the official SDK that drives the CLI, including spawn and
  parsing patterns.
- `docs/authentication.md`, `docs/sandbox.md`, `docs/execpolicy.md`, and `docs/config.md`.

**Risks**

- The app-server protocol is evolving and has many experimental sections. Check the
  version during the handshake.
- Apache-2.0 would require retaining NOTICE and identifying modifications if code were
  reused. ADR 0002 rules out code reuse.
- The proprietary Codex VS Code extension serves only as a UX reference. Its source
  must remain unextracted and undecompiled.

## vscode-extension-samples

Sparse checkout of `helloworld-sample`, `helloworld-test-sample`,
`helloworld-test-cli-sample`, `webview-sample`, and `webview-view-sample`.

**Areas to study**

- `webview-sample/` demonstrates WebviewPanel, CSP with a nonce, `localResourceRoots`,
  and serialization.
- `webview-view-sample/` demonstrates a sidebar WebviewView as an alternative to an
  editor panel.
- `helloworld-test-cli-sample/` demonstrates integration tests with `@vscode/test-cli`,
  the approach used here.
- `helloworld-test-sample/` demonstrates the lower-level `@vscode/test-electron` runner.

**License.** The repository uses MIT. `webview-sample` and `webview-view-sample` also
declare MIT in their own `package.json` files. The three `helloworld-*` examples use the
repository's MIT license without a separate declaration. None of the examples includes
its own LICENSE file.

## Other potentially useful samples outside the checkout

The samples repository also includes `chat-sample`, `chat-tutorial`,
`custom-editor-sample`, `tree-view-sample`, and `webview-codicons-sample`. Add them to
the sparse checkout list in `fetch-references.ps1` as needed.
