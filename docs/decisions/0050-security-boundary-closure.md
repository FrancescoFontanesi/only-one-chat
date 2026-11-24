# 0050. Closing the security boundary for v0.1

Status: Accepted.

## Context

The v0.1 audit and ADR 0049 left the security boundary as the last open work
before the release, with these gaps:

- "For the session" approvals had no exception for destructive commands. On
  Antigravity they were sent as ACP `allow_always`, whose lifetime agy decides.
  Claude's approvals could be neither listed nor revoked.
- The reviewer, the nodes and the sub-agents took their models from the
  settings without the pattern of the views. A workspace's settings could pass
  `--dangerously-skip-permissions` as Claude's `--model`.
- The host's checks had no tests: the Workspace Trust gate, the consent, the
  webview options, the settings writer, and the manifest's scopes.
- `docs/security.md` diverged from the code in 15 places. It also had no section
  on Antigravity or on the handoff server.
- ADR 0018 left a `TODO(security)` on Codex's read-only confinement on Windows.

## Decision

1. **A closed list of destructive commands**, in the pure module
   `packages/adapters/src/destructive.ts` (`isDestructiveCommand`,
   `isDestructiveRequest`). It covers:
   - deletions: `rm`, `rmdir`, `del`, `erase`, `Remove-Item`, `Clear-Content`,
     `shred`, `unlink`, `format`;
   - history rewrites: `git push --force` and its forms, `git reset --hard`,
     `git clean`, `git checkout --`, `git restore`, `git branch -D`,
     `git rebase`, `git filter-branch` and `git filter-repo`;
   - permissions, processes and disks: `chmod`, `chown`, `icacls`, `takeown`,
     `dd`, `mkfs`, `diskpart`, `reg delete`, `Stop-Process`, `kill`, `taskkill`;
   - data and publication: `DROP TABLE`, `DROP DATABASE`, `DROP SCHEMA`,
     `TRUNCATE TABLE`, `npm publish`, `pnpm publish`.

   A program counts only in command position, so `npm run format`,
   `format_price()` and `git branch -d` do not. Claude is classified on the
   tool's structured input, Codex and ACP on the request's text.

2. **`auto` stays as it is.** Inside the workspace the CLI's sandbox and the
   checkpoints govern it. A destructive command that is put to the user never
   offers "for the session". The approval request carries `sessionAllowed:
false`, the webview hides the option and its key, and the choice is enforced
   in three places, all turning `acceptForSession` into a single `accept`:
   - `UserRequests` and `NodeSession` on the host;
   - the Claude bridge, which also keeps nothing;
   - the Codex adapter.
3. **Codex keeps its own session approvals** in its thread, but never for a
   destructive command. They cannot be listed one by one and end with the session.
4. **ACP never gets "for the session".** Every request carries `sessionAllowed:
false`, and `acpOption` picks `allow_once` for both `accept` and
   `acceptForSession`, never `allow_always`.
5. **Claude's session approvals are listed and revocable.**
   - `PermissionBridge` gains `list()`, `revoke(key)` and `clear()`, and a callback
     when they change. None of them closes the bridge.
   - `ChatSession` and `NodeSession` expose `approvals()` and `revokeApproval()`.
   - The panel sends them as `approvals`, and takes `revokeApproval` for one or
     for all; both are validated in `shared/approvals.ts`. Each approval names its
     owner's kind (`ownerKind: 'role' | 'node'`) as well as its name, so a node
     whose id is `implementer` never shares the role's approvals or revocations.
   - `webview/Approvals.tsx` shows the count under the usage dial (`Hud.tsx`)
     while there are any. It opens to the list, with one revocation per approval
     and one for all.
6. **Every model from the settings is checked.**
   - Reviewer, nodes and sub-agents pass `isModel`, which needs an alphanumeric
     first character and no spaces or control characters. The pattern does not
     grow to allow `[` or `]`.
   - Reviewer and nodes are also checked against the catalog once it is read. The
     sub-agents are checked on the pattern alone: their defaults are full ids
     that the catalogs, made of the main models' aliases, need not list.
   - A value set aside falls back to its default only when the CLI's catalog is
     read and offers it, else to the CLI's own model, with one warning per value
     (`ModelCatalog.settled`, `session/setting-choices.ts`, `nodesOf`). A default
     belongs to a setting, not to a CLI: `haiku` never reaches a Codex reviewer.
7. **The host's checks are pure functions** in
   `apps/vscode/src/webview/security-gates.ts`:
   - `agentsGate` and `consentQuestion`;
   - `webviewOptions`;
   - `isUserOnly`, `writeRefusal` and `checkedValue`.

   Each has unit tests. `manifest.test.ts` checks:
   - the `machine` scope of every path, command and instructions setting;
   - `untrustedWorkspaces: "limited"`, with its restricted settings;
   - that every key on the settings page is declared in the manifest.

8. **`docs/security.md` follows the code.** Its 15 divergences are rewritten. It
   adds T15 (Antigravity over ACP) and T16 (the handoff server `ooc`). What it
   declares without an implementation moves to "Known limits and security
   backlog (post-v0.1)":
   - log redaction;
   - event log retention;
   - approval of workspace instructions;
   - clipboard monitoring;
   - process cleanup at exit;
   - worktrees.
9. **ADR 0018's `TODO(security)` is closed** with a live probe. One Codex turn
   ran on Windows with the leader's configuration (`sandbox: 'read-only'`,
   `approvalPolicy: 'never'`):
   - reading `seed.txt` succeeded;
   - PowerShell writes inside and outside the folder failed with
     `PermissionDenied`, and no file was created.

## Consequences

- A destructive request costs one click each time.
- Claude's session approvals stay revocable while the chat runs, without
  reopening the session.
- On Antigravity, an approval is always one request.
- A workspace's settings can no longer put a CLI option in a model's place.
- The panel's checks and the manifest's scopes fail a test when they regress,
  with no Extension Host needed.
- `security.md` states what holds today, and its backlog what does not.

## Limits

- The destructive list is a heuristic on text. A command built at run time, or
  one inside a script that a command runs, is not seen.
- Codex is classified on the approval's summary, which joins the command and
  Codex's `reason`. A reason that names a destructive command marks the request
  destructive too: an error on the safe side.
- The sub-agents' models are checked on the pattern alone (`isModel`), not on
  the catalog.
- Codex's session approvals cannot be listed. They are only cleared when its
  session ends.
- The probe checked one write channel (PowerShell) in the leader's configuration.
  Two cases are not verified:
  - `apply_patch`;
  - a read-only implementer or node (`approvalPolicy: 'on-request'`).
- `Approvals.tsx` and the hidden "for the session" option were checked by type
  and unit tests only. Seeing and clicking them in a real VS Code is a manual
  check, not yet done.
