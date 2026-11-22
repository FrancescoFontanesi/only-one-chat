# 0044. Brief references: the files to read first, as checked pointers

Status: Accepted.

## Context

An implementer that starts a task finds the code by exploring it. Each read is a
tool call, and each call reads the conversation again from the cache. The
measurement for the parked ADR 0043 (a follow-up task in the same module, run on
2026-11-22) found that a fresh implementer session made 15 tool calls instead of 9. It read the module again before changing it. The leader usually knows which
files matter, and the brief has no field to say so.

What exists already:

- **References are pointers.** A brief reaches the implementer through
  `relay` → `plainRefs` (`apps/vscode/src/session/mentions.ts`), which turns
  `@path#L10-40` into `path (lines 10-40)` and never inserts contents.
  `expandMentions`, which inlines and truncates, is used only for the user's
  attachments.
- **The same syntax everywhere:** `@path`, `@path#L10` and `@path#L10-40`, for
  the user and for the agents (`refTokens` in
  `apps/vscode/src/webview/refs.ts`). `resolveRefs` tells existing paths from
  missing ones inside the workspace.
- **Invalid calls are repaired.** An invalid `delegate` call gets one repair
  turn from the leader; in the product, the user decides after that.
- **Instruction files are loaded by the CLIs.** Codex and Antigravity read
  `AGENTS.md`; Claude Code reads `CLAUDE.md`, which in this repository imports
  `AGENTS.md`. The role prompts already say those instructions apply. A brief
  that points at them makes the implementer read them twice.

## Decision

1. **An optional `references` field in `delegate`.**
   - It is a list of 1 to 8 workspace-relative file paths, each with an
     optional line range, `#L10` or `#L10-40`.
   - The schema pattern rejects:
     - a comment, an absolute path or `..`, as for `paths`
       ([ADR 0042](0042-brief-paths.md));
     - a line number below 1.
   - The runtime normalizes the paths as ADR 0042 does.
2. **The runtime checks the references before the brief is sent.**
   - **Errors,** added to the `delegate` call's validation errors, so the
     leader fixes them with the existing repair turn:
     - a path that does not exist;
     - a folder;
     - a path under `ignoredPaths`;
     - a range whose end is before its start.
   - **Filtered silently:**
     - `AGENTS.md` and `CLAUDE.md` at the workspace root, compared without
       case;
     - exact duplicates after normalization.

     Removing them costs nothing, while an error would cost a whole leader
     turn. If nothing is left, the section is omitted.

   - **Who checks:** whoever knows the workspace gives the loop a function that
     says whether a path is a file, a folder, missing or ignored. That is
     `ChatSession` and the bench, reusing `resolveRefs` and the ignored-path
     rule. `packages/runtime` stays free of the file system.
3. **The brief carries pointers, not contents.**
   - `references` renders as a `## References` section of `@path` lines.
   - `plainRefs` turns them into plain paths with their ranges for the agents.
   - The user can edit the section before the brief is sent, like the rest of
     the brief. An edited reference is passed on as written and not checked
     again.
4. **The roles read them at the start, in parallel:**
   - **Implementer:** read every reference at the start of the turn, in one
     batch of parallel reads, before exploring.
   - **Reviewer:** the references are the implementer's starting context. Read
     in parallel those that bear on the constraints and the criteria, above
     all specification documents, before judging.
   - **Leader:** list the files the work must read (code to change, patterns to
     follow, specifications), narrowed to line ranges when a part is enough.
     Never `AGENTS.md` or `CLAUDE.md`.

## Budget

- **Code:** about 90 lines of production code, plus tests:
  - the schema and the rendering in `handoff.ts`;
  - the check and filter in the loop's delegation path;
  - the workspace function in `ChatSession` and in the bench.
- **Prompts:** one sentence each in `implementer.md`, `reviewer.md` and
  `leader.md`.
- **No dependency,** no setting, no change to the persisted task record.
- **Visible to the user:** a `References` section in briefs that have one.
- **Out of scope:**
  - the implementer session's lifecycle (ADR 0043, parked);
  - inlining contents;
  - folder references.

## Measurement

Measured on 2026-11-22, with Claude Sonnet 5.5 low as the implementer.

**With the leader in the loop** (the ADR 0043 scenario: two tasks on `wc.py`,
leader Codex `gpt-6.1-terra` low):

- the leader filled `references` in one run and not in the other, where it
  named the files inline in `Context`;
- run-to-run noise on the second task (4 to 15 tool calls without references)
  was larger than any effect;
- no conclusion.

**Isolated A/B** (sandbox `adr44`):

- **Setup:**
  - 31 files: 20 Python modules in 7 sub-packages, 4 `docs/*.md`;
  - a constraint found only in `docs/money.md`: round half up, once, on the
    discounted total;
  - one fixed brief sent straight to the implementer, in a fresh session, 3
    runs per arm, arms alternated;
  - the arms differ only in a `References` section: the target module, the
    discount module, and `docs/money.md` lines 3-9.
- **Hidden tests:** five, checked against three implementations. Only the
  correct one passes all five; each wrong rounding fails one constraint case.

| Arm        | Sequential steps   | Tool calls | Cache reads | Turn time         | Hidden tests |
| ---------- | ------------------ | ---------- | ----------- | ----------------- | ------------ |
| References | 3, 3, 4 (mean 3.3) | 6, 6, 7    | mean 56k    | 23-28 s (mean 26) | 5/5 ×3       |
| None       | 5, 5, 4 (mean 4.7) | 5, 5, 5    | mean 72k    | 31-34 s (mean 32) | 5/5 ×3       |

- **With references,** the implementer reads the named files in one parallel
  batch, then writes. Turn time −19%, cache reads −21%, same quality.
- **Sequential steps, not raw tool calls, are the metric:**
  - parallel reads count as several calls but one step;
  - the implementer without references explores with one large `cat` of many
    files;
  - so the call count rises by one while the work is shorter.

  The steps in the table group calls less than 1.5 s apart. The bench report
  now counts them structurally, per role, from the adapters' tool steps: the
  calls started before any result came back are one step, whatever their
  timing.

- **Not shown: a benefit on constraints hidden in the documentation.** Without
  references the implementer read `docs/` within its first two calls in every
  run, since the repository is small and the brief says to follow the
  documented conventions. A gain there would need a much larger documentation
  set, not measured.
- **Limits:** three runs per arm, one implementer model. The differences are
  indicative.

## Consequences

- **The implementer starts from the files the leader names,** read in one batch,
  instead of finding them call by call.
- **The reviewer judges from the same starting point,** and reads the
  specifications the brief relies on.
- **A wrong reference costs one leader repair turn;** a redundant one costs
  nothing.
- **The leader has one more field to fill well.** Being optional, it can be left
  out when the leader does not know the code.
