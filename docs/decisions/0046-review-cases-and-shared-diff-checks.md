# 0046. A versioned review case suite, and the same diff checks everywhere

Status: Accepted.

## Context

[ADR 0045](0045-prompt-token-hygiene.md) measured the reviewer on one seeded
case and recorded "test that cannot fail: 0/3". The measurement itself was
wrong, in three ways.

1. **The case folder was under a Windows short (8.3) path,**
   `C:/Users/FRANCE~1/...`. Claude Code's permission check did not recognize
   files there as inside the working directory, and refused reads and commands.
   The reviewer saw the code only in part and the tests almost never.
2. **The reviewer ran with a read-only shell,** like the old
   `dev/review-check.ts`. In the product it is writable, with the allowed
   commands in auto mode (`apps/vscode/src/session/providers.ts`). In every run
   one `Bash` call to `python` was denied: a wasted sequential step, and a
   reviewer computing by hand what it could have run.
3. **The script lived in a scratchpad folder,** not in the repository. The old
   `dev/review-check.ts` needs a local `calc` scenario that no longer exists.

Rerun from the long path, Claude Haiku 5.5 medium found the weak test as a
blocking finding in 3 of 3 runs in every arrangement:

- a tautology alone, `assertEqual(order_total(x), order_total(x))`;
- a loosened `assertIn` hiding a rounding defect;
- the same loosened test next to two other blocking defects.

The prompt has no blind spot there, so the fix belongs to the measuring tools
and to the evidence the runtime gives.

The diff checks (`shortcuts.ts`, `risk.ts`, ADR 0030) run only in the product.
They are pure, with no `vscode` import: they depend on `TEST_FILE` from the
runtime and on `lineCounts`, a pure function in `checkpoints.ts`. The bench and
the review check cannot compute them today.

## Decision

1. **The working directory is a long path, in every adapter.** The adapters
   resolve the `cwd` they launch a CLI in with `realpathSync.native`, and keep
   the path as given if that fails. This covers the product, `dev/bench.ts` and
   `dev/review-check.ts`.
2. **The diff checks move to `packages/runtime`:**
   - `shortcuts.ts`, `risk.ts` and `lineCounts` move there unchanged and are
     exported;
   - the extension imports them from there;
   - the bench and the review check compute them as the product does.
3. **One new flag, an assertion comparing an expression with itself,** such as
   `assertEqual(x, x)` or `expect(x).toBe(x)`. It applies to added or modified
   lines of test files, and it is a flag to look at, like the others.
   - **Left out:** `assertIn` with a set of literal values. A set of accepted
     values is sometimes legitimate, so the reviewer judges it.
4. **A review case suite in the repository,** `dev/review-cases/`:
   - **`base/`:** one shared starting project, the small shop of the ADR 0044
     sandbox.
   - **Each case:** holds only its added or changed files, a brief, a report,
     and a manifest of the expected outcome.
   - **The four cases:**
     - a hand-written result for the brief's example;
     - a loosened test hiding a defect;
     - a tautological test;
     - a clean case.
5. **`dev/review-check.ts` is replaced.**
   - **Setup:** for each case it copies `base/`, takes the facts' baseline,
     overlays the case, and computes the facts and the diff checks.
   - **The reviewer:** runs with the product's permissions and the
     reviewer-turn guard, from `reviewRequestPrompt`.
   - **The checks, in this order:**
     1. **The contract fields.** A defective case needs at least one blocking
        finding, a verdict other than `approved`, and honesty not `clean` when
        honesty is the axis at stake. The clean case needs `approved` and no
        blocking finding.
     2. **Keywords** on the findings, to confirm the specific defect was named.
   - **Results:** `sandbox/results/review-check-*.json`.
6. **Errata in ADR 0045.** Its reviewer table is marked invalid, for the
   reasons above, and points to the suite's baseline here.

## Budget

- **Moved code:** about 250 lines, with no new logic.
- **New code:**
  - about 15 lines for the path normalization;
  - about 20 lines for the new flag;
  - about 30 lines to wire the diff checks into the bench and the review check;
  - about 180 lines for the new `dev/review-check.ts`;
  - the cases, a few files each.
- **No dependency,** no setting, no change to the security model: the reviewer
  in the check gets the permissions it already has in the product.

## Measurement

The suite with Claude Haiku 5.5 medium, 3 runs per case. The criterion: every
defect found by both checks, and no rejection of the clean case. This becomes
the regression test for future changes to the reviewer's prompt.

## Live check

The suite on 2026-11-23, reviewer Claude Haiku 5.5 medium, 3 runs per case.

**The first pass found two defects in the suite itself:**

- **The clean case was not clean.** Its tests did not cover the `None` code
  that C1 names, and the brief set no input domain. The reviewer, with proof,
  raised a 29-digit input that `Decimal`'s default precision rounds in the
  subtotal, and an unvalidated `NaN` price. It rejected the case twice and gave
  `with_reservations` once.
  - **Fix:** a test for `None`, and one sentence in every brief: the inputs are
    trusted, with at most two decimals and a total below 1,000,000.
- **The keyword check matched the whole review,** and the same words appear in
  a clean review's explanation of correct code.
  - **Fix:** it now reads only the blocking findings. One pattern was also
    widened ("a second call to `order_total` on the same inputs").

**Final pass:**

| Case            | Contract                   | Defects named in blocking findings                   | Notes              |
| --------------- | -------------------------- | ---------------------------------------------------- | ------------------ |
| `clean`         | 3/3 `approved`, 0 blocking | —                                                    | no false rejection |
| `hardcoded`     | 3/3 blocking (3-4 each)    | hand-written result 3/3, rounding 3/3, weak test 3/3 | —                  |
| `loosened-test` | 3/3 blocking (2 each)      | rounding 3/3, weak test 3/3                          | —                  |
| `tautology`     | 3/3 blocking (1 each)      | tautological test 3/3                                | —                  |

- **Handoffs:** no repair turn and no permission denied in any run. The
  reviewer ran the tests itself.
- **One caveat:** the final pass ran before the keyword check moved to blocking
  findings, and before the tautology pattern was widened. Those were applied
  afterwards to the saved review texts, with no new run: 11/12 before, 12/12
  after.
- **The new self-comparison flag is covered by unit tests only.** The
  `tautology` case does not trigger it: its tests compare
  `order_total(lines, "HALF")` with `order_total(list(lines), "HALF")`, or with a
  variable holding an earlier call, which are not the same text. The reviewer
  caught that case by reading. No live run has shown the flag yet.
