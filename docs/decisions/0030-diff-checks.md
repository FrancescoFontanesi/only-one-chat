# 0030. Diff checks in verified facts

Status: Accepted. Extends the runtime's verified facts in ADR 0010. First step of the [roadmap](../roadmap.md).

## Context

- **Changing verification can let code pass it.** Examples include removing or skipping a test, disabling a lint rule, forcing a type, and lowering a threshold.
- **Verified facts listed changed files by hash** and the verification command's result when configured. The leader otherwise relied on the report or opened the files.
- **The checkpoint for each message (ADR 0014) already captures file contents before and after.** The checks need no model or new dependency.

## Decision

1. **Add a "Runtime diff checks" section to the facts** after changed files and verification. Label its flags as requiring review. Compare the folder before the user's message with its current state. This covers the entire request, including reviewer rounds. Show it to the leader, the reviewer, and in the thread's facts card.
2. **The checks match text** in `apps/vscode/src/session/shortcuts.ts`. They flag these changes.
   - deleted test files
   - fewer test cases or assertions in an existing test file
   - additions such as `skip` and `only` in a test file
   - added `eslint-disable`, `@ts-ignore`, `@ts-expect-error`, `@ts-nocheck`, `# type: ignore`, `# noqa`, `as any`, or `: any` in any file
   - changed lockfiles
   - changed files that determine what is checked, including ESLint, TypeScript, Vitest, Jest, pytest, tox, or pre-commit configuration, CI workflows, and Husky hooks.
3. **The flags guide review.** A test moved between files looks like a deletion. A dependency requested in the brief can legitimately change the lockfile. The leader relays flags the report leaves unexplained in Decisions, and the reviewer starts with them.
4. **Report coverage gaps.** If no checkpoint is available because the folder is too large or unreadable, the section says so. It lists binaries and files too large for a checkpoint, which the checks skip.

## Consequences

- The checks read captured file contents and consume no quota.
- The diff provides independent evidence for claims about tests and checks in the report.
- **Deferred roadmap items** include identifying files outside the brief's scope and changes to the public interface, which require interpreting the brief and each language. Comparing reported test runs against the turn's command steps also remains deferred until those steps are linked to verified facts.
- **The checks can produce false alarms.** Pattern matching sees `x as any` in comments and strings. The flags still serve their purpose, and an AST-based check is currently too costly.
