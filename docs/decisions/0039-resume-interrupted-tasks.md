# 0039. Persist and explicitly resume interrupted tasks

Status: Accepted.

## Context

[Requirement R5](../requirements.md#r5-persistent-tasks) requires task state to
survive a restart and support explicit recovery.
[ADR 0037](0037-persist-implementer-handoff.md) persists pending implementer
handoffs. [ADR 0038](0038-verification-and-handoff.md) persists verification
evidence. The chat also retains CLI session IDs, pending delegations, reports
awaiting the leader, and checkpoints.

The active task's operational state is still partly held in memory. Closing
VS Code between an implementer correction and the next review loses the
structured continuation point and correction-budget accounting. A readable
conversation provides context, but recovery needs an explicit task record.

## Decision

1. **Persist one active task per chat.** Extend the existing chat record with an
   optional, versioned task record. Store a stable task ID, the approved brief or
   direct request, assigned roles and providers, phase, latest structured report,
   unresolved findings, correction limit and consumed corrections, and references
   to CLI sessions, the original baseline, latest workspace checkpoint, and
   verification evidence. Keep the latest completed task available for review.
   Historical evidence remains in the existing chat history.
2. **Record execution boundaries atomically.** Save the intended next step before
   dispatching work and save its result before advancing to another role.
   Reserve a correction from the task's budget before dispatching that correction.
   A restart preserves the reserved correction and the original limit. Settings
   changes and reopening the chat do not replenish the budget. If persistence
   fails, retain the last committed state, surface the storage error, and require
   reconciliation before further dispatch.
3. **Require an explicit recovery action.** Reopening a chat restores the task
   as interrupted when its execution was unfinished. Offer **Resume** and
   **Cancel task**. Resume first inspects the committed task record and the
   current workspace. A recorded completed implementer turn can continue with
   review or verification. An interrupted turn may have produced partial effects
   and requires reconciliation before deciding the next step. Recovery uses the
   saved state and existing CLI sessions without a model turn dedicated solely
   to reconstructing progress from the conversation.
4. **Check the current files before continuing.** Compare them with the latest
   recorded workspace checkpoint. Preserve edits made while the task was
   interrupted. Changes or unavailable checkpoints produce a clear recovery
   decision for the user before agent work continues. Existing diff navigation
   shows what changed. Original baseline references remain tied to the original
   task, and stale verification results lose their authority for changed inputs.
5. **Resume with the same roles and providers.** Preserve the task's execution
   configuration. Use the existing CLI resume and fresh-session fallback where
   supported. A fresh session receives the approved task, latest report,
   unresolved findings, and remaining budget as framed recovery context. Surface
   missing session history or incompatible current configuration. Store session
   identifiers and task data in extension storage under the existing credential
   protection rules.
6. **Keep recovery idempotent.** Repeated Resume clicks and overlapping panel
   events can dispatch at most one continuation for the active task. An execution
   intent without a committed outcome is uncertain and requires reconciliation.
   Discard obsolete approval and question IDs on restart. New permissions use
   the normal approval flow. Cancellation records a terminal state and retains
   the files and evidence produced so far.
7. **Keep the panel compact.** Reuse the task status and Verified Facts area for
   a short interrupted or recovery-required indication and the two recovery
   actions. Open detailed task state, findings, evidence, and file differences
   through native VS Code editors and existing navigation. Restore the same
   state when the chat reopens.
8. **Keep older chats readable.** Validate task records and their references
   before use. Missing task data retains the existing chat behavior. Malformed
   task data prevents automatic continuation and produces a recovery notice while
   preserving the readable history.

## Consequences

- Restarting between implementation, correction, review, and verification can
  preserve the next safe step and the correction budget.
- Recovery needs a user decision when the outcome or workspace state is
  uncertain. The task record supplies the context for that decision.
- This establishes a basis for later provider replacement and quota failover.
  Provider changes, parallel implementers, and integration with external memory
  remain follow-up decisions.

## Completion criteria

- Simulated providers exercise interruption before dispatch, during an implementer
  turn, after its result is saved, between correction and review, and during
  runtime verification. Reopen restores the task and its recorded budget.
- Resuming a completed implementation starts the pending review or verification.
  An uncertain outcome enters recovery-required state. Repeated recovery actions
  produce one continuation.
- Tests cover storage failure before dispatch and after a turn, partial task
  records, malformed references, unavailable baselines, changed files, expired
  CLI sessions, and obsolete approvals. Historical chats remain readable.
- Cancellation retains produced files and evidence and closes the task. Budget
  exhaustion remains visible after restart.
- Native editor navigation exposes recorded context and differences. The panel
  stays compact and restores its recovery actions when reopened.
- `pnpm check` and `pnpm test:e2e` pass with simulated providers.

## Implementation constraints

- Task progress is bounded to 512,000 serialized characters and configuration
  context to 128,000 characters. Invalid or oversized state stops further dispatch
  while retaining the last committed record.
- The task snapshot includes the command allow-list, subagent policy, verification
  settings, role instructions, provider choices, and executable paths. The saved
  correction budget is independent of subsequent round-limit settings.
- Confirming recovery after workspace changes clears cached review and verification
  authority and checks the current files. A prior committed implementer report
  remains available as historical context after an interrupted correction.
- An uncertain leader delivery is queued for the user's next leader message.
  Pending results use the task ID to replace older evidence for that task.
- Approved draft removal and the ready-to-implement task record share one atomic
  write. Original baseline identifiers remain recorded even if a checkpoint
  becomes unavailable.

## Implementation steps

- [x] Validate and atomically store the task record alongside existing chat data.
- [x] Record runtime execution intents and outcomes, preserve correction accounting,
      and restore verification and review continuation state.
- [x] Add explicit recovery and cancellation using native confirmation and file
      navigation, retaining a compact status in the panel.
- [x] Exercise interrupted turns, changed workspaces, failed writes, malformed
      records, and repeated recovery actions. Run the required checks before commit.

## Validation

Verified on 2026-11-22 with simulated providers, without live provider turns:

- `pnpm check`: build, typecheck, lint, and 659 tests passed; 3 tests skipped.
- `pnpm test:e2e`: 9 Extension Host smoke tests passed, including native task details.
- Recovery tests exercise 20 concurrent Resume calls, 100 hostile record variants,
  interrupted execution, expired sessions, failed writes, changed files, missing
  baselines, and deduplicated leader delivery. A regression test rejects an array
  used as a task phase, with failure confirmed before the strict type check.
