# 0021. Claude Code auto mode, ignored paths, and pending requests

Status: Accepted (iteration 3). Amends ADR 0011 for Claude's `auto` level and the Claude permissions provisions of ADR 0008.

## Context

- **The `auto` level requested too many approvals.** Claude used the sandbox in ADR 0008, which allowed `Edit(./**)` and the programs in `onlyOneChat.allowedCommands`. Everything else prompted the user or was denied. In a live trial, Sonnet was denied `cd … && rtk ls && rtk read …` because `rtk` was missing from the list. Claude Code's extension runs the same command without asking in auto mode.
- **Verified facts included files the agents did not touch.** A user hook (Graft) writes a workspace cache that the leader saw among the changed files. Users need to configure their own exclusions because their installed tools vary.
- **Permission levels could only be changed in the Squad role editor or settings.**
- **The Squad button counted pending requests,** but its panel opened only the first one and the rest of the UI gave no notice.

## Decision

1. **Claude's `auto` level uses Claude Code auto mode.** The turn starts with `--permission-mode auto` under the following controls.
   - The tool list includes Read, Grep, Glob, Write, Edit, and Bash. PowerShell, notebook, and network tools are excluded.
   - `Edit(./**)` and `Bash(<program> *)` rules apply before the classifier.
   - `--strict-mcp-config`, `--permission-prompts none`, and the permission hook (R9) still apply.

   Where a request would prompt, the Claude Code classifier decides, as in the extension. Claude Code disables auto mode if its subscription plan, model, fast mode, or settings make it unavailable. The session then reports `default`, the previous rules apply, and the thread records this once per session. Any other reported mode stops the turn.

   `bypassPermissions` and `--dangerously-skip-permissions` remain prohibited (AGENTS.md, rule 8). The `ask` level uses `default` and prompts for everything. Codex's `auto` continues to use `workspace-write` with `on-request`.

2. **Ignored paths.** `onlyOneChat.ignoredPaths` accepts `.gitignore`-style patterns. A bare name matches at any depth, `/` anchors a pattern, a trailing `/` identifies directories, and `*`, `?`, and `**` are supported. Negation with `!` is unsupported. The patterns apply to verified facts, checkpoints, and the changes card. The project's `.gitignore` is not consulted because review must still be able to expose changes to files such as `.env` and generated output. The setting is restricted in untrusted folders.
3. **Permissions on the dial.** The implementer's left dial includes a permissions selector (Read · Ask · Auto) next to handoff. Changes apply from the next turn, as with Squad. The leader stays read-only.
4. **Pending requests.**
   - Squad opens its "Pending" list when it contains permission requests, delegations awaiting delivery, or open questions.
   - The list lets the user allow a request, allow it for the session, or deny it, and send or cancel a delegation. A question or delegation that needs editing takes the user to the relevant point in the chat.
   - The top-right corner of the Squad button shows the number of requests.
   - When a request arrives, "Action required · Open Squad" appears above the composer for four seconds and opens the panel on click.
   - Requests also appear in the composer.

## Consequences

- Claude auto mode can authorize legitimate commands beyond the allowlist. The Claude Code classifier makes those decisions. Users who want to make each decision choose Ask.
- The classifier adds a model call for each uncertain action under the user's subscription.
- If auto mode is unavailable, the thread records the fallback to the previous behavior.
- An overly broad `ignoredPaths` pattern hides real changes from the leader and review. The default is empty.
