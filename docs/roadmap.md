# Roadmap for independent, executable verification

This document records the proposed direction. Implementation details remain open and
each item needs an ADR when implemented. Existing decisions are recorded in
[ADR 0018](decisions/0018-delegation-cycle.md),
[ADR 0020](decisions/0020-role-prompts-brief-report.md), and
[ADR 0029](decisions/0029-reviewer-findings-and-review.md).

## Established principles

- **The user and leader reason and approve together before delegating.** The user
  supplies ideas and guides the project. Delegation remains under their control.
- **Define roles first.** The main nodes define leader, implementer, and reviewer.
  Each node uses its own provider's subagents, tracked by the runtime. Those subagents
  already handle broad reading tasks on lower-cost models.
- **The user chooses the leader.** When the leader runs out of quota, its replacement
  resumes from KnowNex's memory.
- **The leader receives references to changed files.** The diff stays outside the
  leader's context.
- **The reviewer challenges the work independently.** The user chooses a provider
  that reviews well at reasonable cost and can give the leader a detailed report.
  Reviewer and implementer exchanges have a round limit.
- **Use native CLI permissions.** These are the sole permission layer.

## Rationale

Conventional agentic coding can produce poor results when the model that writes the
code also supplies the evidence that the code works. A second model's opinion on the
diff still leaves the claim untested. The proposed standard is **independent,
executable verification**. Multiple providers help distribute quota and can
independently derive an implementation and its verification from the same brief.

## Proposed sequence

The first two steps are deterministic and consume no model quota. They immediately
improve the verified facts available to the agents. Each step records its status.

### 1. Deterministic diff checks

Add checks on the diff to the verified facts in `apps/vscode/src/session/facts.ts`.
The runtime can identify:

- **Weakened tests**, including deletions, added `skip`, removed assertions, and
  regenerated snapshots.
- **Disabled or weakened checks**, including `eslint-disable`, `any`, lowered thresholds,
  and changes to CI configuration.
- **Scope and contract changes**, including edits outside the brief's constraints,
  changes to the lockfile, and changes to the agreed public interface.
- **Unsupported claims.** The runtime already observes turn activity (ADR 0019).
  It can flag a report that claims to have run tests when the command is absent from
  that activity.

[ADR 0030](decisions/0030-diff-checks.md) implements checks for removed tests, reduced case and assertion counts, added `skip` or `only`, disabled checks, and changes to lockfiles or check configuration. [ADR 0036](decisions/0036-verification-traceability.md) defines how to link reported verification commands to observed command events. Detecting edits outside the brief's scope and changes to public interfaces remains open.

### 2. Red-green verification across two worktrees

Apply the SWE-bench patch test protocol to every brief:

- **Baseline.** New tests must fail to show they exercise the requested change.
- **Result.** New tests must pass.
- **Existing tests.** They must pass both before and after the change.

A Git worktree for the baseline costs one extra test run. It addresses a gap seen in
the role evaluation, where claims that tests failed before the change could not be
verified.

Pending. The implementer reports tests it saw fail (ADR 0029), and independent
verification is still missing. Worktrees also support step 6 and parallel implementers.
Verify how each CLI behaves in a worktree and what untracked files it can see.

### 3. Agreement on examples

The model first interprets natural language and then acts. Make what the user approves
executable. For each criterion, the user and leader agree on input-to-expected-output
cases and, where the language supports it, the interface signature. Ten examples can
be read in twenty seconds and can resolve interpretation differences.

The leader prompt already requests this (ADR 0029). The runtime or reviewer still
needs to turn approved examples into tests. First rerun `dev/bench` to measure the
leader's ability to write these briefs.

### 4. Test authorship without access to the implementation

`dev/bench/hidden.ts` already supports hidden tests kept outside the working folder.
Extend this measurement mechanism to the product. The reviewer works in two phases:

1. **Before seeing the code**, write acceptance tests from the brief and examples.
   Freeze those tests and keep them hidden from the implementer.
2. **After implementation**, inspect the diff and challenge the work.

Agreement between the implementation and tests written by different models provides
strong evidence. Disagreement points to a bug or an ambiguous brief. Ask the user to
resolve the ambiguity. Recent research suggests that tests written after reading code
can inherit its mistakes and that anchoring tests to the specification matters more
than test count. The sources are preprints and pattern catalogs.

The reviewer prompt already asks the reviewer to record what to check before opening
the changes. Blind testing still needs a place for the reviewer to write files out of
the implementer's view, which depends on step 2. The cost is roughly one additional
derivation from the brief.

### 5. Verification depth by risk

The full process would slow small changes. Assign a risk level to the brief using the
expected change size, sensitive files, and affected public interfaces:

- **Low.** Implementer and red-green verification.
- **Medium.** Add the reviewer.
- **High.** Add blind tests and mutation testing on the diff.

Pending. When a reviewer is configured, it reviews each delegation that reaches review.

### 6. Mutation testing on the diff

Alter changed lines and check whether the tests detect each mutation. Restricting
mutations to the diff keeps the cost low. Meta uses model-generated mutants in
production.

Pending. Implement this last because it applies only to high-risk changes and
requires worktrees.

### 7. Role selection based on observed performance

Each brief produces measurements such as passing on the first attempt, review rounds,
findings raised and contested, and quota consumed. Aggregate them by model, role, and
repository to evaluate real work continuously without dedicated benchmark runs or
extra quota.

The runtime records a `reviewed` event with the reviewer, implementer, verdict, and
rounds in each chat's JSONL log. Aggregation and a view remain open.

### 8. Worktree and brief as task state

If task state is the worktree, brief, and latest report, one implementer can replace
another mid-task without session memory. An implementer who runs out of quota can be
replaced by one who receives the brief and latest report. The leader can also choose
parallel implementers, each in its own worktree.

Each review round already replaces the whole report so the latest version stands
alone (ADR 0029). The implementer currently handles its own handoff (ADR 0017).
Changing providers remains open.

## KnowNex and leader changes

KnowNex (`F:/KnowNex`, developed in parallel) provides memory for changing leaders and
resuming work. It keeps an append-only local event feed, an explicit checkpoint at
which a Curator writes `STATE.md` and immutable notes, and provenance from each note
to its events. KnowNex remains optional under rule 7 of AGENTS.md.

- **Only One Chat as an event source.** It can write typed events for approved briefs,
  examples, outcomes by criterion, and review verdicts. They provide better input
  than raw hook messages.
- **Leader change.** Give the new leader `STATE.md` as part of its first prompt via the
  existing `preface` option. Pass uncurated events as a raw tail.
- **Curator in Squad.** Put the Curator on the Squad board with a different provider
  so it can still checkpoint when the leader's quota runs out.
- **Pending integration.** The Claude adapter recognizes quota exhaustion as
  `usage_limit`. Use it to offer the user a checkpoint and leader change for approval.

## Known limits

- Code that is hard to test, such as interfaces and CSS, remains outside strict
  verification.
- A faulty brief can mislead the implementer, reviewer, and tests simultaneously.
  User approval of examples helps address this.
- Reported figures from the cited preprints have not been verified against the
  primary sources.

## Sources

- [Tests written after the code (arXiv 2607.05139)](https://arxiv.org/abs/2607.05139)
- [Specification Grounding Drives Test Effectiveness LLM Code](https://www.alphaxiv.org/abs/2607.06636)
- [Independent Test Generation in Multi-Agent Code Systems](https://agentpatterns.ai/patterns/multi-agent/independent-test-generation-multi-agent/)
- [Code-First Oracle Bias](https://agentpatterns.ai/anti-patterns/code-first-test-oracle-bias/)
- [Mutation-Guided LLM-based Test Generation at Meta (arXiv 2501.12862)](https://arxiv.org/pdf/2501.12862)
