# 0018. Delegation cycle

Status: Accepted (iteration 3). Partially supersedes [ADR 0010](0010-leader-chat-adaptive-delegation.md) by making the leader read-only and [ADR 0011](0011-panels-roles-approvals-continuity.md) by removing report approval.

## Context

- **The leader chat is for reasoning and planning.** The leader produces prompts for the implementer, which has sole responsibility for code changes. Files and diffs from implementation would fill the leader's reasoning context.
- **For small changes**, the user writes directly to the implementer.
- **The composer's routes were ambiguous.** The choices let the leader decide, delegate, implement directly, or ask. The user wants to ask for a prompt in natural language when the discussion is ready, for example, "Generate the prompt for feature X."
- **Reports record what happened.** Editing a report during approval would distort the leader's evaluation.
- **Use one syntax for files.** The composer already used `@` to identify files (ADR 0015), while the delegation marker used it for the recipient.

## Decision

1. **Fix the leader's permission to read-only** and remove its permission setting.
   - The leader can run search and verification commands.
     - Codex uses the `read-only` sandbox. Commands that would require leaving the sandbox are refused without prompting (`approvalPolicy: never`).
     - Claude exposes read tools and Bash. With no allow rules and `--permission-prompts none`, only commands that Claude Code classifies as read-only can run.
   - For small edits, the leader suggests writing directly to the implementer.
   - Remove the direct implementation route and `/fai` command.
2. **Remove the route selector**, the `/delega` and `/chiedi` commands, and the historical `Via: …` line at the start of leader replies. The leader writes a delegation block only when the user asks for the prompt or the work.
3. **Delivery** (`approvalMode`) controls what happens to the block. It appears on the leader dial and moves into the composer when dials are hidden.
   - **Automatic delivery** sends the brief immediately and leaves a "→ Dnn · SENT" card with the brief in the thread.
   - **Manual delivery** pauses in a free-text editable card with Send and Cancel.
     - The card blocks the chat until the user decides.
     - Save the draft with the chat. Reopening the chat restores the card, and Send delivers it to the implementer without another leader turn.
4. **Send web briefs automatically** when marked `<<<OOC-BRIEF`, even in manual mode, because the user already reviewed the brief in ChatGPT.
   - Keep the original brief intact. The leader adds notes that tie it to current context, and the implementer receives those after the brief.
5. **Return the report unchanged.** The leader receives the implementer's report and the runtime's verified facts as written.
   - After delegation, the leader evaluates the work (`leaderReview`, default `always`). It proposes a next step to the user during that turn. A new delegation requires user direction. The runtime's existing limit of three exchanges remains a ceiling.
   - After a direct implementer message, queue the report until the next user message to the leader, as before.
6. **Use the historical delegation marker `<<<DELEGA #implementatore`.** The runtime still accepts the form with `@` for sessions resumed under the previous instructions.
7. **Users, leaders, and implementers can all write `@path` mentions.**
   - In the thread, `@path` and `@path#L10-20` link to existing files outside code blocks. Text such as `@scope/package`, `@param`, and email addresses stays as text.
   - Between agents, the runtime converts mentions to plain paths. The historical format used `path` for a plain path and `path (righe 10-20)` for a line range, where `righe` means lines. Codex and Claude receive the same representation.
   - A missing path stays as text. Flag it on the delegation card and allow sending so the brief can name files to create.
   - User messages still include the excerpts described in ADR 0015.
8. **The standards guide free-text briefs and reports.**
   - The leader's brief instructions call for the objective, context with `@` paths, decisions and their rationale, constraints and out-of-scope items, steps when useful, numbered acceptance criteria (C1, C2, …), verification commands, when to stop, and what the implementer can decide. Use the same template in the ChatGPT Project instructions.
   - Start the report with `## Status` (`done`, `partial`, or `blocked`) and link each criterion to its test and result.
   - Give Codex and Claude the same implementer guidance. Reuse existing code first, make the smallest change that meets the criteria, start with tests for those criteria, avoid abstractions for cases outside the brief, and add dependencies only if the brief calls for them.
   - External skills, such as ponytail for Claude Code, are optional and can be installed by the user under rule 7 of AGENTS.md.

## Consequences

- **A read-only leader uses less context.** All edits, including small ones, go through the implementer or the user.
- **Claude relies on Claude Code's command classification** to enforce read-only work for the leader. Codex enforces it through its CLI sandbox.
  - On Windows, a read-only Codex thread runs without requesting the `unelevated` sandbox (ADR 0008). TODO(security): verify with the real CLI that commands remain confined there.
- **Manual delivery pauses briefs only.** Reports still appear in the thread for users who read them before the leader.
- **Each delegation also uses a leader evaluation turn**, except with `leaderReview: deferred`.
- **The host resolves file links when a turn closes.** Links appear after streaming completes.
- **Earlier chats retain the original text.** The UI no longer shows the saved `/fai`, `/delega`, and `/chiedi` prefixes or leader lines beginning with `Via:`. They have no effect.
