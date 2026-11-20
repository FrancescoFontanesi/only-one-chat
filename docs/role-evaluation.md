# First evaluation of leader and implementer assignments (2026-11-11)

**Provisional.** The first evaluation on 2026-11-11 ran once per pair without measuring
quota. The second evaluation on 2026-11-17 tried the new prompts and the reviewer.
It measured quota but ran once per system on a task all systems could solve.

The first evaluation used Claude Code 2.1.322 and Codex 0.164.0, with the
`iter-1-demo` branch and ADR 0022.

## Setup

- **Scenario.** The reference calculator in `sandbox/scenarios/calc/reference/` was
  copied into an empty folder.
- **Task.** Add `round(x)` and `round(x, n)`.
- **Two user messages to the leader, translated here:**
  1. "I'd like to add a calculator function `round(x)` and `round(x, n)` for `n`
     decimal places. Let's think it through first. Where does it go in the code, what
     are the edge cases, and how do we test it? Wait before generating the prompt.
     Ask if you need a decision from me."
  2. "Decisions. Round as Python's `round` does. `n` must be an integer `>= 0`.
     Otherwise return 'Error: invalid argument for round'. The wrong number of arguments
     produces the same error as other functions. Generate the prompt using the agreed
     structure and delegate it."
- **Chat configuration:**
  - Direct use of `ChatSession` outside VS Code.
  - Automatic delivery (`mode: 'auto'`) and review every time (`review: 'always'`).
  - Leader at `read-only`, implementer at `auto`.
  - `allowedCommands: ['python']`.
  - `verifyCommand: python -m unittest`.
- **Fake user responses:**
  - Select the first option on every leader question.
  - Deny every permission request.
- **Loop under test.** Planning, runtime interception and delivery of the brief,
  implementation, report, verified facts, and leader review.

### Deterministic checks

- **8 loop checks:**
  - The first message produces no delegation.
  - The runtime intercepts and delivers the brief.
  - The brief contains the then-required headings `Obiettivo` (Goal) and
    `Criteri di accettazione` (Acceptance criteria).
  - The implementer takes a single turn.
  - The report block is present.
  - The report sections are in order.
  - Facts reach the leader.
  - The leader takes a turn after the report.
- **9 black-box `round` cases** (`python main.py -e …`):
  - `round(3.567, 2)` returns 3.57.
  - `round(2.5)` returns 2.
  - `round(-2.5)` returns -2.
  - `round(7)` returns 7.
  - `round(10 / 4, 1)` returns 2.5.
  - `round(1, -1)` and `round(1, 2.5)` return "invalid argument".
  - `round()` and `round(1, 2, 3)` return "wrong number of arguments".
- **Regressions.** The 30 cases in `hidden-tests.json` with normalized line endings.
- **Unit tests.** `python -m unittest`. The reference implementation has 3 tests.

## Results

Both pairs used `medium` reasoning for the leader and `low` for the implementer.

|                 | A: Codex gpt-6.1-sol leader, Claude Sonnet implementer | B: Claude Sonnet leader, Codex gpt-6.1-sol implementer   |
| --------------- | ------------------------------------------------------ | -------------------------------------------------------- |
| Loop checks     | 8/8                                                    | 7/8 (report missing `Bloccato su`, the blockers section) |
| `round`         | 9/9                                                    | 9/9                                                      |
| Regressions     | 0/30                                                   | 0/30                                                     |
| Unit tests      | 5, OK                                                  | 10, OK                                                   |
| Leader question | Yes (`requestUserInput`)                               | Yes (`AskUserQuestion`)                                  |
| Total time      | 192 s                                                  | 156 s                                                    |

### Usage by role

"Context" sums input context across all model calls, including cache reads. Claude
dollar figures are list prices reported by the CLI. Subscription users do not incur
those charges.

| Role            | Codex gpt-6.1-sol                | Claude Sonnet                           |
| --------------- | -------------------------------- | --------------------------------------- |
| Leader, 3 turns | 356k context, 4.0k output, 128 s | 180k context, 4.8k output, 54 s, $0.198 |
| Implementer     | 465k context, 3.1k output, 100 s | 231k context, 4.1k output, 61 s, $0.207 |

Leader turns in order:

| Turn     | Codex      | Claude     |
| -------- | ---------- | ---------- |
| Planning | 265k, 88 s | 114k, 29 s |
| Brief    | 29k, 23 s  | 32k, 16 s  |
| Review   | 62k, 17 s  | 34k, 10 s  |

### Observations

- **Tokens.** Codex used about twice as many tokens as Claude in both roles. The Codex
  leader's first exploration turn was the most expensive.
- **Claude cost.** About $0.20 in either role.
- **Review.** The Codex leader reran the remaining cases in read-only mode. The Claude
  leader flagged the unverified claim that the tests had failed before the change
  without reopening the code.
- **Report.** The Claude implementer's report was complete. Codex omitted
  `Bloccato su` in both B runs (the first lacked the question tool). The likely cause
  was conflicting instructions in `packages/runtime/prompts/implementer.md` about
  including the section only for an incomplete outcome and using "none" in an empty
  section.
- **Tests written.** The Codex implementer wrote more tests (7 versus 2).

## Provisional conclusion

The Codex leader and Claude implementer (A) performed better on review and reporting
and used 24% fewer Codex tokens with comparable Claude usage. B was 36 s faster on a run
of about 3 minutes.

## Limitations

- **Quota.** Quota use was unmeasured in the five-hour and weekly windows. Codex tokens
  and Claude nominal dollars measure different things.
- **Variance.** One run per pair leaves the review differences open to chance.
- **Session duration.** A real session has more planning turns, so the leader would
  account for a larger share of usage.
- **Untested pairs.** Claude/Claude and Codex/Codex.

## Follow-up plan

1. **Report format.** Fix the `Bloccato su` instruction in `implementer.md` so the
   section's presence is unambiguous.
2. **Quota.** Read usage before and after each run with the extension's readers,
   without opening profile files.
3. **Runs.** Run each of the four pairings (A, B, Claude/Claude, Codex/Codex) at least
   3 times.
4. **Task.** Reuse the scenario and messages and add a task spanning more files to
   estimate leader exploration cost.
5. **Review.** Check whether the leader reopens the code or relies on the report.

---

# Second evaluation with new prompts and a reviewer (2026-11-17)

This evaluation used the revised role prompts and the reviewer (ADR 0029, 0030).
Each system ran once using real CLIs at `low` reasoning effort. Scenario
`sandbox/scenarios/calc-roles` used the same two messages as the first evaluation,
with 39 hidden tests (9 `round` cases and 30 regressions).

The run command was `pnpm bench --system <R0..R4> --scenario calc-roles`, and
`dev/review-check.ts` tested the seeded defect. The leader was read-only and asked
for decisions in prose because the benchmark lacked the question tool. The benchmark
also lacked the checkpoint needed for ADR 0030 diff checks.

## Runs

| System | Leader      | Implementer | Reviewer     | Hidden tests | Report outcome | Verdict           | Time  |
| ------ | ----------- | ----------- | ------------ | ------------ | -------------- | ----------------- | ----- |
| R0     | Sonnet      | Sonnet      | None         | 39/39        | Completed      |                   | 69 s  |
| R1     | Sonnet      | Sonnet      | Haiku        | 39/39        | Partial        | With reservations | 103 s |
| R2     | Sonnet      | Sonnet      | Luna (Codex) | 39/39        | Completed      | Approved          | 107 s |
| R3     | Sol (Codex) | Sonnet      | Luna (Codex) | 39/39        | Partial        | Approved          | 139 s |
| R4     | Sonnet      | Sol (Codex) | Haiku        | 39/39        | Completed      | With reservations | 151 s |

Input usage by role is in thousands of tokens. This sum includes cache reads and
grows with the number of model calls. The third evaluation reports context size
separately.

| System | Leader (3 turns) | Implementer | Reviewer |
| ------ | ---------------- | ----------- | -------- |
| R0     | 97               | 66          |          |
| R1     | 185              | 68          | 54       |
| R2     | 97               | 64          | 131      |
| R3     | 438              | 46          | 102      |
| R4     | 98               | 388         | 54       |

The trial used about 7 percentage points of Claude's five-hour quota (8% to 15%)
and 3 points of Codex's (0% to 3%). Codex's weekly usage held at 2% while Claude's
rose from 9% to 10%. A run consumed about 1 point of Claude's five-hour quota or
1–2 Codex points when Sol acted as leader or implementer. These measurements include
Claude's probes and the seeded defect tests below.

## Observations

- **Correctness scores were tied.** All five systems passed 39/39. Cost, time, and
  workflow differed.
- **Reports included all six sections.** All 5 runs and the trial recreating the
  first evaluation's reporting failure included `Bloccato su` (blockers). They also
  stated which new tests had been seen failing and which existing tests had changed.
- **Briefs included concrete input and expected output.** Each had 12 to 20 cases.
- **Sol used substantially more input for the same task.** As leader, Sol used 438k
  context versus about 100k for Sonnet. As implementer, it used 388k versus 66k and
  took 81 s versus 21 s.
- **The leader made and disclosed unspecified decisions.** For `n` as an
  integer-valued float, R0 and R2 accepted it and R1 rejected it. Disclosing the
  decision was expected. The behavior difference shows an ambiguity the leader
  should ask the user to resolve.
- **Bash was denied to the implementer in 2 of 5 runs (R1, R3).** Reports truthfully
  recorded a partial outcome with all checks unverified. The benchmark uses only
  the command allow-list. Rerun this check in the product, which also has the
  permission bridge.
- **Read-only Claude reviewers could not run `python`.** This caused reservations in
  R1 and R4. The Codex reviewer could run it in its read-only sandbox and approved
  the work. This environment constraint would add reservations to every read-only
  Claude review regardless of implementation quality.

## Seeded defect test

Starting from the correct R0 implementation, remove the `digits < 0` guard and the
error cases in the tests. `python -m unittest` still passes, and the unchanged report
claims those cases were verified. Each reviewer ran twice.

| Reviewer     | Code defect detected   | Missing tests and false report detected | Executed code       | Format                                                                                     |
| ------------ | ---------------------- | --------------------------------------- | ------------------- | ------------------------------------------------------------------------------------------ |
| Haiku        | 2/2                    | 2/2                                     | No, `python` denied | Findings 2/2                                                                               |
| Sonnet       | 2/2                    | 2/2                                     | No, `python` denied | Findings 2/2                                                                               |
| Luna (Codex) | 2/2, with a reproducer | 0/2                                     | Yes                 | Findings 1/2. Immediate review 1/2, with malformed `<<<REVISION` and `REVISIONE>` markers. |

- **Haiku found both issues by inspection.** It matched Sonnet at lower cost and
  always reported that it had not run the code.
- **Luna reproduced the defect but missed the report discrepancy.** It ran the
  failing command and missed that the tests did not cover the report's claimed check.
- **Malformed markers affected the UI.** The runtime passed the answer to the leader
  as a review, while the thread card would have missed it.
- **Luna skipped the correction round in 1 of 2 runs.** It sent the review directly
  to the leader despite blocking findings and remaining rounds, leaving the defect
  unresolved.

## Limitations

- One run per system on a straightforward task could not distinguish correctness.
  Reviewers found defects only where the trial introduced them.
- The findings loop with live models remained unverified. Implementer responses to
  findings and report rewrites had only been exercised with fake agents.
- The benchmark lacked the leader's question tool, checkpoints, and diff checks.
- Claude quota probes round to the nearest point, so sub-point comparisons across
  systems are unreliable.

---

# Third evaluation with a harder task and three review dimensions (2026-11-17)

## Revised measurement of Sol's context

The previous tables sum input tokens across all calls in a turn, including cached
input. Agents that make more calls reread the prefix each time, and cached input
costs a fraction of fresh input. More useful comparisons for the same work
(R0–R4, `round` task):

| Role               | Fresh tokens | Cached tokens | Commands | End-of-turn context |
| ------------------ | ------------ | ------------- | -------- | ------------------- |
| Sonnet leader      | 22–28k       | 69–160k       | 7–12     | 27–30k              |
| Sol leader         | 79k          | 360k          | 9        | 36k                 |
| Sonnet implementer | 18–25k       | 26–49k        | 6        | 22–24k              |
| Sol implementer    | 39k          | 349k          | 15       | 40k                 |

Sol's actual context size was about 1.4 times Sonnet's. The summed input figures
suggested a factor of 4. Sol made more calls and used 2–3 times as many fresh
tokens. Codex quota usage was 2–4 points of the five-hour window for a run
with Sol and 0–1 without it.

## Scenario and prompts

- **`calc-include` scenario.** Add `include "file.calc"` to scripts. The task spans
  multiple files and covers out-of-folder paths, cycles, depth, and size limits.
  There are 46 hidden tests, 16 for `include` and 30 regressions. Two cases place a
  readable file **outside** the working folder. Reading it prints `100`. The tests
  were validated on a reference solution (46/46) and the starting project (31/46).
- **Revised reviewer prompt.** Review honesty (checking for shortcuts or false
  claims), security (which takes precedence over functionality), and currency
  (checking the versions actually used), alongside the acceptance criteria. The
  report adds an assessment section, originally `Giudizio`. The method draws on
  EvilGenie (a judge, test checks, and held-out tests), the
  `getsentry/skills@security-review` skill (report only high-confidence findings and
  inspect the whole codebase), and sources on stale APIs (verify against installed
  versions).
- **Skills surveyed.** `getsentry/skills@security-review` (23.8k installations),
  `affaan-m/ecc@security-review` (20.6k), `addyosmani/agent-skills@code-review-and-quality`
  (89k), and `mattpocock/skills@code-review` (900k). The project rules precluded
  installing them. None covers all three dimensions. `slopwatch`, which detects
  disabled tests, supports only .NET.
- **Benchmark.** The Claude implementer now uses Claude Code's auto mode, as in the
  product.

## Runs

Each system ran once. The reviewer used `medium` effort and the other roles used
`low`. All systems passed 46/46.

| System | Leader | Implementer | Reviewer | Outcome   | Verdict           | Assessment (honesty / security / currency) | Time  |
| ------ | ------ | ----------- | -------- | --------- | ----------------- | ------------------------------------------ | ----- |
| T1     | Sol    | Sonnet      | Hydrogen | Completed | With reservations | Clean / clean / clean                      | 335 s |
| T2     | Sonnet | Sol         | Terra    | Completed | With reservations | Clean / uncertain / clean                  | 344 s |
| T3     | Sonnet | Sonnet      | Hydrogen | Completed | With reservations | Clean / clean / clean                      | 201 s |

| System | Role               | Fresh tokens | Cached tokens | Output | Time  | Commands |
| ------ | ------------------ | ------------ | ------------- | ------ | ----- | -------- |
| T1     | Sol leader         | 67k          | 343k          | 4k     | 135 s | 10       |
| T1     | Sonnet implementer | 35k          | 206k          | 20k    | 137 s | 10       |
| T1     | Hydrogen reviewer  | 29k          | 47k           | 11k    | 60 s  | 0        |
| T2     | Sonnet leader      | 27k          | 93k           | 8k     | 80 s  | 8        |
| T2     | Sol implementer    | 96k          | 686k          | 5k     | 175 s | 19       |
| T2     | Terra reviewer     | 34k          | 281k          | 2k     | 86 s  | 16       |
| T3     | Sonnet leader      | 32k          | 128k          | 8k     | 74 s  | 10       |
| T3     | Sonnet implementer | 28k          | 110k          | 9k     | 66 s  | 8        |
| T3     | Hydrogen reviewer  | 29k          | 45k           | 12k    | 58 s  | 0        |

Five-hour quota before and after each run: T1 Codex 11→13%, Claude 34→35%.
T2 Codex 6→10%, Claude 26→27%. T3 Codex 13→13%, Claude 35→37%.

## Observations

- **Correctness scores remained tied.** All passed 46/46, including the cases with
  the secret outside the working folder. All three implementers confined paths
  using `realpath` and lexical checks, handled symlinks, and wrote tests.
- **Sol as implementer used 3–4 times as many fresh tokens as Sonnet.** Sol used 96k
  versus 28–35k, took 175 s versus 66–137 s, and consumed 4 additional Codex quota
  points for the same test result.
- **Hydrogen's first attempts ended without a response because of an integration
  defect.** In read-only mode Antigravity denied all permission requests. Hydrogen
  tried `git status`, got a denial, then attempted `read_file`, which failed. The
  turn ended without text after 4–5 s. The empty review reached the leader as a
  report. Three fixes addressed this:
  - Tell the Antigravity reviewer it cannot run commands using `NO_COMMANDS_NOTE`.
    It then writes 7–8k characters of review.
  - Report that the work was not reviewed when a review is empty (`EMPTY_REVIEW`),
    with a `reviewed` event that has no verdict.
  - Have the ACP adapter turn an empty turn with an abnormal stop reason into an
    error.
- **Seeded defect test with the new prompt and `medium` reviewer effort** (two runs
  each). Terra and Haiku found both issues, the code defect and the missing tests
  with a false report, in 2/2 runs. Terra also found a real flaw in the original
  implementation (`OverflowError` for very large `n`). Hydrogen with the note
  found both issues in 2/2 runs and separately flagged the false report under
  honesty in one run. Before the note it found them in 0/2 runs. Luna with the old
  prompt found the code defect and missed the false report.
- **Reviewers qualified their assessments.** Terra marked security "uncertain"
  because its sandbox lacked a temporary directory for testing symlinks. In T3,
  Hydrogen identified an ambiguity in the brief (C6 versus C7 on the order of UTF-8
  and size checks) in the brief assessment section (originally `Sul brief`). It
  marked a null byte in the path unverified.
- **All final verdicts were "with reservations".** The read-only reviewers reported
  that they could not run the project's tests. All three leaders correctly understood
  that the reservation concerned the environment. The user still saw the same
  verdict on each run.

## Limitations

- One run per system on a task all systems could solve did not distinguish
  correctness. Cost and time differences are indicative.
- No reviewer found a defect in the trial implementations, so the findings and
  correction loop with real models remained untested.
- The benchmark lacked ADR 0030 diff checks and the leader's question tool.
- The currency assessment was "clean" without external sources. The read-only
  session lacked web search, and the project used only the standard library, so
  the evaluation did not exercise this dimension.

# Fourth evaluation of a single model and three roles on one shared message (2026-11-18)

The roles divide planning, writing, testing, and reporting across models and
subscriptions. This evaluation asked whether a lower-cost model could review well
and report to the leader, making a review feasible on every task.

**Scenario.** `calc-include` with one natural-language message
(`one-message.json`) shared across systems. There was no planning phase or request
for a brief. The 51 hidden tests included hostile inputs.

|                                 | U1: Sol alone (medium)                                         | U2: Sonnet alone (medium) | U3: Sol (medium) → Sonnet (low) → Haiku (high)                            |
| ------------------------------- | -------------------------------------------------------------- | ------------------------- | ------------------------------------------------------------------------- |
| Hidden tests                    | **51/51**                                                      | 2/51                      | **51/51**                                                                 |
| Time                            | 301 s                                                          | 84 s                      | 553 s                                                                     |
| Codex (Sol)                     | 32.7k fresh, 468k cached, **10.0k output**, 5h quota +2 points | —                         | 40.0k fresh (+22k Luna), 332k cached, **2.7k output**, 5h quota +2 points |
| Claude nominal cost             | —                                                              | $0.18                     | $0.52: Sonnet $0.48, **Haiku $0.04**                                      |
| Defects beyond the hidden tests | 40,000-character path produced a traceback                     | —                         | Two found and fixed, as described below                                   |

- **U3 exercised the findings loop with real models for the first time.** Haiku
  wrote two failing tests and raised two blocking findings in its first turn:
  - A 40,000-character path produces a traceback (uncaught `ValueError` from `lstat`).
  - `include "NUL"` reads the Windows device as an empty file and exits with 0.

  Manual checks confirmed both in the original working folder. Sonnet fixed them
  in one round and kept the reviewer's tests. The final review ("with reservations")
  flagged a limit the brief omitted, the total number of includes (1,296 measured
  executions with 6 children over 5 levels). The leader reported proposals and
  decisions for the user.

- **Hydrogen (`high`) ran separately on the same input.** It received Haiku's
  first-turn request and a snapshot of the folder as it stood at that moment. It
  ran 12 commands in 225 s, tried `NUL` and `CON`, and **approved** without findings.
  It missed both defects. An initial benchmark attempt had ended empty after a
  permission denial. The benchmark was fixed and the attempt rerun.
- **U2 was an incident.** An edit script wrote a literal NUL byte into `main.py`.
  Claude's tools refused to edit that file, and the benchmark denied `rm`. Sonnet
  reported what happened. With one model, there was no second agent to take over or
  flag the issue.
- **Codex quota use was the same.** Sol as leader produced a quarter of Sol's
  standalone output. Whole quota points could not distinguish them. The heavier
  workload moved to Claude, and Haiku review accounted for 8% of the Claude cost.
- **Time was the trade-off.** U3 took almost twice as long as U1.

In this task, Haiku at `high` effort found two real defects missed by the hidden
tests and Hydrogen, for a few cents at list price. The result supports trying
routine reviews with a lower-cost model. Each system ran once.

**Post-run correction.** The contract check (ADR 0031) did not parse the historical
values `verificati` (plural) or `parziale` and flagged criteria that were present
in the report.
