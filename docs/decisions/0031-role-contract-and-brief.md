# 0031. The role contract and brief structure

Status: Accepted. Clarifies ADR 0020 on briefs and reports and ADR 0029 on the reviewer.

## Context

The three role evaluations (`docs/role-evaluation.md`) identified several gaps.

- **Serious failures could go unnoticed.** An empty review reached the leader as a report, an approved verdict could include unverified criteria, and a report could omit a changed file.
- **The brief had the greatest impact and went unchecked.** One brief contained conflicting criteria C6 and C7, which the implementer resolved silently. Three runs on the same input made different choices about visible behavior for an integer-valued float `n`. Each called its choice minor.
- **One hostile input escaped testing and review.** In T3, a null byte in a path crashed the program with a traceback while all 46 hidden tests passed.
- **A separate brief review turn was considered and dropped.** It added turns and abstraction. The idea remained for model evaluations only.

## Decision

1. **The runtime checks the role contract without a model** (`packages/runtime/src/contract.ts`). It records problems as runtime facts for the leader and displays them in the thread without prompting again.
   - **Report.** Each brief criterion `C1…Cn` has a status in `Verifica` (Verification), including ranges such as `C1–C10`. `completato` (done) requires all criteria to be verified and `Bloccato su` (Blocked on) to be empty. `Modifiche` (Changes) names every file the runtime saw change. The runtime flags text without a report.
   - **Review.** Cover every criterion. The runtime lowers an `approvato` (approved) verdict with an unverified criterion, an inconclusive assessment dimension, or an open finding to `con riserve` (with reservations). A negative assessment dimension or open blocking finding yields `respinto` (rejected). The leader sees why.
   - **Unrecognized format.** The runtime continues past unparseable content and limits checks to readable fields.
2. **The leader and implementer check the brief in existing turns.**
   - Before delivery, the leader checks criteria together for conflicts, including the order of checks. When requirements can collide, the brief names the one that takes precedence. If the work accepts external input, include at least one hostile example. Ask the user about any decision that changes the result for valid input or a user-visible message.
   - Before implementation, the implementer checks the criteria against one another and the code. Resolve conflicts according to the following order.
     1. Constraints and repository instructions.
     2. Security.
     3. Concrete cases.
     4. Prose.
     5. Implementer preferences.

     A user-visible conflict blocks the work with `bloccato` (blocked). Resolve other conflicts in the specified order and record them under Decisions as `Conflitto nel brief` (Brief conflict). Test hostile inputs such as empty or huge values, `..`, absolute paths, separators from another OS, null bytes, encodings, and symlinks. They should return a clear error without an unhandled exception. Check the project's versions before using an API.
3. **The report's Verification section also lists** the hostile inputs tested and the versions checked.

## Consequences

- The leader receives a list of omissions alongside an incomplete report or review.
- Brief conflicts become visible without an extra turn. The work either stops or the report records them under Decisions.
- The parser follows the prompt formats. Large deviations produce additional flags and do not block processing.
- The `calc-include` hidden tests cover hostile inputs including null bytes, `..\` with a backslash, `C:file`, UNC paths, and empty names. None may cause a traceback. Two of the five saved implementations, both from Sonnet, crash on the null byte. They provide real cases for evaluating a reviewer.
