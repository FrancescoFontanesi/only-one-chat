# 0009. ChatGPT on the web with a three-turn agent workflow

Status: Partially superseded by [0010](0010-leader-chat-adaptive-delegation.md).

- The leader chat supersedes the web app as the main workflow and replaces the fixed three-turn sequence.
- The ChatGPT clipboard bridge, focus-triggered capture, and brief format still apply.
- The experiments cited in ADR 0010 informed the choice between a gateway and direct execution.

## Context

- **The user's workflow at the time.**
  - The user works through ideas with ChatGPT on the web, which uses no Codex quota.
  - Once the discussion is ready, the user generates a prompt, gives it to an agent to implement, and brings the results back to the chat.
  - Conversation and delegation alternate.
- **R1 and R2 previously called for a leader inside the extension.** With Codex talking to the user, every turn would consume quota, and the same context would accumulate reasoning, code work, and written output.
- **The `calc` benchmark.**
  - An expensive planner paired with a cheaper implementer passes all the tests, as does Opus alone.
  - Its nominal cost is about one-third of Claude's.
  - Planning takes 96 seconds out of 162.
- **ChatGPT web subscriptions provide no API.**
  - Automating the page by reading the DOM, simulating clicks or keystrokes, or sending messages automatically would conflict with the OpenAI Terms of Use, which prohibit programmatic extraction of output.
  - Page changes would break the automation.
  - Automation would touch the user's authenticated session.
  - VS Code Simple Browser embeds pages in an iframe. chatgpt.com is unlikely to load there, and even if it loaded, the extension could not read it.

## Decision

### Division of work

- **Reasoning and exploration stay in ChatGPT on the web**, in a ChatGPT Project dedicated to the repository.
  - The extension generates project instructions, which the user pastes once.
  - The instructions identify the chat as a development discussion and direct approved work to agents.
  - They call for a self-contained brief with the decisions already made, so agents can act on reasoning completed in the chat.
- **The extension runs the same agent workflow each time.**
- **The brief describes intent and acceptance criteria.** ChatGPT cannot see the repository. The agent workflow grounds the brief in the actual code.

### Clipboard bridge to ChatGPT

- **The brief** is in a single code block copied with ChatGPT's Copy button. It starts with `<<<OOC-BRIEF v1 project=<id> track=<slug>` and ends with `OOC-BRIEF>>>`. [brief-format.md](../brief-format.md)
- **Copying signals consent, and focus selects the window.**
  - After copying the brief, the user focuses the project's VS Code window.
  - When that window gains focus (`vscode.window.onDidChangeWindowState`), and only while clipboard listening is enabled, the extension reads the clipboard once (`vscode.env.clipboard.readText()`), recognizes the marker, and captures the brief.
  - Clipboard reads are event-driven.
  - The manual Capture from Clipboard command performs the same operation.
- **The response** goes to the clipboard as a `<<<OOC-RESULT v1` block, with a notification. The user pastes it into ChatGPT, edits it if desired, and sends it.
- Reading or writing the ChatGPT page, simulating clicks or keystrokes, and submitting messages automatically are out of scope.

### Multiple VS Code windows

- **The focused window is the target.** With two projects, two ChatGPT chats, and two VS Code windows, the brief goes to the clicked VS Code window. No cross-window lock is needed.
- **The project ID is a safeguard.**
  - The extension generates an `id` for each workspace and includes it in the ChatGPT Project instructions.
  - If the brief ID differs from the window's project ID, the panel holds the brief and offers Run Here Anyway.
- **Prevent duplicate captures.**
  - The last captured brief's hash is shared between windows in the extension's global storage. Refocusing a window cannot run the same brief a second time.
  - Verify whether `globalState` propagates immediately between open windows or whether a file is required.
  - Running the same brief again requires an explicit command.

### Approval modes

- **Manual.** The captured brief appears in the panel as an editable draft. It runs after approval.
- **Automatic.** The brief runs on capture.
- **Reject.** Reserved for serious problems. Rejection produces a message with the user's notes for ChatGPT to rewrite the brief.
- **The panel shows the workflow** (ChatGPT → gateway → implementer → gateway → ChatGPT) and who is working.

### Three-turn agent workflow

1. **T1, gateway.**
   - **Configuration.** Codex Sol 6.1 or Claude Opus 5.5, selected by role, with low or medium effort and read-only access to the repository.
   - **Work.** Match the brief to actual files, APIs, and test commands, check consistency and gaps, and turn it into a specification without reopening the design.
   - **Outcome.** Submit the specification or ask for clarification. A clarification request returns to ChatGPT as the response.
   - **Autonomous decisions.** The gateway may decide minor details and must disclose them in a required field for autonomous decisions.
2. **T2, implementer.** A cheaper model with confined writes carries out the specification and submits a report.
3. **T3, gateway, in the T1 thread.**
   - **Input.** The report and the facts collected by the runtime, including modified files, commands and their outcomes, and tests. The gateway can read the repository if needed.
   - **Output.** Submit the response for ChatGPT and include the autonomous decisions.
   - **Verification failure.** Report failures and end the turn. Corrections require user action.

**Continuity.**

- Reuse the gateway thread across successive delegations in the same workstream.
- The implementer opens a new session for each delegation because the specification is self-contained. Direct requests from the panel resume the session from the most recent delegation.

### Direct interaction, questions, and subagents

- **Direct messages from the panel.** For a quick change, the user can write to the gateway or implementer without going through ChatGPT.
  - The gateway receives the message in its existing thread, where it knows about previous delegations. It can reply or delegate to the implementer with a specification.
  - A message to the implementer resumes the last delegation's session.
  - Direct requests use the same permissions and confined writes as delegations.
- **Keep ChatGPT up to date.** Log work done outside ChatGPT. The next response includes it, and the Summary for ChatGPT command makes it available on demand. This keeps the conversation grounded in the actual state of the project.
- **Agent questions.** An agent that needs a decision uses a toolkit MCP tool shared by Codex and Claude.
  - A question from the implementer goes to the gateway first. The gateway answers if the specification or existing decisions resolve it. Otherwise, it passes the question to the user.
  - The user answers in the panel or copies the question to the clipboard for ChatGPT as a `<<<OOC-QUESTION` block.
  - TODO(toolkit): verify how long MCP tools can wait for an answer (`tool_timeout_sec` in Codex and the equivalent in Claude Code).
- **CLI permission requests** continue to go through the panel.
- **Native subagents** (Luna for Codex and Haiku for Claude) remain visible and constrained under the turn that spawned them, including for direct messages and across roles. [ADR 0007](0007-subagents-visible-not-intercepted.md)

TODO(toolkit): specify the following in the next ADR.

- The brief, specification, report, and response formats.
- The MCP tools that enforce the formats and the condition for closing a turn.
- How to identify a workstream.
- ChatGPT Project instructions.
- Skills for each role.

### Experiment E2 compares gateway and direct execution

**Direct execution** sends the brief straight to the implementer. The runtime assembles the response from the report and observed facts.

**Experiment E2.**

- **Use existing code**, such as adding a feature to the reference calculator. An empty directory such as `calc` gives T1 no existing code to ground the brief in.
- **Have the user write briefs in ChatGPT** using the project instructions and save them with the scenario. The conversation uses no Codex quota or web automation.
- **Compare** the gateway (Sol, Sonnet, Sol), direct execution with Sonnet, and optionally direct execution with Opus.
- **Measure** the same metrics as the benchmark, plus the quality of the ChatGPT response, including whether it reports problems and autonomous decisions.

## Consequences

- **Codex quota is used only by T1–T3.** The conversation itself consumes none.
- **R1, R2, R4, and R8 are interpreted in light of this workflow.** Reasoning takes place in ChatGPT, the VS Code panel shows the flow, and the configurable role with failover is the gateway. [requirements.md](../requirements.md)
- **The runtime's `pipeline` mode** provides the basis for T1–T3. The `loop` and `question` modes remain supplementary.
- **Clipboard access adds an attack surface.** See T10 in [security.md](../security.md).
- **Each cycle includes deliberate user actions.** Copy in ChatGPT, then click the VS Code window. At the end, paste and send in ChatGPT. The user stays in control of which brief runs.
- **Future options** include the official ChatGPT MCP connector, which needs its own ADR because it requires an Internet-reachable endpoint, and Gemini as document memory, mainly for T1.
