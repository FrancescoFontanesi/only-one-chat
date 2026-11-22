# 0041. Runtime evidence before the review: a gate, per-turn attribution, one path

Status: Accepted.

## Context

[ADR 0040](0040-handoff-integrity.md) made the handoffs consistent. This ADR
covers the layer next to them: the evidence the runtime gathers itself and gives
to the roles as facts. The external review and the live check of ADR 0040,
verified against the code on 2026-11-22, found four faults.

1. **With a reviewer, nothing verifies the work before the reviewer starts.**
   - In the product, `ChatSession.facts` passes an empty command to
     `verifiedFacts` (`apps/vscode/src/session/chat.ts`). The facts only name
     the configured command.
   - `WorkspaceVerification.check` runs after the reviewer's turn, in
     `reviewed()` (`packages/runtime/src/loop.ts`).
   - The `implementer` origin runs only when there is no reviewer.
   - So a reviewer can spend a whole turn on work whose tests do not even pass.
2. **Changes are attributed to the wrong turn.** `files-undeclared` compares
   every file changed since the request began with the report of the last turn.
   In the live check this caused two false issues:
   - in round 2, the files of round 1 counted as undeclared;
   - a test the reviewer wrote, which the reviewer guard keeps by design
     ([ADR 0029](0029-reviewer-findings-and-review.md)), counted as the
     implementer's.
3. **The bench does not follow the product's path.** The bench builds its facts
   by running the scenario's command itself, after every implementer turn. The
   product does not. A live measurement therefore says little about the
   product, and the gate in point 1 looked present when it was not.
4. **The tests depend on the developer's environment.**
   - Unit tests inherit `process.env`. With `ANTHROPIC_BASE_URL` set, as on a
     machine with a local proxy, the Claude billing check correctly stops the
     fake CLIs' turns, and 41 tests in `apps/vscode/test/unit/chat.test.ts`
     fail.
   - `packages/adapters/test/env.ts` already gives launched processes a clean
     environment, but only some tests use it.
   - Separately, `runCommand` in `apps/vscode/src/session/facts.ts` passes the
     full environment, API keys included, while `verification.ts` removes them.

## Decision

1. **A verification gate before every reviewer turn.**
   - **When it runs:** before each review request, first or follow-up, when the
     loop has a `verification` and the report is not `blocked`. The runtime
     calls `check` with the report's test selection and the `implementer`
     origin.
   - **`failed`, or `inconclusive` with a non-zero exit code:** the output goes
     back to the implementer instead of to the reviewer.
     - Without a JUnit report, [ADR 0038](0038-verification-and-handoff.md)
       counts a red suite as `inconclusive`. The final evidence keeps that
       status; only the gate acts on the exit code.
     - The result carries the exit code, and the output's tail when there are
       no JUnit details.
     - This uses a budget of its own: one gate retry per review request, not
       counted in the review rounds.
     - The prompt says that a failure that existed before the work, or that
       comes from the environment, must be stated as such in the report.
   - **Still not passing after the retry:** the reviewer starts, with the
     failure among the facts, and judges it.
   - **Otherwise the reviewer starts as today,** with the result among the
     facts:
     - `passed`;
     - `unavailable`, when no command is configured;
     - `inconclusive` without an exit code: a timeout or a launch error, which
       the implementer cannot fix.
   - **The run is cached:** `check` caches its run by workspace checkpoint, so
     the check after the reviewer's turn reuses it when nothing changed.
   - **No baseline comparison:** `check` runs the whole command and does not
     know which failures existed before the work. Comparing them would cost one
     more run per task. The single retry, and the report's statement, cover a
     failure that was already there.
2. **Each change belongs to the turn that made it.**
   - The facts after an implementer turn list the files changed by that turn,
     measured from a snapshot taken just before it, beside the files changed
     since the request began.
   - `files-undeclared` uses only that turn's list.
   - A test the reviewer wrote between two implementer turns is therefore never
     the implementer's.
   - The reviewer guard's note names the test files the reviewer kept, as it
     already names the files it restored.
3. **The bench takes the product's path.**
   - **Verification:** a leader system's loop gets a `WorkspaceVerification`
     with the scenario's `verify` command, as the product configures it, and
     the same facts.
   - **Final check:** the runner's own command, used only for the evaluation,
     stays.
4. **Hermetic tests, no keys in runtime commands.**
   - **Unit tests:** a Vitest setup file removes from `process.env` the
     variable families that change what the code decides:
     - `ANTHROPIC_*`, `CLAUDE*`, `OPENAI_*`, `GEMINI_*`, `GOOGLE_*`;
     - `CODEX_*` except `CODEX_EXECUTABLE`, and `AGY_*`;
     - the proxy variables, in both cases.
   - **Live tests:** they stay opt-in through their executable variable.
   - **Runtime commands:** `runCommand` in `facts.ts` removes the API keys with
     `withoutApiKeys`, as `verification.ts` does.
   - **Acceptance:** `pnpm check` passes in a shell that has these variables
     set.

## Budget

- **Code:** about 250 lines of production and dev code, plus their tests:
  - the gate in `reviewed()` and its prompt;
  - the per-turn snapshot and the facts in `ChatSession`, and the check in
    `contract.ts`;
  - the guard's note;
  - the bench's verification;
  - the Vitest setup.
- **No new dependency,** no new setting, no change to the security model.
- **Persisted task record** of [ADR 0039](0039-resume-interrupted-tasks.md):
  unchanged if the gate retry can use the existing `implementation` step;
  otherwise a backward-compatible optional field.
- **Visible to the user:**
  - the verification command now also runs before the reviewer, with its
    progress line;
  - a failing gate sends the work back to the implementer.
- **Out of scope:**
  - enforced scope;
  - the implementer session's lifecycle;
  - references in the brief;
  - a baseline comparison of failures.

## Consequences

- **Reviewer turns go to work whose tests pass,** or whose failure is stated.
- **Up to one more implementer turn** per review request when the gate fails.
- **Contract issues on files describe the turn that is being reported.**
- **Live bench results measure the product's verification path.** Results
  before this ADR are not comparable on reviewer turns.
- **The test suite passes on any developer machine,** whatever its provider
  variables.

## Live check

Three runs of the ADR 0040 bench scenario on 2026-11-22: leader Codex
`gpt-6.1-terra` low, implementer Claude Sonnet 5.5 low, reviewer Claude Haiku 5.5
medium. A note injected into the implementer's first turn made it leave a failing
test. Hidden tests passed 5/5 in every run.

- **With a JUnit command** (`python -m pytest --junitxml={junit}`):
  - the gate saw `failed` (3 tests) and sent the output to the implementer;
  - the reviewer did not start;
  - after the retry the gate saw `passed`, and the reviewer approved in round 0.
- **Without `{junit}`** (`python -m unittest`):
  - **First version, gate on `failed` only:** the red suite exited 1, which
    [ADR 0038](0038-verification-and-handoff.md) counts as `inconclusive`, so
    the gate let the reviewer start. The reviewer caught the defect with
    `findings`. This run led to the exit-code rule in point 1.
  - **With the exit-code rule:** the gate saw `inconclusive`, exit 1, and sent
    the output to the implementer. After the retry the gate saw `passed`, and
    the reviewer started for the first time, in round 0.
- **With the default empty command,** the gate never runs.

- **Per-turn attribution held:** a round 2 whose report named only its own files
  raised no `files-undeclared`, where the ADR 0040 runs had two false issues.
