# 0017. Implementer handoff

Status: Accepted (iteration 3).

## Context

- **The implementer's session fills up** during a long chat. Starting a new chat also loses the existing leader session and its context.
- **The user wants to start a new implementer session with the same model** and carry over the prior work from the dial beside the composer (ADR 0016). The user's Claude models have their own handoff command, but a personal command cannot serve as the product interface. The product stays provider-independent under rule 1.
- **The implementer's model and reasoning can already change** in the same session while a chat is open (ADR 0012). The leader keeps its model for the entire chat.

## Decision

- **HANDOFF** (`{ type: 'handoff' }` from the webview and `ChatSession.handoff()`) applies only to the implementer, after its first turn, while no message is running.
  1. The current session writes a handoff in a normal turn visible in the thread. It includes the objective, status, files touched, decisions, open issues, next steps, and verification commands. The handoff turn makes no edits and runs no commands.
  2. Close the session and clear its stored ID so the chat cannot resume it, even after reopening. Reset the displayed context to zero.
  3. The next session uses the same provider and model. Its first work prompt includes the handoff as background context, as specified in [ADR 0037](0037-persist-implementer-handoff.md).
- **If the handoff text is empty**, keep the existing session and show an error in the thread.
- The product supplies the same request text for Codex and Claude.

## Consequences

- A handoff uses one implementer turn under the user's subscription.
- The original implementation kept the handoff in memory. [ADR 0037](0037-persist-implementer-handoff.md) replaces that behavior with a pending handoff saved in chat history.
- The leader handoff remains to be designed. The leader model stays fixed within a chat.
