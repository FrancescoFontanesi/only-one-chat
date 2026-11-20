# 0033. Review every job, including direct work, and expose review in the UI

Status: Accepted. Supersedes the review trigger in ADR 0032, retaining risk in verified facts. Extends ADR 0029.

## Context

- **In the fourth evaluation** (`docs/role-evaluation.md`, 2026-11-18), Sol as leader, Sonnet as implementer, and Haiku (high) as reviewer passed all hidden tests from a common request. Haiku found two real defects missed by the tests and by Hydrogen (high) on the same input. The defects were corrected, and Haiku cost about 8% of the work.
- **The roles divide reasoning, implementation, and verification.** A low-cost model that reviews well and reports to the leader can review each change without a risk threshold.
- **Work requested directly from the implementer** reached the leader without review, and the user had no way to request a review independently.

## Decision

1. **The reviewer reviews all implementer work,** including leader delegations and direct user messages. The leader sees the review in place of the report. Remove `onlyOneChat.reviewer.trigger` and its risk threshold. Keep the risk estimate (ADR 0032) in the facts shown to reviewer and leader.
2. **The `review` runtime mode** uses the ADR 0029 findings cycle to review work without a leader delegation or turn, ending in `delegated`. It accepts either of the following requests.
   - The user's direct message to the implementer (`direct`). Contract checks apply only to briefs.
   - A user request to the reviewer (`asked`), with the latest job's brief and report, or the work the user identifies if the chat has no prior job.
3. **The leader receives every review.** Like a direct report, the review waits for the user's next leader message and identifies its origin, such as a review requested directly by the user.
4. **The interface exposes the reviewer.**
   - Address the composer to the reviewer as to the other roles (historically `/rev`).
   - The reviewer is the third dial role, with provider, model, reasoning level, and an On/Off switch.
   - The reviewer is node C on the Squad board, below the leader and implementer. Work and findings connect it to the implementer, and the review goes to the leader. The disabled reviewer remains visible, with reports again connecting the implementer directly to the leader.
   - The switch writes `onlyOneChat.reviewer.enabled` and takes effect immediately, including in the current chat. The reviewer session lasts for one review.
5. **The reviewer is enabled by default** with Claude Haiku at high reasoning.

## Consequences

- Each job takes extra turns on a low-cost model and more time (U3 took 553 seconds compared with 301 seconds for Sol alone).
- The reviewer CLI starts with the chat even when review is off so it can be enabled later. If the CLI is missing, the chat starts with review off and shows a notice.
- A manually requested review reaches the leader with the next user message, without an extra turn.
- Deferred work includes showing the reviewer and its context as a third agent in the Activity panel and running a live review of a direct message.
