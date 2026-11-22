# 0040. Handoff integrity: unique identifiers and a verdict that drives the loop

Status: Accepted.

## Context

The project is past its feature phase. Before adding new phases to the review
cycle, the layers under it must hold. This ADR opens a bottom-up series, one
topic per ADR, each with a budget. It covers the lowest layer: what a handoff
call may contain, and how the runtime acts on it.

[ADR 0035](0035-handoff-tools-and-english.md) made handoffs schema-validated
tool calls. [ADR 0031](0031-role-contract-and-brief.md) and later ADRs turned the
contract checks into comparisons between fields. An external review, verified
against the code, found two holes in that layer:

1. **Duplicate identifiers pass silently.** `statusesOf` in
   `packages/runtime/src/contract.ts` keeps the first entry of an id. A report
   with `C1 verified` and then `C1 not_met` counts C1 as verified. The same
   holds for the reviewer's criteria. Finding ids are not checked for
   uniqueness either.
2. **The verdict does not drive the correction loop.** In `reviewed()`
   (`packages/runtime/src/loop.ts`) a correction round starts only when the
   reviewer calls `findings` or runtime verification fails. `checkReview`
   runs after that decision. So:
   - a `rejected` review with rounds left, and no `findings` call, ends the
     review and goes to the leader;
   - an `approved` review that `checkReview` lowers to `rejected` never
     reopens the loop;
   - coherence is checked only for `approved`: a `with_reservations` review
     with a blocking finding still open is kept as it is.

Verified in the code on 2026-11-22. A `rejected` review with no rounds left
going to the leader is correct and stays.

## Decision

1. **Identifiers are unique per list, enforced by the schema.** The validator
   subset gains one keyword, `uniqueBy: "<field>"`, on arrays of objects. It is
   applied to:
   - the criteria of `report` and `review`;
   - the items of `findings`;
   - the finding resolutions of `report`;
   - the open and closed findings of `review`.

   The handoff server rejects a duplicate as a schema error, so the model fixes
   it in the same turn, as with any other invalid argument. The runtime's
   re-validation uses the same function and drops `statusesOf`'s first-wins
   rule.

2. **References must point at something the runtime issued.** These checks
   need the task state, which the stateless server does not have, so they run
   in the runtime as contract issues:
   - a criterion id in a report or review that the brief does not number;
   - a finding id in a report's resolutions, or in a review's closed findings,
     that no `findings` call of this task issued. Open findings are not
     checked: the reviewer prompt sends minor findings straight into the
     review, so a new id there is legitimate. A new blocking one with rounds
     left is caught by point 3.
3. **The normalized verdict decides the next step.** `checkReview` runs as soon
   as the review is read, before the transition. The transition reads its
   verdict, not the reviewer's:
   - `rejected` with rounds left: correction round. Its findings come from the
     `findings` call of the same turn. Without one, the reviewer gets one repair
     turn that asks for it. If it still does not come, the review goes to the
     leader with the contract issue.
   - `rejected` with no rounds left, `with_reservations` or `approved`: the
     review ends, as today.
4. **Coherence is checked for every verdict.**
   - A blocking finding still open, or a failed axis, makes the verdict at
     least `rejected`.
   - A `rejected` verdict with neither is incoherent: one repair turn asks the
     reviewer to name the blocking finding or correct the verdict.

   Every change of verdict is a contract issue the leader sees, as
   `verdict-lowered` is today.

5. **One turn, one outcome.** When a turn calls both `review` and `findings`,
   point 3 decides: the findings are used only for a correction round.
   Otherwise they are dropped, and the drop is a contract issue.

## Budget

- **Code:** `handoff-server.ts` (the keyword), `handoff.ts` (schemas),
  `contract.ts`, the transition in `reviewed()`, and their tests. About 200 lines
  of production code. No change to `apps/vscode`.
- **Prompts:** at most one sentence in `reviewer.md` on unique ids. The repair
  prompts already exist and are reused.
- **Nothing visible changes** for the user beyond contract issues in the thread.
- **No dependency,** no new setting, no change to the persisted task record of
  [ADR 0039](0039-resume-interrupted-tasks.md). A task saved before this ADR
  resumes with the new rules.
- **Out of scope:**
  - a gate before the reviewer;
  - enforced scope;
  - session lifecycle;
  - brief references.

  Each gets its own ADR.

## Consequences

- **A report or a review can no longer contradict itself** on an id, and a
  rejection with rounds left always reaches the implementer or says why not.
- **Up to one more reviewer turn** when the verdict and the findings disagree.
- **Bench results before this ADR** may count as approved some reviews the new
  rules would lower.

## Live check

Four runs of a local bench scenario on 2026-11-22: leader Codex `gpt-6.1-terra`
low, implementer Claude Sonnet 5.5 low, reviewer Claude Haiku 5.5 medium. A
seeded defect, and in two runs a note injected into one turn
(`OOC_BENCH_FIRST_TURN_NOTE`, `OOC_BENCH_REVIEWER_FIRST_TURN_NOTE` in
`dev/bench.ts`), pushed the loop off its usual path. Hidden tests passed 5/5 in
every run.

- **The correction round with real ids works:** `findings` R1 and R2, the
  implementer's answers, then closed in round 2, with no false `findings-unknown`.
- **Point 3's repair works:** a `rejected` review with blocking findings open and
  no `findings` call got the repair turn, then the reviewer called `findings`,
  then a correction round started. Before this ADR, that review would have gone
  to the leader.
- **One fault found and fixed:** the first version checked open findings against
  issued ids, so a minor finding sent straight into the review was flagged.
- **Not reached live:** a lowered `with_reservations` and dropped findings. Haiku
  would not write an incoherent review even when told to. The unit tests cover
  both.
