# 0023. Nodes on the Squad board and Antigravity over ACP

Status: Accepted (iteration 3). Extends ADR 0022 on provider-independent roles and ADR 0016 on Squad.

## Context

- **Only One Chat brings multiple agents into one chat.** The Squad board initially showed the leader and implementer.
- **Users want to add other agents**, such as Gemini, and select them to chat. Delegation to those agents is deferred.
- **Antigravity (`agy`, 1.5.5) has an Agent Client Protocol (ACP) server.** `agy acp` uses JSON-RPC 2.0 over stdio with one object per line. Live checks confirmed the protocol behavior.
  - `initialize`, `session/new`, `session/load`, `session/set_model`, `session/set_mode`, and `session/prompt` work.
  - `session/update` carries text, reasoning, tool calls, and plans.
  - The `session/prompt` result includes turn token counts.
  - Available modes are `default` (asks before edits and commands), `accept-edits`, `auto`, and `plan`.
  - In `default`, every command, including `dir`, triggers `session/request_permission` with `allow_once` and `reject_once`. `read_file` runs without prompting.
  - `agy models` lists models without a turn, in `id<TAB>name` format. The ID includes the reasoning level, for example `gemini-3.8-flash-low`, displayed as "Gemini 3.8 Flash (Low)".
  - The ACP server omits quota data. Starting with 1.1.11, `agy -p /quota --output-format json` returns it directly without creating a turn (`num_turns: 0`), spending quota, or creating a conversation. `agy` keeps the login token. Models share limits by group ("Gemini Models" and "Claude and GPT models"), with five-hour and weekly windows (`remaining_fraction` and `reset_time`). Git Bash rewrites `/quota` to a path, causing `agy` to handle it as a prompt and start a real turn. The extension launches it without a shell.
- **ACP is an open protocol.** Other agents and integrations use it, including Gemini CLI, Zed, and adapters for local models. An ACP adapter can serve Antigravity and future providers.

## Decision

1. **Generic ACP adapter** (`packages/adapters/src/acp/`).
   - One process per session. The session continues across turns and reopens with `session/load`.
   - The agent uses its own tools. The client provides no filesystem or terminal.
   - ACP has no system prompt, so role instructions precede the first prompt of a new session.
   - The adapter shares the Codex client's transport (`startJsonRpc`), independently of the Codex handshake.
2. **Antigravity is an entry in the ADR 0022 provider registry.** The dial offers three levels of access.
   - **Read denies every permission request** without asking the user. The instructions direct the agent to read with its own tools and avoid commands. In live tests without this instruction, the agent ended the turn without responding after its first denied command.
   - **Ask uses `default`** and sends every request to the user.
   - **Auto uses Antigravity's `auto` mode** and sends any remaining requests to the user.

   The child process environment is stripped of API keys so `agy` uses the signed-in account (ADR 0006). `--dangerously-skip-permissions` is prohibited.

   The model's levels become reasoning options. For example, `gemini-3.8-flash` offers low, medium, and high, which are joined with the model name to produce the ID `agy` expects. An existing node saved with a full ID loads as a model and reasoning level.

3. **Nodes are separate agents on the board.**
   - **Workspace configuration** in `onlyOneChat.nodes` stores each node's ID, name, CLI, model, reasoning level, and permissions. Read-only is the default.
   - **Nodes can use any provider** in the registry.
   - **Each node has its own session and thread.** Selecting it in Squad or on the recipient dial shows its thread in place of the chat and sends composer messages to it. The node dial exposes only model and reasoning. Change node permissions in Squad. Delivery, permissions, and handoff on the dial belong to roles.
   - **Isolation keeps node and leader threads private** from one another. Nodes have no delegation, review, or file checkpoints. Changes by a node with write access appear under "Changed files".
   - **Antigravity was initially limited to nodes.** ACP does not define the questions and review needed for the leader and implementer roles.
4. **The node thread and ACP session ID are saved and reopened with the chat.**
5. **Antigravity usage comes from the CLI**, as with Codex, without reading files or tokens.
   - **Refresh usage** on opening the chat, every two minutes while it is visible, and after each Antigravity node turn. At least one node must use Antigravity.
   - **Check `agy --version` first.** Versions before 1.1.11 would treat `/quota` as a prompt, so they do not receive it.
   - **Reject usage responses that include turns.**
   - **The dial shows the first group** (Gemini). The tooltip lists all groups.

## Consequences

- Another ACP provider needs a registry entry with the server's executable and arguments.
- Deferred work includes showing usage for the node's actual model group, node questions, leader delegation to a node (with board links and addressed briefs), and checkpoints for nodes with write access.
- `GOOGLE_GENAI_USE_VERTEXAI` and `GOOGLE_APPLICATION_CREDENTIALS` remain in the environment. They have no effect with Google login, but users who set them for other tools may cause `agy` to select different authentication.
