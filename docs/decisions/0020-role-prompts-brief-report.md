# 0020. Role prompts, briefs, and reports

Status: Accepted (iteration 3). Clarifies the brief and report formats in ADR 0018. ADR 0029 further specifies brief criteria and report sections.

## Context

- **The role prompts were terse, and the report format was too simple.**
- **Published guidance provides a starting point** for the format.
- **The implementer role owns the report format.** The leader's brief can focus on the work.
- **Sources consulted**
  - **Anthropic's multi-agent research system.** A delegation includes an objective, an output format, tool and source guidance, and task boundaries. Vague assignments create duplicate work and gaps. Use heuristics to match effort to the task. Workers return concise results with references to their artifacts.
  - **Anthropic's prompting best practices.** State clear instructions with their rationale, use separate sections, and specify the role. The examples discourage overengineering, tailoring work to pass tests, and making claims about unread code. They allow reversible actions and rule out destructive ones.
  - **OpenAI's Codex prompting guide** (February 2026). Divide system prompts into sections for autonomy and persistence, exploration, implementation, and presentation. Make reasonable assumptions and finish in the same turn. Reports start with what changed, then give locations, reasons, command output, and instructions for checking any unverified work.
  - **OpenAI's GPT-5.5 guide.** Center prompts on outcomes, with a goal, success criteria, constraints, context, and stopping rules. Reserve ALWAYS and NEVER for invariants and use the shortest prompt that works.

## Decision

1. **Two product role prompts shared by Codex and Claude.** The runtime uses `leaderInstructions` and `IMPLEMENTER_ROLE_INSTRUCTIONS`.
   - The prompts live in `packages/runtime/prompts/leader.md` and `implementer.md` in the form the models read. The build includes them as text. The runtime fills `{{implementer}}` and `{{ask}}` and appends subagent rules. Prettier skips these files.
   - The role prompts supplement the CLI system prompt and repository instructions (AGENTS.md, CLAUDE.md). The CLIs load the repository instructions themselves. Codex receives the role prompt as `developerInstructions` and Claude receives it through `--append-system-prompt`.
   - The user's instructions for the role follow the role prompt and come from settings (ADR 0013).
   - This decision kept the prompts in Italian. ADR 0035 covers their translation.
   - Gateway and benchmark prompts (ADR 0009) stay fixed to preserve comparability.
2. **The brief** (inside `<<<DELEGA #id`) focuses on the outcome and follows a fixed structure. Omit sections that do not apply.
   1. Goal and rationale.
   2. Context, with files written as `@path`.
   3. Constraints limited to invariants.
   4. Numbered, testable acceptance criteria and verification commands.
   5. Scope.
   6. Stop conditions.

   A follow-up needs only the goal and criteria. Specify steps when their order matters. The implementer role already requires the report.

3. **A brief from the web app** uses the same sections and its own markers, `<<<OOC-BRIEF v1 project=<id> track=<slug>` … `OOC-BRIEF>>>`. The leader receives the block directly, including its markers.
4. **The report** is part of the implementer role and appears between `<<<RAPPORTO` and `RAPPORTO>>>`. The historical format used the following sections.
   1. `Esito` (Outcome), with `completato` (done), `parziale` (partial), or `bloccato` (blocked).
   2. `Modifiche` (Changes).
   3. `Verifica` (Verification), by criterion.
   4. `Decisioni` (Decisions).
   5. `Bloccato su` (Blocked on), phrased as a question for the leader about the missing decision.
   6. `Fuori ambito` (Out of scope).

   An empty section says `nessuno` (none).
   - A brief always receives a report.
   - A direct message receives a report if the implementer changed more than one file or ran checks. A single line suffices otherwise.
   - The thread shows the outcome in a report card and hides empty sections.

5. **The leader evaluates a report** by reading the outcome, comparing each criterion with the facts, bringing blockers to the user, and reporting back. The evaluation turn receives only the report and facts.
6. **The implementer can use subagents** for broad reading without an explicit request. File edits stay with the implementer. The runtime enforces the model, effort, and number of subagents (D13).
7. **The leader always discloses minor decisions** to the user.

## Consequences

- A consistent brief and report format gives the leader a predictable place to find the outcome and blockers.
- The implementer role defines the report once for all briefs.
- The ChatGPT project instructions should use the brief's format and markers. TODO(web-brief) Track the project instructions.
