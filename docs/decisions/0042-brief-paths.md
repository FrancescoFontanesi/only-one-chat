# 0042. Brief paths: the files a delegation may change, checked per turn

Status: Accepted.

## Context

A brief's boundaries are text today. `delegate` has `scope` and `stop_if`, two
free strings; the leader prompt suggests "touching files outside the Context"
as a stop condition, and the reviewer counts a violated boundary as blocking.
Nothing compares the files the implementer changed with what the brief allowed.
The checks on the diff (`diffChecks` in `apps/vscode/src/session/chat.ts`) look
for weakened tests and risks, not for files out of place.

The implementer keeps the write access its CLI's own mode gives it in the
workspace. This ADR adds no permission layer. Since
[ADR 0041](0041-runtime-evidence-before-review.md) the facts list the files each
implementer turn changed, with `added`, `modified` or `deleted`. That is what a
mechanical check needs.

## Decision

1. **An optional `paths` field in `delegate`.**
   - It is a list of workspace-relative paths, with `minItems: 1` when present.
   - The schema rejects an entry that could never match a changed file:
     - a comment (parentheses, an em dash, a colon);
     - an absolute path;
     - a `..` segment.

     The leader fixes it in the same turn.

   - An entry ending with `/` is a folder and covers everything under it. Any
     other entry is a file, or a folder written without its slash.
   - Absent, nothing is checked, as today.
   - The leader prompt asks for it when the work belongs to a definite part of
     the project. It is optional on purpose: a required field would push the
     leader to write prefixes broad enough to mean nothing.
2. **The brief carries it as text.** `paths` renders as a `Paths` section of
   bullets, and the check reads it back from the brief, as the criteria are
   read. The user can edit it before the brief is sent, like the rest of the
   brief ([ADR 0031](0031-role-contract-and-brief.md)).
3. **Each implementer turn is compared with it.**
   - **The rule:** a file changed in that turn and outside every entry is a
     contract issue, `scope-exceeded`, on the report. The reviewer gets it in
     its facts, and the leader when there is no reviewer.
   - **New test files are allowed anywhere.** Otherwise the leader would have
     to guess where tests go.
   - **Existing test files are not:** a test modified or deleted outside the
     paths is an issue like any other file. Changing an existing test is how a
     check gets weakened.
   - **Ignored files never reach the check.** `ignoredPaths`
     ([ADR 0021](0021-auto-mode-ignored-paths-waiting.md)) are left out when the snapshots are
     taken, in `facts.ts`, so the check does not repeat that rule.
4. **Evidence, not enforcement.**
   - The runtime does not send the work back, block it or undo it. A file
     outside the paths may be a legitimate support file.
   - The reviewer judges it. Its prompt already counts a violated boundary as
     blocking, unless the report's `decisions` justify it. One sentence adds
     that the runtime flags files outside the paths.
5. **The test-file rule has one home.** `isTestFile`, today in
   `apps/vscode/src/session/shortcuts.ts`, moves to `packages/runtime`, which
   the check needs. The extension imports it from there.

## Budget

- **Code:** about 120 lines of production code, plus tests:
  - the schema and the brief rendering in `handoff.ts`;
  - the check in `contract.ts`;
  - the move of `isTestFile`.
- **Prompts:** one sentence in `leader.md`, one in `reviewer.md`.
- **No dependency,** no setting, no change to permissions or to the persisted
  task record.
- **Visible to the user:** a `Paths` section in briefs that have one, and
  `scope-exceeded` issues in the thread.
- **Out of scope:**
  - glob patterns;
  - blocking or undoing changes;
  - the implementer session's lifecycle;
  - references in the brief.

## Consequences

- **The reviewer and the leader see mechanically which files left the
  delegation's paths,** turn by turn, instead of inferring it from the diff.
- **A brief without paths behaves as before.**
- **A leader that writes paths too narrow produces issues** the reviewer has to
  weigh. Prefixes keep the field easy to write correctly.

## Live check

Two runs of a local bench scenario on 2026-11-22: leader Claude Sonnet 5.5 low,
implementer Claude Sonnet 5.5 low, reviewer Claude Haiku 5.5 medium. The request
said that the work stays in `wc.py`, `textstats.py` and the test files. Codex was
out of quota, and the check does not depend on the leader.

- **The leader filled `paths` in both runs,** with the four files of the work.
- **No false issue:** in the first run every changed file was inside the paths,
  and nothing was flagged. That includes a modified existing test listed in the
  paths.
- **A file outside the paths was flagged.**
  - A note injected into the implementer's first turn asked for a `README.md`,
    and the facts said `files changed outside the brief's paths: README.md.`
  - The reviewer raised it as a blocking finding, citing the runtime's flag and
    the missing justification in `decisions`.
  - With the rounds spent, the review went to the leader as `rejected`, with
    the two positions.
  - The note reached only the implementer, which is why it believed the brief
    asked for the file. That is an artifact of the injection, not of the check.
