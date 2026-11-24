# Product requirements

Each requirement is tagged with its release ([ADR 0049](decisions/0049-v01-scope.md)): **[v0.1]** is in
the first release, **[post-v0.1]** waits for use in the field and gives the reason.

## Vision

`only-one-chat` is a VS Code extension that coordinates multiple AI agents through **a
single shared chat**. The user works in one thread. The leader plans and delegates,
workers execute, and each agent's activity appears as a nested item in that thread. The
experience draws on the Codex extension. The code is independent and original. See
[ADR 0002](decisions/0002-reuse-policy.md).

### Main flow (ADR 0010)

[ADR 0010](decisions/0010-leader-chat-adaptive-delegation.md) defines the main workflow.

- **One chat with the leader** (R1, R2). The user configures the leader and works through
  decisions with it.
- **The leader reasons, plans, and delegates implementation.** See
  [ADR 0018](decisions/0018-delegation-cycle.md).
  - The leader answers directly and delegates code exploration to subagents.
  - When the user asks for a prompt or for implementation, the leader writes a brief for
    the implementer on a separate subscription. The implementer starts immediately or
    waits for the user, depending on the instructions.
  - The user asks the implementer directly for small changes.
- **The brief is the single contract** (R4). ChatGPT web is an optional source of briefs.
  The clipboard transfers them so that extended reasoning stays outside the quotas. See
  [ADR 0009](decisions/0009-chatgpt-web-and-three-turn-layer.md).

### Out of scope

- General-purpose model routing for individual prompts.
- An independent chat for each provider.
- A "Solo Mode" that bypasses orchestration.
- Forking usturlab, Augani Agent Orchestrator, or Codex.

## Core requirements

### R1. One orchestration chat

- One conversation thread per work session. **[v0.1]**
- Leader, worker, and subagent activity is nested under the message or task that generated
  it. Users can expand or collapse the activity within the same thread. **[v0.1]**
- The user can intervene in the thread at any time to ask questions, make corrections, or
  stop the work. **[v0.1]** for stopping and answering the agents' questions and approvals. **[post-v0.1]**
  for a new message while a turn runs: the chat takes one message at a time.

### R2. Configurable leader

- Configuration assigns the leader role independently of the provider. **[v0.1]**
- Expected typical configuration:
  - Leader: Codex with the user-specified model "Sol 6.1". **[v0.1]**
  - Scientific collaborator and **backup leader**: Claude Opus 5.5. **[v0.1]** as a leader or
    implementer chosen by the user. **[post-v0.1]** as a backup leader: it depends on failover (R8).
- Model names and effort levels come from configuration and are checked at runtime against
  the installed CLI. **[v0.1]**

### R3. Workers and subagents

- **Native provider subagents**, such as Luna for Codex or Haiku for Claude, are launched
  and managed by the provider CLI and shown in the thread. **[v0.1]**
- **External workers** include Antigravity with Gemini 3.8 High for low-risk work that
  requires substantial context or output. **[v0.1]** for Antigravity as an isolated node on Squad:
  the user talks to it directly, with no delegation, review, or checkpoint (ADR 0023).
  **[post-v0.1]** for Antigravity as a leader or a worker in the delegation chain: ACP has no questions
  and no session state the chain can rely on.
- Each worker has a declared profile covering capabilities, acceptable risk, permissions,
  and workspace (shared or isolated in a worktree). **[post-v0.1]**: nodes declare CLI, model, effort,
  and permission only; capabilities, risk, and workspace wait for parallel workers (R6).

### R4. Delegation and bidirectional communication

- Delegation follows the hierarchy user → leader → worker → subagent, if any. **[v0.1]** for user →
  leader → implementer (with the reviewer, ADR 0029) → native subagents. **[post-v0.1]** for Antigravity
  in the chain, as in R3.
- Every delegation has an explicit **task contract** with the goal, scope, files, constraints,
  acceptance criteria, validation commands, and final report. **[v0.1]**
- A blocked worker asks the delegator a question. The leader answers or forwards it to the
  user. The question remains visible in the thread. **[v0.1]**
- The leader receives the results as evidence to review before acceptance. **[v0.1]**

### R5. Persistent tasks

- Task state (contract, assignee, status, events, questions, and results) is written
  atomically to disk. **[v0.1]**
- After a crash, VS Code restart, or provider switch, each task is explicitly resumed,
  flagged for manual review, or canceled. **[v0.1]** after a crash or a restart (ADR 0039).
  **[post-v0.1]** after a provider switch: the resume is refused, and the user cancels the task or
  restores the recorded providers.

### R6. Parallel execution

- Multiple workers can work on independent tasks in parallel. **[post-v0.1]**: one implementer per
  chat.
- Tasks that write to the same files run sequentially in the same workspace or in separate
  worktrees. **[post-v0.1]**: the worktree policy is still an open question.
- Concurrency limits are configurable per provider and per account. **[post-v0.1]**: the limit on
  native subagents is fixed at two.

### R7. Subscription monitoring

- Monitor each subscription's five-hour and weekly quotas using only local or official
  sources exposed by the CLIs. **[v0.1]**: Codex and Antigravity are read ahead of a turn; Claude
  reports its quota only after a turn.
- Display quota status in the UI and use it for planning and failover. **[v0.1]** for the display
  and the threshold warning. **[post-v0.1]** for planning and failover: they depend on R8.

### R8. Failover and recovery

- Automatically switch leaders when the current leader exhausts its quota. **[post-v0.1]**: it needs a
  backup leader (R2) and a context transfer, not started.
- Failover is **transactional**. Save a task checkpoint, transfer explicit context to the
  backup leader, and record the event. Preserve work already done and prevent silent
  duplicate execution. **[post-v0.1]**, with the switch above.
- Recovery after a crash uses the same checkpoint mechanism. **[v0.1]**: the task checkpoints of
  ADR 0039, without failover.

### R9. Permissions and approvals

- The extension mediates approvals for commands, writes, and network access. It displays
  them in the thread with enough context for the user to decide. **[v0.1]** for commands and writes.
  **[v0.1]** for network access with one constraint: it is denied by default and not put to the
  user; mediating it is **[post-v0.1]**.
- "Allow always" approvals are narrowly and explicitly scoped, revocable, and visible. **[v0.1]**:
  scoped to the exact tool and input for the session; ADR 0050 makes them visible and
  revocable.
- `dangerously-skip-permissions` and equivalent modes are disabled by default. See
  [security.md](security.md). **[v0.1]**

### R10. VS Code integration

- The chat appears in a Webview panel. Diffs for proposed changes open in the native editor.
  **[v0.1]**
- The extension respects VS Code Workspace Trust. **[v0.1]**
- Authentication uses only official CLIs and existing subscriptions. Paid API fallback
  is excluded. **[v0.1]**

## Optional ecosystem

The core can be installed, built, tested, and used independently of these components. The
orchestrator can use them through MCP and custom instructions.

| Component                     | Intended role                                 |
| ----------------------------- | --------------------------------------------- |
| Graft                         | Local code index for agent navigation         |
| Basic Memory                  | Persistent memory across sessions through MCP |
| MCP servers                   | External tools configured by the user         |
| Custom skills                 | Reusable procedures defined by the user       |
| User workflows                | Predefined task sequences                     |
| MLflow, DVC and similar tools | Experiment and data tracking                  |

Development and distribution of these tools are outside the scope of this repository.

## Cross-cutting constraints

- Paid API calls and extension-managed API keys are excluded.
- Changing the user's global CLI configuration (`~/.codex`, `~/.claude`, or Antigravity
  profiles) requires explicit consent.
- Runtime and adapter tests run independently of the Extension Host.
- Windows is the primary platform.

## Open questions before implementation

1. Which control protocol should each CLI use? Codex options are app-server JSON-RPC and
   `codex exec --json`. Claude Code uses stream-json over stdio. Antigravity (`agy`) still
   needs verification.
2. How can five-hour and weekly quotas be read reliably for each provider?
3. How should native provider subagents appear in the thread?
4. What format should persistent state use, and should it live in extension storage or the
   workspace?
5. What worktree policy should apply to workers that write code?
