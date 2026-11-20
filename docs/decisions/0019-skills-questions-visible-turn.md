# 0019. Skills, leader questions, and visible turn activity

Status: Accepted (iteration 3).

## Context

- **Chat needs access to CLI skills.** Users want to invoke Codex and Claude skills themselves and let the model choose skills automatically, as both CLIs do.
- **CLI commands need protection from the chat composer.** Tests with Claude Code 2.1.318 in `-p` showed that it rejects `/plan`, executes `/clear` and emits `conversation_reset`, and passes the same text to the model when preceded by a space.
- **Codex plan mode is out of scope.** It requires `collaborationMode`, which in turn requires `experimentalApi`. ADR 0006 bars experimental APIs.
- **Questions with choices belong inside an active turn.** Tests with Codex 0.164.0 (`gpt-6-luna`, low effort) showed that enabling `features.default_mode_request_user_input` in the session configuration lets app-server forward `item/tool/requestUserInput` in a normal turn without the experimental API. The request carries the question, choices, and an optional "Other" field (`isOther`). The turn waits for an answer and then continues.
- **Claude** can ask questions only over its stdio permissions channel (`--permission-prompt-tool stdio`). Adopting that channel would change how its permissions are integrated.
- **The leader and the user make decisions together.** The implementer receives a brief with those decisions. If a decision is missing, the implementer stops and records it in the report (ADR 0018).
- **A turn showed only a question and an answer.** Codex intermediate messages were merged into the answer, reasoning and plans were discarded, and commands showed only their start. Codex app-server, which powers its VS Code extension, provides message phases (`commentary` and `final_answer`), a reasoning summary, command output, exit code and duration, file patches, and a turn plan.

## Decision

1. **Skills.**
   - **`$` in the composer** lists the recipient's skills using `skills/list` for Codex and Claude's startup event. The selected skill uses the native format.
     - Codex receives a `skill` input with the name and path.
     - Claude receives `/name` at the start of the message.
   - **The model can select skills automatically.** Codex already does so. Claude gains the `Skill` tool for both roles.
   - **The leader remains read-only when using a skill** (ADR 0018).
2. **Slash command guard.**
   - **`/` in the composer** opens product commands.
   - **A message that starts with `/` and names no skill available to the recipient** is prefixed with a space. The CLI passes it through as text without executing commands such as `/clear`, `/plan`, or `/compact`.
3. **Leader questions during a turn.**
   - **Only the Codex leader** has `features.default_mode_request_user_input` enabled.
   - **A card replaces the composer** while the turn waits. A question with choices accepts one answer and offers a free-text "Other" field when requested by the model. A question without choices accepts free text. Multiple questions appear in sequence.
   - **Send** returns the answers to the model in the same turn. **Stop** ends the turn, as it does while waiting for permission.
   - The thread keeps a question-and-answer summary. Secret answers (`isSecret`) are masked and excluded from storage.
   - TODO(questions) Track questions for a Claude leader. When needed, use the stdio permissions channel and record the decision in a new ADR.
4. **Visible turn activity.** The thread shows activity in order.
   - Intermediate messages appear separately from the final answer.
   - Reasoning is collapsed. Codex shows the summary requested with `summary: auto`. Claude shows that it reasoned, since its text is unavailable.
   - Commands show exit code, duration, and expandable output.
   - File changes show a diff.
   - The turn plan shows completed steps.
   - Questions appear in the order they were asked.
   - The turn ends with its duration.

   Adapters send these steps to the runtime with IDs, and the thread updates them in place. History retains each output up to a limit.

## Consequences

- Users access supported actions such as handoff and starting a new chat through product commands. CLI commands are blocked even when entered deliberately.
- Claude's `Skill` tool gives it additional instructions. The tools and permissions available to the role govern what it can do.
- If the implementer lacks a decision, it stops and records the question in its report. The leader asks the user through the card and sends a follow-up. The report standard will define the format.
- Codex's option for questions in a normal turn lacks a documented stability guarantee. If a future version changes it, the leader can still ask in plain text.
