# 0007. D13: Visibility and constraints for native subagents

Status: Accepted (iteration 1)

## Context

In the second demo run, Codex spawned its own subagent, `/root/claude_review`, at `medium` effort instead of `low`. It presented the response as a Claude review even though Claude had never run. Disabling native subagents would prevent this and would also remove a useful capability from both CLIs. Codex App Server has no protocol request for approving a subagent before it starts. [subagents.md](../subagents.md)

## Decision

- **Messages between agents** (Codex and Claude) go through the delegation block. The user can intercept and edit them.
- **Messages within an agent and its native subagents** are always visible in the thread under the turn that spawned them. A configurable policy per role constrains the model, effort, count, and name. These messages bypass interception.
- Apply constraints without modifying the user's configuration. Use thread overrides for Codex and the child process environment for Claude. The runtime checks after launch and stops the turn on any violation.
- The runtime labels who responded. If text attributes work to an external agent that never ran, show a warning.

## Consequences

- A noncompliant subagent can start and use some quota before being stopped because checks occur after launch.
- Adapters must report subagents as events (`onSubagent`) and propagate cancellation to them. The runtime stays provider-independent.
- On an `ephemeral` thread, a Codex subagent can start only without inheriting history (`fork_turns: "none"`). This was verified on a real turn. See the remaining limitations and verification details in [subagents.md](../subagents.md).
