# 0043. The implementer session is reused across delegations

Status: Accepted.

## Context

The implementer keeps one CLI session for the whole chat. The reviewer opens a
fresh one for each review. A proposal held that a fresh implementer session per
task would avoid three costs:

- context carried over from earlier tasks;
- a growing history paid on every call;
- briefs left incomplete because the implementer "remembers".

A first measurement, on two tasks in the same module, found the fresh session
more expensive. The decision waited for
[ADR 0044](0044-brief-references.md) (references in the brief) and
[ADR 0045](0045-prompt-token-hygiene.md) (lighter role prompts), and for a
longer, mixed chain.

The rule under test reset the session on a new delegation in two cases:

- when its perimeter (`paths` ∪ `references`) was disjoint from the previous
  task's (`paths` ∪ changed files);
- when the previous task was degraded.

The runtime already has what such a rule needs:

- **The previous task:** `SavedTask` in the chat record, including
  `lastCompletedTask`, survives a restart of VS Code.
- **The point of decision:** since the implementer session opens lazily, the
  moment of delegation is where the session is chosen.

## Measurement

On 2026-11-23, four tasks in sequence on the base project of
`dev/review-cases/base/` (31 files, no dependencies):

| Task | Module             | Work                                   |
| ---- | ------------------ | -------------------------------------- |
| T1   | A                  | `order_total`                          |
| T2   | A, close follow-up | a `vat` parameter                      |
| T3   | B, disjoint        | `shipping_cost` in the shipping module |
| T4   | A, after B         | zero and negative quantities           |

**Setup:**

- fixed briefs with `paths` and `references`, sent straight to the
  implementer, Claude Sonnet 5.5 low;
- 15 hidden tests, checked against a reference implementation and against one
  that rounds VAT twice;
- 2 runs per variant, variants alternated.

**The variants:**

- `same`: one session for the chain;
- `new`: a fresh session for each task;
- `rule`: what the proposed rule does, reusing on T2 and resetting on T3 and T4.

Cost is in input units with Sonnet's weights: `input + 1.25 × cache_write +
0.1 × cache_read + 5 × output`.

| Variant  | Task      | Steps    | Cache read | Cache write | Output | Cost      | Time | Hidden tests |
| -------- | --------- | -------- | ---------- | ----------- | ------ | --------- | ---- | ------------ |
| same     | T1        | 3/3      | 45.0k      | 12.3k       | 1.8k   | 29.0k     | 18 s | 5/5 5/5      |
| same     | T2        | 3/3      | 64.3k      | 2.0k        | 1.3k   | 15.6k     | 17 s | 3/3 3/3      |
| same     | T3        | 3/3      | 72.5k      | 2.0k        | 1.5k   | 17.4k     | 18 s | 4/4 4/4      |
| same     | T4        | 2/2      | 62.0k      | 2.6k        | 1.1k   | 15.0k     | 13 s | 3/3 3/3      |
| **same** | **chain** | **11.0** | 244k       | 18.9k       | 5.8k   | **77.0k** | 66 s | 15/15        |
| new      | T1        | 3/3      | 48.7k      | 9.6k        | 2.0k   | 26.7k     | 17 s | 5/5 5/5      |
| new      | T2        | 5/4      | 74.4k      | 5.9k        | 1.9k   | 24.1k     | 17 s | 3/3 3/3      |
| new      | T3        | 5/4      | 72.5k      | 5.5k        | 2.0k   | 24.0k     | 23 s | 4/4 4/4      |
| new      | T4        | 5/4      | 73.2k      | 5.6k        | 1.5k   | 21.7k     | 15 s | 3/3 3/3      |
| **new**  | **chain** | **16.5** | 269k       | 26.7k       | 7.2k   | **96.4k** | 73 s | 15/15        |
| rule     | T1        | 3/3      | 48.1k      | 9.2k        | 1.8k   | 25.3k     | 17 s | 5/5 5/5      |
| rule     | T2        | 3/3      | 64.4k      | 1.9k        | 1.3k   | 15.5k     | 16 s | 3/3 3/3      |
| rule     | T3        | 5/5      | 80.4k      | 5.9k        | 2.2k   | 26.4k     | 23 s | 4/4 4/4      |
| rule     | T4        | 4/4      | 65.7k      | 5.6k        | 1.5k   | 21.1k     | 15 s | 3/3 3/3      |
| **rule** | **chain** | **15.0** | 259k       | 22.6k       | 6.9k   | **88.4k** | 71 s | 15/15        |

- **Noise:** T1 is a fresh session in every variant and varies from 25.3k to
  29.0k (±7%). The differences on T2-T4 are well above it.
- **Switching module, T3:** a fresh session cost 52% more than the reused one
  (26.4k against 17.4k) and took two more steps. The reused session did not do
  worse: 3 steps, 4/4.
- **Returning to module A, T4:** the reused session still knew module A from
  two tasks earlier: 15.0k and 2 steps, against 21-22k and 4-5 steps fresh.
- **Where a fresh session spends:** writing its prefix to the cache again, and
  exploring again, even with `references` in the brief.
- **Quality:** the same in every variant.

**Limits:**

- 2 runs per variant, one implementer model;
- a small repository, where a module is reread in a few steps;
- the largest context, about 80k tokens read from the cache, was far from the
  window.

A large repository or a much longer chain may weigh differently. Neither is
measured.

## Decision

1. **The implementer session stays reused across delegations,** as today.
2. **No reset on disjoint perimeters.** On the measured chain it costs 15% more
   than reuse, for the same quality.
3. **A reset after a degraded task stays an open hypothesis.** It covers the
   case of rounds used up, a blocked or cancelled task, or a rejected review.
   It was deliberately left out of the chain, so there is no data either way.
   A future ADR may take it up, after a dedicated measurement with a dirty
   context.
4. **Every brief is self-contained,** even though the implementer remembers:
   the reviewer opens a fresh session for each review and judges on the brief
   alone. The leader prompt loses the sentence saying a follow-up needs only
   `goal` and `acceptance_criteria`.

## Consequences

- **No production code changes,** beyond the one prompt sentence.
- **The bench counts sequential steps per script message and role,** so that
  chains can be compared task by task.
- **The measurement scenario is local** (`sandbox/scenarios/adr43chain`, ignored
  by Git). Its briefs and hidden tests are summarized above.
