# 0038. Review cycles, red-green verification, and handoff status

Status: Accepted.

## Context

[ADR 0029](0029-reviewer-findings-and-review.md) and
[ADR 0033](0033-reviewer-always-and-direct.md) define a bounded cycle in which the
reviewer can write tests and ask the implementer for corrections.
[ADR 0036](0036-verification-traceability.md) links reported commands to observed
activity. The runtime currently gathers verification facts after implementation,
before the reviewer may change the tests. Its recorded result can therefore
precede the final test changes.

The [verification roadmap](../roadmap.md) also calls for independent red-green
verification. That comparison measures whether the tests detect the requested
behavior change. The review cycle verifies corrections against the current tests.
[ADR 0037](0037-persist-implementer-handoff.md) persists handoffs whose pending
state should be visible in the dial.

## Decision

1. **Reuse the existing bounded review cycle.** The implementer completes the
   work and the reviewer assesses behavior and test quality. The reviewer can
   add or rewrite tests during its normal turn. Findings return to the
   implementer and the reviewer checks the corrections within the configured
   limit. Exhausting the limit with unresolved findings produces an explicit
   unresolved outcome. Verification adds local command executions without
   dedicated model turns to select tests or describe results.
2. **Verify the tests that actually remain after review.** Run the configured
   verification command after each reviewer turn and its file guard have
   completed. Associate the outcome with that exact workspace and test state.
   A successful run from before the reviewer changed tests cannot validate the
   new state. Reuse an existing runtime result only if its relevant inputs
   are unchanged. Carry runtime failures into the remaining correction cycle.
   If a reviewer approves but runtime verification fails, retain both outcomes
   and prevent the work from being presented as successfully verified.
   Merge actionable test failures with the reviewer's findings and send them
   to the next implementer correction turn. Use the same correction budget for
   both sources. At exhaustion, deliver the unresolved outcome to the leader.
   Setup failures, missing dependencies, and timeouts produce an inconclusive
   outcome delivered with its reason. They do not trigger automatic agent turns
   to repair the environment.
3. **Add one red-green comparison for the final test version.** Capture the
   starting implementation immediately before the first implementer work turn
   for the task. Preserve any changes already present at that point. At the
   end of the cycle, use the reviewer's selected acceptance test and final test
   files on the starting implementation and the final implementation in
   isolated directories. Preserve the starting implementation when applying
   the tests. Start with one identified test. Use the final runtime verification
   as the green-side evidence when it ran that identical test version and
   implementation, avoiding a duplicate execution. Run the baseline comparison
   once for the final selection.
   When the reviewer is disabled, use the implementer's selection from its normal
   report. Persist and show whether the selection came from the implementer or
   reviewer. Runtime execution remains independent of that selection.
4. **Record the meaning of the comparison.** Confirm red-green only when the
   identified test fails for the expected behavior on the starting implementation
   and passes on the final implementation. Record an already-passing baseline
   separately. Missing dependencies, timeouts, missing tests, unsupported results,
   or incomplete baseline inputs produce an inconclusive or unavailable result
   with a reason. Use test-level outcomes. Keep red-green evidence and the
   review verdict distinct. The configured command runs under the applicable
   workspace trust and permissions. Stop cancels verification.
   An already-passing baseline or an inconclusive baseline comparison is
   reported to the leader without starting an additional correction cycle.
5. **Keep the existing delivery modes.** Automatic delivery runs the implementer
   and reviewer in sequence. Manual delivery retains its current approval
   boundaries, including automatic review exchanges.
   The baseline serves the red-green comparison. Concurrent manual edits require
   fresh evidence for the final state and cannot be attributed by this comparison.
6. **Keep the panel compact and use native VS Code navigation.** Reuse the
   existing work status and Verified Facts area for a short outcome summary and
   correction progress while work runs. Provide access to the relevant tests,
   implementation files, and detailed evidence through native VS Code editors
   and existing file navigation. Keep command output, code, and full test reports
   in those editors. Evidence can use a read-only document backed by persisted
   work-item data. Keep the review verdict, runtime result, and red-green result
   available in the detailed evidence, including the test selection's origin.
   Restore the summary and evidence on chat reopen. Use typed, validated messages.
   Resolve navigation targets in the host from recorded evidence and validate
   workspace file paths. Preserve historical chat rendering.
7. **Show pending handoffs in the implementer dial.** Display **Handoff pending**
   when the summary is saved and explain that the next work request can use it.
   Restore the state on reopen and disable a second handoff while one is pending.
   Keep it after Stop or failure. Clear it when the replacement session ID is
   saved under ADR 0037. Send the status without the summary in dial session data.

8. **Use JUnit XML for the initial test result format.** Configure the project's
   verification command to produce a report in the supported JUnit structure.
   Identify the selected test unambiguously and distinguish assertion failures,
   errors, skipped tests, and missing test results. The report fields identify
   the criterion, selected test, expected failure, and test files. Obtain them
   through the agent's normal report. Unreadable, ambiguous, or unsupported
   reports produce an inconclusive result. Parse reports with bounded input and
   disable external entities and DTD processing. Preserve the existing ordinary
   verification command outcome when comparative evidence is unavailable.

## Implementation constraints

- Reuse command configuration, report validation, and checkpoint storage where
  they can faithfully represent the required inputs. Choose bounded setup,
  execution, and cleanup for isolated directories.
- The command uses a `{junit}` argument placeholder for a report in
  extension-owned storage. Dependency copies are limited to 30 seconds,
  100,000 entries, and 512 MiB. Workspace dependency links point to captured
  source. External links, incomplete checkpoints, and changed package or
  dependency manifests produce unavailable comparative evidence.
- Preserve raw JUnit reports as checkpoint artifacts. Native document links
  resolve recorded hashes, and the panel opens the selected test through
  the existing validated file action.
- Store evidence with the chat or in extension-managed storage. Native editor
  navigation should not require generated report files in the user's project.
- Independent test authoring before viewing the implementation and full-suite
  comparison on the baseline remain follow-up roadmap work.

## Completion criteria

- Simulated providers exercise reviewer-written and rewritten tests, an
  implementer correction, a successful recheck, and exhaustion of the correction
  budget. Runtime verification observes the retained files after the review guard.
- A reviewer approval followed by a failed runtime check remains visibly
  unresolved. A stale successful result cannot validate changed test inputs.
  Actionable failures consume the existing correction budget. Setup failures
  reach the leader as inconclusive without automatic environment-repair turns.
- Synthetic repositories cover expected red-green, an already-passing baseline,
  a failing final test, a missing test, setup failure, timeout, and incomplete
  baseline inputs. Initial local changes belong to the starting state.
- Comparison adds no dedicated model turns. An unchanged final test and
  implementation reuse valid green-side evidence. Stop cancels execution and
  verification leaves the live files and Git index intact.
- Work without a reviewer can use the implementer's selected test and records
  its origin. Tests cover malformed JUnit, ambiguous identities, skipped tests,
  and external-entity payloads.
- The chat shows compact cycle progress and final outcomes, including after reopen.
  Links open files and detailed evidence in native VS Code editors. Invalid
  navigation targets are rejected by the host.
  The dial preserves pending handoff status after reopen, Stop, and failure,
  and clears it after successful replacement-session persistence.
- `pnpm check` and `pnpm test:e2e` pass with simulated providers.

## Implementation steps

- [x] Add optional test selection to existing handoff tools and parse bounded
      JUnit reports. Use the existing locked `sax@1.6.1` as a direct dependency,
      rejecting DTDs and external entities.
- [x] Verify retained files after review, merge actionable failures into the
      existing correction budget, and retain final structured evidence.
- [x] Reconstruct checkpoint inputs in temporary directories, overlay only test
      files, compare the selected test, and handle cancellation and incomplete inputs.
- [x] Add compact evidence navigation and pending handoff status, then run
      synthetic security cases, `pnpm check`, and isolated Extension Host tests.
