# Minimal orchestration loop (D6)

The runtime provides `leader` and `review` modes after the removal of experimental
modes in [ADR 0034](decisions/0034-remove-experimental-modes.md).
[ADR 0035](decisions/0035-handoff-tools-and-english.md) defines the structured handoffs
between roles.

The runtime code lives in `packages/runtime/src/` (`loop.ts`, `handoff.ts`,
`prompts.ts`, `brief.ts`, `agent.ts`, and `event-log.ts`). The Codex and Claude
agent adapters live in `packages/adapters/src/codex/agent.ts` and
`packages/adapters/src/claude/agent.ts`. `packages/runtime/test/loop.test.ts` uses
deterministic fake agents.

## Modes

`runLoop` requires an explicit `mode`:

- **`leader`** sends the user request to the **leader** (`leaderSession`). The leader
  responds directly or invokes the `delegate` tool to send a brief to the implementer.
  The extension uses this path.
- **`review`** (ADR 0033) handles work outside the leader's delegations, such as a message
  sent directly to the implementer or a review requested from the reviewer. It requires
  `reviewOf`, `workerSession`, and `reviewer`. The loop ends with `delegated` without
  a leader turn. The leader reads the result with a later user message.

ADR 0034 removed the `loop`, `question`, `pipeline`, and `gateway` modes, including
the `light` variant.

## Leader mode workflow

1. The user request goes to the **leader** in a read-only thread
   (`sandbox: "read-only"`) in the workspace. The session stays open between
   requests.
2. The leader replies or calls the `delegate` tool on the `ooc` MCP server. The runtime
   uses the last valid call in the turn, renders its arguments, and allows one
   delegation per request. A direct response ends the loop. An empty turn without any
   handoff call gets one additional turn.
3. The runtime **intercepts** a delegation for the user to approve, edit, or cancel.
   When automatic approval applies, the runtime sends it without waiting.
4. The **implementer** (worker) receives the approved text, streams a reply, and
   submits its outcome and acceptance checks through `report`. Later turns may
   resume the same session (`--resume` for Claude).
5. The runtime prepares the **review request** from the implementer's result and
   verified facts. If a reviewer is configured and the report's outcome is not
   `blocked`, the reviewer may call `findings` to request another implementation
   round, or `review` to finish. It can request corrections while review rounds
   remain. The runtime displays and logs these handoffs. Missing or invalid reports
   and reviews get a follow-up requesting the appropriate tool.
6. If the leader's readback is deferred, the result stays available for a later
   turn. Otherwise, the leader reads the review, or the implementer's result when
   there is no review, and responds to the user.

**Brief from the reasoning chat.** The user pastes an `<<<OOC-BRIEF v1 ...` brief into
the extension. The leader reads it as written and uses `delegate` to pass it to the
implementer. Delegation for a valid web brief can proceed without another confirmation
because it was reviewed in the reasoning chat. For immediate readback, the leader
writes an `<<<OOC-RESULT` block that the user can copy back. See
[brief-format.md](brief-format.md).

**Exchange limit.** ADR 0034 removed the `maxExchanges` option and the `limit_reached`
outcome.

### Historical text markers

Before ADR 0035, the leader supplied a text block. Its body could be any nonempty text,
and the opening line could name the worker, as in `<<<DELEGA @claude`. An opening line
that named someone else made the block invalid. The former `DELEGATION_SECTIONS`
requirement had already been removed.

```text
<<<DELEGA
nonempty free-form text
DELEGA>>>
```

ADR 0035 replaced the delegation, report, findings, and review markers with MCP
tools. Markdown frames still separate text supplied for evaluation from instructions
(threat T4 in [security.md](security.md)). The former worker answer frame used
`<<<RISPOSTA DEL WORKER` and `RISPOSTA DEL WORKER>>>`. The English frame uses
`<<<WORKER ANSWER` and `WORKER ANSWER>>>`. Matching lines in the framed text are
neutralized to prevent an early close.

## Outcomes

- `completed` for a direct leader response or the leader's conclusion after delegation.
- `delegated` for work whose result the leader will read later, including in `review` mode.
- `result` for a web brief result ready to copy back to the reasoning chat.
- `cancelled` with the point of cancellation (`delegation`, `review`, or `malformed`).
- `stopped` and `failed`.

## Labels

The **runtime** labels every thread response (`message`) using
`AgentTurnResult.identity`, which reflects what the adapter observed. The label
includes the provider (and proxy, as in "Codex via Headroom persistent proxy"), model,
effort, and session or thread ID. The runtime takes these fields from the protocol
rather than the agent's response text.

## Rules

- **Malformed delegation.** The thread receives `delegation_invalid`. The user can
  request a corrected call, edit the brief manually and approve it, or cancel.
  Automatic approval allows one retry for a malformed tool call.
- **Approvals.** Current interactive approval policy is in [security.md](security.md).
  In the bootstrap loop, requests for commands, writes, or network access were denied
  automatically and the thread displayed an unsupported-approval message. Codex received
  `decline` for commands, files, and MCP elicitation, and no granted permissions for
  `item/permissions/requestApproval`. Unknown requests received an error. The Codex
  thread used `approvalsReviewer: "user"` to route approval away from the automatic
  reviewer. ADR 0035 automatically allows the side-effect-free `ooc` tools.
- **Stop** is available at any time. It interrupts the Codex turn (`turn/interrupt`) or
  terminates the Claude process tree, cancels any wait for the user even if the callback
  ignores the signal, and closes the loop's sessions.
- **Logs** append each event (messages, interceptions, user decisions and edits, denied
  approvals, errors, and outcomes) to a JSONL file **outside the workspace**.
  `openEventLog` rejects relative paths and paths in the workspace. Streaming deltas
  go only to the UI.

## Provider independence

The runtime uses `AgentFactory`, `AgentSession`, and `AgentTurn` (`agent.ts`).
Adapters expose the same shape independently of the runtime. The extension creates the
factories and configures the CLI, model, and effort for the leader, implementer, and
reviewer roles.

## Limits

- Fake Codex turns follow a real turn (`question-turn.jsonl`) recorded with
  `OOC_CODEX_TRACE` using the demo removed by ADR 0034. The recording was redacted.
  Comparisons cover the fields read by the client. The fake omits hooks, MCP startup
  status, token usage, and rate limits.
- Provider **subagents** (D13) appear beneath the turn that creates them, use
  runtime-generated labels, and follow the role's policy (`LoopOptions.subagents`).
  The runtime checks them after launch. See [subagents.md](subagents.md).
- The final response of a Codex turn concatenates its completed `agentMessage`
  messages.
