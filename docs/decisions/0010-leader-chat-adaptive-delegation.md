# 0010. Leader chat and adaptive delegation across subscriptions

Status: Accepted (iteration 3). Partially superseded by [ADR 0018](0018-delegation-cycle.md), which makes the leader read-only. Partially supersedes [ADR 0009](0009-chatgpt-web-and-three-turn-layer.md). The leader chat replaces ChatGPT on the web as the main workflow. The clipboard bridge, focus-triggered capture, and brief format still apply.

## Context

- **ADR 0009 centered ChatGPT on the web** and used a fixed three-turn sequence. The original product requirements (R1 and R2) call for **one chat with a user-selected leader who reasons and delegates**. The user also wants to work without the web app and ask for small changes without writing a structured brief.
- **The `calc-functions` and `calc-session` tests** used one run per system at low effort.
  - **The full gateway duplicates work.** It explores the code, rewrites the specification, and rereads the code. Given a settled brief, it costs more than a standalone model and produces no improvement in the code.
  - **The lightweight leader costs roughly one-ninth as much as the full gateway.** It forwards the brief with notes and evaluates the runner's facts. With Sonnet implementing, it consumes less on both subscriptions than the corresponding standalone models.
  - **Leader context stays stable over four messages**, at 25k to 29k per turn. A standalone model rereads a growing context. Sol as leader with Sonnet used 37% of the context of Sol alone, plus $0.36 in nominal Sonnet costs compared with $0.67 for Opus alone.
  - **The most expensive leader turn was an open-ended request.** The leader explored the code before delegating.
  - **Sol costs as much as an implementer as it does working alone.** The implementer choice has more impact than the leader choice.
  - **Reviewing the facts alone caught some defects.** The leader found a defect that no test covered and missed another.

## Decision

1. **Center the product on the leader chat.**
   - The configured model, such as Sol or Opus, keeps one session for the whole conversation.
   - ChatGPT on the web supplies optional briefs through the bridge in ADR 0009.
2. **The user reasons with the leader, which can also write code.** The implementer is an external model on a separate subscription. The leader recognizes it as external, outside its native subagent hierarchy. For each request, the leader selects a route and declares its reason in the first line using the historical format `Via: rispondo | chiedo | faccio io | delego — perché`.
   - **Answer** (`rispondo`) for questions and reasoning. Subagents read the code and return summaries.
   - **Ask** (`chiedo`) when a decision is missing and changes the outcome.
   - **Implement directly** (`faccio io`) for small, focused edits affecting one or two files and a few dozen lines, with the behavior already decided. The leader makes the change when writing a brief would cost more. Subagents remain read-only.
   - **Delegate** (`delego`) for larger changes or when the user asks to generate a prompt or delegate. The leader organizes the work, explains what it is passing on and why, and writes the brief. The implementer does the detailed code exploration.
   - **For a brief from the web app**, the runtime recognizes its marker and forwards it verbatim. The leader adds targeted notes that supplement or correct the brief.
   - **Only after delegation**, the leader receives the implementer's structured report and the runner's facts, then tells the user what worked, what needs attention, and what to change. The report becomes part of the conversation. The leader handles small corrections directly and delegates larger ones again.
   - **Reasoning.** The user chooses the reasoning level per role. The user guide recommends levels for different situations.
3. **Protect the leader's context.**
   - Return only the implementer's report and the runner's facts, including changed files, rerun tests, and failed test names.
   - Keep transcripts and full files out of that context.
   - Evaluate the facts and open a file only if a fact contradicts the report.
4. **Use the brief as the sole contract.** ChatGPT and the leader use the same format. [brief-format.md](../brief-format.md)
5. **Default to the cheapest suitable implementer.** In the tests this was Sonnet at low effort, with a fresh session per delegation. Roles remain configurable under rule 1.
6. **CLI integration verified during the tests.**
   - **Claude.** Run subagents in the foreground by setting `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` only on the child process. Background results are lost on a resumed turn. Usage and cost with `--resume` are cumulative, so report the difference from the previous turn.
   - **Codex.** Disable the user's profile hooks for the test thread with `features.hooks = false` because Graft writes into the working directory.

## Consequences

- **R1 and R2 are central again.** The Main flow section links to this ADR. [requirements.md](../requirements.md)
- **The runtime's `leader` mode** preserves the leader session across requests. The full and lightweight `gateway` modes remained for experiments until ADR 0034 removed them.
- **In sandbox mode, the leader can write small changes** under ADR 0008.
- **Open work**
  - Measure how well the leader chooses between implementing and delegating small requests.
  - Add a short, independent diff review by a model on the other subscription.
  - Handle leader failover when its quota runs out (R8).
  - Build the user interface next.
