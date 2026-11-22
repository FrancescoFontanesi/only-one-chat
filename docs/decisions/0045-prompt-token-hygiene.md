# 0045. Role prompt hygiene: one source for fields, rare modules on demand

Status: Accepted.

## Context

Each role pays its instructions and its handoff tool schemas in the cached prefix
of every model call. Measured on 2026-11-22, in characters:

| Role        | Instructions | Tool schemas |
| ----------- | ------------ | ------------ |
| Leader      | 8.6k         | 2.8k         |
| Implementer | 8.2k         | 4.1k         |
| Reviewer    | 11.8k        | 6.7k         |

An audit of the three prompts in `packages/runtime/prompts/` found three kinds of
weight.

1. **Duplication with the schemas.** The prompts describe every handoff field
   again, often word for word with the schema descriptions in `handoff.ts`:
   - the leader's brief fields, ~1.9k;
   - the implementer's report fields and the `outcome` rule, ~1.5k;
   - the reviewer's review fields and the verdict rule, ~2.0k.

   Some rules are also enforced by code: unique ids
   ([ADR 0040](0040-handoff-integrity.md)) and the review-versus-findings
   transition (ADR 0040, at the cost of a repair turn). Two copies of one rule
   can drift.

2. **Rare cases paid on every call:**
   - the web-app brief (`OOC-BRIEF` markers);
   - the implementer's direct-message paragraph;
   - the implementer's answer to findings;
   - the reviewer's rules for a follow-up round;
   - the JUnit selection when no `{junit}` command is configured.
3. **High-value rules mixed into the rest.** The honesty axis is the one prompt
   element `docs/role-evaluation.md` credits for catching a false report (0/2
   before it, 2/2 after it). The security list protects against what a risk
   heuristic could miss.

The adapters fix the instructions when a session opens:

- Claude Code passes the same `--append-system-prompt` on every turn;
- Codex sets `developerInstructions` when the thread starts;
- Antigravity, over ACP, puts them in the session's first message.

Changing them during a session is impossible for two of them, and would break
Claude's prompt cache.

The expected gain is modest: our part is about a quarter of each call's cached
prefix, so cutting it by a third saves roughly 8 to 10% of cache reads. The
stronger reason is one source per rule.

## Decision

1. **Fields are defined once, in the tool schemas.**
   - The prompts drop the field-by-field descriptions and keep only the
     judgment the schemas cannot express:
     - observable criteria with concrete cases;
     - a hostile input among them;
     - evidence as references, not contents;
     - only this turn's work;
     - the leader has not seen the code.
   - The schema descriptions stay authoritative and are tightened where they are
     verbose, with no change to the validation rules.
2. **Level 1, the session's instructions, keeps what applies to every turn:**
   - each role's identity, method and principles;
   - the reviewer's honesty and security axes in full;
   - the one-line rule "`findings` while a blocking finding is open and rounds
     are left";
   - the leader's evaluation of reports and reviews, compressed to the steps.

     It stays here because the leader's session lives across many tasks:
     repeating it in each evaluation turn would cost more from the second task
     on, and would fill the leader's history.

   - The JUnit selection, only when the session's workspace has a `{junit}`
     command. That configuration is fixed for the session, so the cache holds.
3. **Level 2, the turn message, carries rare modules, only on their trigger:**

   | Module             | Trigger                               | Turn that carries it   |
   | ------------------ | ------------------------------------- | ---------------------- |
   | Web-app brief      | `OOC-BRIEF` markers in the request    | the leader's turn      |
   | Direct message     | a message straight to the implementer | that turn              |
   | Answering findings | the first findings of a task          | `findingsPrompt`       |
   | Follow-up round    | a correction round                    | `reviewFollowUpPrompt` |

   The modules are Markdown files in `packages/runtime/prompts/modules/`,
   imported as text like the role prompts. They never change a session's
   instructions.

4. **Tidy First, in both roles that decide it:**
   - the implementer does not mix a structural refactoring with a change of
     behavior, and says so in the report if one was needed;
   - the leader puts the two in separate delegations.
5. **A guard against regrowth.** A test caps each role's Level 1 instructions at
   a character budget, with some margin, instead of a snapshot that breaks on
   every comma. A second test checks that each module appears on its trigger
   and never in the instructions.

## Budget

- **Prompts:** about 10k characters removed in all.
- **Code:** about 80 lines to load the modules and attach them to their turns,
  plus the tests.
- **No dependency,** no setting, no change to the security model or to the
  persisted task record.
- **Visible to the user:** nothing, except the agents' behavior. The
  measurement below checks that it does not get worse.

## Measurement

- **Prompt weight:** characters per role before and after, which are exact.
  The bench's first-turn cache writes give the tokens.
- **Implementer cost:** the fixed-brief A/B of
  [ADR 0044](0044-brief-references.md) (sandbox `adr44`, `References` arm), 3
  runs before and 3 after. Compare cache reads and writes, sequential steps and
  hidden tests.
- **Reviewer non-regression:** one fixed defective case on the same sandbox,
  reviewed by Claude Haiku 5.5 medium, 3 runs before and 3 after. The case
  holds three seeded defects:
  - a result written by hand for the brief's example;
  - rounding against the documented rule;
  - a test that cannot fail.

  The report claims everything verified. The criterion: no fewer defects found
  and no approval.

- **From the traces, at no cost:** no more handoff repair turns after the field
  descriptions leave the prompts, and no false rejection on the clean runs.

## Live check

Measured on 2026-11-22 and 23.

**Prompt weight**, role instructions as built, in characters:

| Role        | Before | After                    |
| ----------- | ------ | ------------------------ |
| Leader      | 9,180  | 5,804                    |
| Implementer | 8,638  | 5,344 (5,632 with JUnit) |
| Reviewer    | 12,300 | 7,674 (8,070 with JUnit) |

- **Leader:** came out above the audit's estimate. What is left is judgment.
- **Reviewer schemas:** grew by 0.3k (6.6k to 6.8k), because rules that were only
  in the prompt moved into them.
- **Honesty and security:** the two axes are verbatim, checked with a diff.
- **Caps:** the guard test caps each role at about 10% above these figures.

**Implementer**, the fixed-brief A/B on sandbox `adr44`, `References` arm,
Claude Sonnet 5.5 low, 3 runs each:

|                  | Before                   | After                                      |
| ---------------- | ------------------------ | ------------------------------------------ |
| Sequential steps | 3, 3, 4                  | 3, 3, 3                                    |
| Cache reads      | 51k, 51k, 67k (mean 56k) | 42k, 48k, 48k (mean 46k)                   |
| Cache writes     | ~10.3k                   | ~9.1k (15.4k on the first run, cold cache) |
| Turn time        | 24-25 s                  | 24-25 s                                    |
| Hidden tests     | 5/5 ×3                   | 5/5 ×3                                     |

Cache reads fell 19%, more than the 8-10% estimated, with the same steps and the
same quality.

**Reviewer non-regression**, one fixed defective case reviewed by Claude Haiku
5.5 medium, 3 runs each:

|                                      | Before                     | After                      |
| ------------------------------------ | -------------------------- | -------------------------- |
| Hand-written result for the example  | 3/3 blocking               | 3/3 blocking               |
| Rounding against the documented rule | 3/3 blocking               | 3/3 blocking               |
| Test that cannot fail                | 0/3                        | 0/3                        |
| Outcome                              | `findings` ×3, no approval | `findings` ×3, no approval |
| Handoff repair turns                 | 0                          | 0                          |
| Cache reads (mean)                   | 78k                        | 80k                        |

- **No regression.** The prompt missed the weak test before the cut as well.
- **Reviewer cache:** unchanged within noise. Its turns are dominated by the
  files it reads.

**Full product path**, two tasks on sandbox `adr43`: leader Codex
`gpt-6.1-terra` low, implementer Sonnet low, reviewer Haiku medium. Compared
with the two earlier runs on the old prompts:

- every `delegate`, `report` and `review` call was valid at the first attempt;
- no handoff repair turn, as before;
- both reviews `approved` in round 0, so no false rejection on a clean run;
- 10/10 hidden tests.
