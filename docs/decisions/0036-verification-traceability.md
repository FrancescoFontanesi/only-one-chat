# 0036. Traceability for reported verification commands

Status: Accepted. Implemented.

## Context

[ADR 0030](0030-diff-checks.md) adds deterministic diff checks to the extension's verified facts.
The extension can also run a configured verification command and report its result. Both sources
describe what the extension itself measured.

[ADR 0035](0035-handoff-tools-and-english.md) makes implementer reports and reviewer verdicts
structured MCP handoffs. Each criterion has a status and free-text evidence. A handoff can
currently say that a command passed without linking the statement to a command the CLI reported.

The adapters already emit command steps, with different levels of detail. Codex can report a
numeric exit code. Claude Code reports a Bash tool result with a success or error status but
without a numeric exit code. ACP can expose a display title and tool status without the original
command or its exit code. Permission requests and incomplete steps also need to be distinguished
from completed invocations.

## Decision

1. **Let agents cite verification commands explicitly.** The `report` and `review` handoffs
   may include structured command references for each criterion. Retain the evidence prose for
   test names, relevant output, manual checks, and the explanation of how the evidence relates to
   the criterion. Current handoffs without command references remain valid.
   Each criterion can cite up to eight commands of up to 2,048 characters each.
2. **Match references against the same role and round.** The runtime uses command events from
   the attempt producing the handoff, including its follow-up turn if one is used to recover a
   missing handoff. A different role, a different request, and earlier verification or correction
   rounds cannot supply evidence for the current handoff. Use an exact match against the command
   text exposed by the adapter, allowing surrounding whitespace. The Codex adapter can also
   expose the literal input from the recorded Windows PowerShell launcher form. Other wrappers,
   shell equivalence, aliases, output text, and display titles are insufficient for a match.
   When a command ran more than once, preserve the observed outcomes in order.
3. **Show what was observed.** For each cited command, show one of:
   - **Observed with an outcome.** Show the exit code when available, otherwise report the
     provider's tool outcome as such. Preserve failures alongside successes.
   - **Observed with an incomplete outcome.** An invocation was observed, and no outcome was
     available. This includes an invocation interrupted before a result arrived.
   - **No matching command observed.** The runtime could not associate the citation with an
     invocation in scope. A denied permission request alone provides no evidence of execution.
4. **Keep the evidence advisory.** Show the assessment in a separate part of the handoff card
   and send it in the runtime's facts outside the framed report or review. Include it when the
   leader reads the handoff later. Preserve the agent's own
   handoff, status, and verdict. For example, a failing command can be the expected result of a
   baseline test. An observed command provides evidence of the invocation and any reported
   outcome. Coverage of a criterion remains a judgment for the reviewer and the recipient.
5. **Reuse the existing command stream.** The MCP handoff server continues to validate arguments
   without side effects. Correlation requires no additional model turns, command executions, or
   dependencies. Preserve the existing CLI permission rules. Match command text in memory.
   The assessment shows the criterion, reference number, and outcome. Full command text remains
   in the existing activity view when available. The extension's
   configured verification command remains a separate source of evidence. This applies to any
   toolchain in the user's workspace.
6. **Restore pending reviews on chat reopen.** Chat history accepts pending items whose source
   is `review`, alongside delegations and direct implementer reports. This preserves a review
   requested directly by the user and its evidence until the leader receives it.

## Consequences

- Users and agents can see which command claims have supporting records and where a provider
  exposed less detail. A report can still be useful when a command reference has no match.
- An invocation and its result provide evidence at that point in the work. Independent red-green
  verification, test quality, and coverage of acceptance criteria remain separate roadmap items.
- Historical handoffs keep loading without command references or an evidence assessment.

## Completion criteria

- An implementer report and a reviewer verdict can cite a command and receive an assessment in
  the chat and in the message delivered to the next role, including deferred delivery.
- Tests with fake CLIs cover numeric success and failure, a tool outcome without an exit code,
  an interrupted invocation, a denied request, a citation without a match, and handoff recovery.
- Tests verify that evidence cannot come from another role, request, or round. They preserve
  multiple outcomes for repeated commands and accept handoffs without command references.
- Tests cover malformed references, denied permissions, and command text containing synthetic
  secrets or prompt delimiters. The assessment contains no copy of the cited command text.
- `pnpm check` and `pnpm test:e2e` pass before the implementation commit. Tests require no live
  provider sessions.
