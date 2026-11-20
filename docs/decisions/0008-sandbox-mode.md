# 0008. Sandbox mode for local tests with confined writes

Status: Accepted (iteration 2)

## Context

Agents have worked read-only so far, with all approval requests denied until R9 is implemented. The first code-writing test requires an agent to write files and test its code without manual approval at each step.

## Decision

Provide an explicit, opt-in **sandbox mode** for a new disposable working directory (`%LOCALAPPDATA%\only-one-chat\sandbox\<run>`) outside the repository and the user's profile.

- **Claude** adds `Write`, `Edit`, and `Bash` to `Read`, `Grep`, and `Glob` under `--permission-mode default`.
  - `--allowedTools` permits only `Edit(./**)` and allowlisted Bash commands such as `Bash(python *)` without prompting. The `Edit` rules also govern `Write`, limiting file edits to the working directory.
  - `--permission-prompts none` denies other requests that would need permission, including `rm`, `mv`, edits outside the working directory, and other programs. Read-only commands such as `ls`, `cat`, and `cd` within the working directory are allowed in every mode.
  - `PowerShell`, notebook tools, `WebFetch`, `WebSearch`, and MCP servers remain denied.
  - Stop the turn unless `init` reports `default`.
  - The first benchmark used `acceptEdits`, which also automatically approves `mkdir`, `touch`, `rm`, `rmdir`, `mv`, `cp`, and `sed` within the working directory. Opus used that permission to run `rm` on its own `parser.py`. The benchmark prompted this correction.
- **Codex** stays read-only (`sandbox: "read-only"`) when it plans, evaluates, or acts as a gateway.
  - For `calc-functions` (ADR 0009), the user approved relaxing the restriction. When Codex implements or works alone, the thread uses `workspace-write` in the run directory with network access disabled.
  - On Windows, the thread also requests the unelevated sandbox (`windows.sandbox = "unelevated"`), which requires no setup.
  - Verification with `command/exec` used no model turns. Python ran and wrote inside the working directory, while a write outside it failed with `PermissionError`.
  - Approval requests remain denied, and permission bypass modes stay disabled.
- **Automatic approval** of messages between agents is available only in the runtime's benchmark mode. It is explicit in the options, logged as an `auto_approve` decision, and visible in the thread.

## Consequences

- **Risk accepted by the user.** Claude runs model-written code on the user's machine. On Windows its processes have no operating-system sandbox, so an allowed command such as `python …` can exercise all of Python's capabilities. The `Edit` rules do not cover files that a script opens directly. The allowlist controls which programs can launch.
- This mode is for local tests with harmless tasks such as the demo calculator. The product's mediated approvals under R9 remain to be designed.
- User hooks such as rtk can rewrite Bash commands. A rewritten command that falls outside the allowlist is denied, and the test shows that denial.
