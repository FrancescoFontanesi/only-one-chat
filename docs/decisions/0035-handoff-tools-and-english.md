# 0035. Structured handoff tools and English across the project

Status: Accepted (2026-11-18) after the feasibility trial below. Replaces text markers between extension agents in ADRs 0018, 0029, and 0031.

## Context

- **Role handoffs were text blocks.** The runtime matched historical markers (`<<<DELEGA`, `<<<RAPPORTO`, `<<<RILIEVI`, `<<<REVISIONE`) and values (`completato`, `bloccato`, `approvato`, `con riserve`, `verificato`, `parziale`) with regular expressions.
- **Small changes in wording broke the parser.** One trial used markers in the wrong language. Other turns used plurals or synonyms such as `verificati` and `parziale`, which the contract checks misread. Each patch broadened the regular expressions, and translating the system would have invalidated them together.
- **All three CLIs already support structured MCP tools** with JSON Schema arguments. Claude Code starts with `--strict-mcp-config`, Codex accepts per-thread `config` in `thread/start`, and ACP accepts `mcpServers` in `session/new`.
- **Provider streams already carry tool calls and arguments.** Codex uses `mcpToolCall`, Claude uses `tool_use`, and ACP uses `tool_call`. The runtime reads handoffs from the adapter without a separate channel between the server and extension.

## Decision

1. **Each handoff calls a tool** from the extension's `ooc` MCP server.
   - The leader uses `delegate` to send the brief to the implementer.
   - The implementer uses `report` to send the report, with the outcome and each criterion's status.
   - The reviewer uses `findings` to send findings to the implementer and `review` to send the review and verdict to the leader.

   Each role sees only its own tools.

2. **Schemas define the fields the runtime reads.**
   - Fixed English values cover the outcome (`done`, `partial`, `blocked`), criterion status (`verified`, `not_verified`, `not_met`), verdict (`approved`, `with_reservations`, `rejected`), and finding severity.
   - Brief criteria and findings are arrays of entries with IDs. ADR 0031 contract checks compare fields directly.
   - Brief, report, and finding prose can use any language.

   The runtime schemas define the role-to-role protocol.

3. **The server is stateless and has no side effects.** It validates arguments and returns an error the model can correct in the same turn, or acknowledges valid arguments. It writes no files, opens no connections, and has no direct link to the extension.

   The runtime reads the handoff from the adapter's tool-call event and validates the arguments against the same schema, ignoring extra fields. ACP omits the server result and Antigravity adds `toolSummary`. The standalone server (`packages/runtime/src/handoff-server.ts`) uses only Node modules. The extension bundles it as `dist/handoff-server.js` and runs it with VS Code's Node through `ELECTRON_RUN_AS_NODE`. This adds no dependency. It splits lines on `\n` only, because Node's `readline` also splits on U+2028 and U+2029, which JSON leaves unescaped. See the runtime trial below.

4. **Apply the last valid handoff in each turn.**
   - A leader turn without a tool call can still answer directly. An empty turn with no call gets one more turn, whose result is used. A denied command can cause this condition.
   - An implementer or reviewer turn without a valid handoff gets a short follow-up requesting the appropriate tool. If the handoff is still missing, the implementer has the `no-report` contract issue and the reviewer's text reaches the leader as a review without a verdict.
5. **Automatically allow the four side-effect-free `ooc` tools.**
   - Claude Code uses `--mcp-config` with only `ooc`, together with `--strict-mcp-config` and `--allowedTools`. The claude.ai connectors and other MCP servers are excluded.
   - Codex adds the server to the thread `config` and accepts approval requests only for `ooc`. The thread configuration supplements `~/.codex/config.toml`, allowing user servers to load as before, but calls to those other servers remain denied.
   - ACP accepts permission requests only for `ooc`.

   Global CLI configurations are unchanged.

6. **Keep markers for the clipboard boundary.** Briefs from ChatGPT's web app (`<<<OOC-BRIEF`) and results sent back (`<<<OOC-RESULT`) travel through copy and paste. The leader receives the brief as text and passes it to the implementer through `delegate`.
7. **Use English across the project.** This covers role prompts, tool names and values, runtime messages, webview and extension text, `package.json` settings, the README, documentation, ADRs, AGENTS.md, and tests that depend on those strings. Localization through `vscode.l10n` is deferred until needed. Raw trial results remain local, and this ADR records their outcomes.
8. **The benchmark counts missing or invalid handoffs by role and model** in place of malformed blocks.
9. **Implementation sequence.**
   1. Prototype the server and one tool with all three fake CLIs, followed by one approved live turn per CLI.
   2. Migrate the runtime to tools and update its tests and role prompts.
   3. Translate the remaining UI, documentation, and tests into English.

## Consequences

- Handoff validity is independent of the language and layout of free text. The contract checks compare fields directly.
- One lightweight stateless `ooc` server process runs per session.
- A model must call MCP tools to serve an extension role. The benchmark can measure reliability on small models such as Haiku, Luna, and Flash.
- Historical malformed block counts and new tool handoff counts measure different failures.

## Feasibility trial (2026-11-18)

Each CLI ran one read-only live turn on a small model with low reasoning where available. The trial used the `ooc` server and a `report` tool with an outcome (`done`, `partial`, or `blocked`) and text. The prompt asked the model to call the tool first with the invalid Italian value `outcome: "completato"`.

- **Claude Code (Haiku).** `--mcp-config` with only `ooc`, `--strict-mcp-config`, `--allowedTools mcp__ooc__report`, and `--permission-prompts none`. The server connected, the first request returned a schema error, and the second with `done` succeeded in the same turn. The reported cost was $0.002.
- **Codex (Luna).** Thread `config` with dotted keys `mcp_servers.ooc.command` and `mcp_servers.ooc.args` worked in the read-only sandbox. Each call requested approval through `mcpServer/elicitation/request` (`_meta.codex_approval_kind: "mcp_tool_call"`). The adapter answered `{action: "accept", content: {}}` only when `serverName` was `ooc`. The `mcpToolCall` item carried `arguments` and `result`. The schema failure ended the item as `failed`, and Luna corrected it in the same turn.
- **Antigravity (Gemini 3.8 Flash).** The server registered through `mcpServers` in `session/new`. The call requested `session/request_permission` with the title "Run mcp_ooc_report". Approval was limited to `ooc` and allowed even in read-only mode. ACP reported `rawInput` with an additional `toolSummary` field absent from the server's input and omitted the result.
- **Codex dynamic tools were considered.** App-server's `dynamicTools` on `thread/start` worked through `item/tool/call` without another process or approvals, but required `experimentalApi`. MCP provides one mechanism across all three CLIs. Dynamic tools remain a fallback if Codex's MCP behavior changes.

## Runtime trial (2026-11-18)

The live `calc-include` benchmark sent the task followed by the historical prompt `Procedi.` ("Proceed.") to three systems.

| System | Leader            | Implementer   | Reviewer     | Hidden tests | Handoffs                                                         |
| ------ | ----------------- | ------------- | ------------ | ------------ | ---------------------------------------------------------------- |
| V1     | Codex gpt-6.1-sol | Claude Sonnet | Claude Haiku | 51/51        | 1 `delegate`, 2 `report`, 1 `findings`, 1 `review`. None missed. |
| V2     | Claude Sonnet     | Codex sol     | Gemini Flash | 51/51        | 2 `delegate`, 2 `report`, 2 `review`. Two missed and recovered.  |
| V3     | Gemini 4 Hydrogen | Claude Haiku  | Codex terra  | 33/51        | No `delegate`. Work never started.                               |

- **U+2028 and U+2029.** Node's `readline` split a Haiku `review` request on unescaped Unicode separators. The server received fragments and never responded. Claude retried every 30 minutes. The server and adapter JSONL readers (`onJsonLines`) now split on `\n` only.
- **Antigravity command denial.** A denied command in read-only mode ended the turn without text. This caused the missed Flash reviewer handoff and the empty Hydrogen leader turn. The ACP adapter now continues the turn with a fixed notice (`REFUSED_NOTICE`), up to twice, which lets the model switch to read tools.
- **Antigravity background work.** `invoke_subagent` and `schedule` can end a turn and cause the agent to wake later. A `delegate` call arriving after the turn is lost because ACP offers no signal that the resumed work has finished.
- **Leader go-ahead.** V1 and V3 could wait for confirmation because the prompt requires it, as with the markers. The benchmark script added `Procedi.`.

### Historical benchmark results (2026-11-18)

| File (`calc-include-…`)                  | Outcome                                                                                 |
| ---------------------------------------- | --------------------------------------------------------------------------------------- |
| `V1-…T21-02`, `V1-…T21-15`               | 33/51. With one scripted message, the leader proposed work and waited for confirmation. |
| `V1-…T21-17`                             | 51/51. The run was stopped when U+2028 blocked the reviewer before the fix.             |
| `V1-…T22-51`                             | 51/51. Full cycle with one `findings` round. Reference run for V1.                      |
| `V2-…T21-04`, `V2-…T23-06`               | 51/51. Flash missed its first handoff and recovered on the follow-up turn.              |
| `V3-…T21-11`, `V3-…T21-14`, `V3-…T23-05` | 33/51. Hydrogen never called `delegate` within a turn.                                  |

The ACP command-denial fix landed after these runs. A `fake-agy` test and a direct live probe covered the fix. The full benchmark was never rerun against it.

## Antigravity leader limitation

Direct ACP probes used `agy acp` with `gemini-4-hydrogen-medium` in a read-only session.

1. `invoke_subagent` appears as a `tool_call` and changes immediately to `completed` because launch is asynchronous. The model often then returns `end_turn` with text such as "I'm exploring…".
2. When the subagent finishes, the agent wakes without a new `session/prompt`. Reads, `mcp_ooc_delegate`, and the final message arrive as `session/update` and `session/request_permission`. The `agy` changelog describes this behavior as intentional.
3. No notification marks the end of resumed work. The last notification is `usage_update`, which also arrives during a turn.
4. Asking the model to wait for subagents was insufficient. It scheduled a timer (`schedule`, `DurationSeconds: 15`), ended the turn, and woke when the timer fired.
5. The model sometimes called `manage_subagents` with `kill_all`, read the files itself, and called `delegate` in the same turn. Across four probes, three `delegate` calls arrived after `end_turn`.
6. `agy acp` offers no switch to disable subagents or background work. `--settings` is only available in `-p` mode.

`createAcpAgentFactory` closes the turn when `session/prompt` resolves. `onUpdate` discards updates with no active turn (`if (!turn) return`), and `permission` cancels a permission request with `picked(null)`. The late handoff is lost. This also happened with text-marker handoffs.

The team considered three options.

- **A. Keep the turn open for background work.** After `end_turn`, keep listening when `invoke_subagent` or `schedule` started and `manage_subagents` did not stop it with `kill` or `kill_all`. Collect the resumed work in the same turn and close after a quiet period, capped at roughly ten minutes. This would estimate completion from silence and need a `fake-agy` test that simulates the wake-up.
- **B. Temporarily exclude Antigravity from the leader role.** Implemented. Settings explain the limitation. Antigravity remains available as a reviewer and node. It worked as a reviewer after the follow-up turn. There was no live implementer trial.
- **C. Commit the runtime migration and handle the limitation separately.** The runtime migration landed first, followed by option B. Option A can be revisited if leader support reopens.

## Implementation status

- ADR 0034 cleanup landed in `4cc3684` before the implementation sequence.
- Feasibility was established by the November 18 trial. The runtime migration and English role prompts landed in `567de01`. Verification at that step was 574 tests passed and 3 skipped in `pnpm check`, plus 7 passed in `pnpm test:e2e`.
- Step 3 is complete. The UI, extension messages and settings, README, documentation, ADRs, AGENTS.md, and affected tests now use English. Historical test inputs, protocol literals, and benchmark labels in this record retain their original spelling where needed.

- Project licensing is deferred. The manifests and development VSIX omit a project license.
  Third-party asset notices stay with the assets. See [ADR 0002](0002-reuse-policy.md).

## Implementation references

- In the runtime, `packages/runtime/src/handoff-server.ts` and `handoff-main.ts` provide the server and entry point. `handoff.ts` contains schemas, `handoffTools`, `readHandoff`, and Markdown rendering. `contract.ts` compares fields, and `loop.ts` handles follow-up turns, including `EMPTY_LEADER_TURN_PROMPT` in `prompts.ts`. The old `delegation.ts` and `review.ts` parsers were removed.
- In the adapters, `claude/turn.ts` sets Claude MCP flags, `codex/agent.ts` sets thread configuration and `ooc` approval, `acp/agent.ts` registers `mcpServers` and handles `ooc` permission and refusal continuations, and `lines.ts` defines `onJsonLines`.
- The test fixtures `fake-claude.mjs`, `fake-app-server.mjs`, and `fake-agy.mjs` recognize `[handoff <tool> <json>]`. The historical `fake-agy` cue `MUTO` simulated a refusal followed by an empty turn.
- The extension uses esbuild to bundle `dist/handoff-server.js` for `ELECTRON_RUN_AS_NODE`. The webview has REPORT, REVIEW, and FINDINGS cards.
- The benchmark report contains the `handoffs` metric. `calc-include` and systems V1, V2, and V3 were local trial data. The historical Markdown result headings were `Test nascosti` ("Hidden tests") and `Consegne (strumenti ooc)` ("Handoffs (ooc tools)"). The complete local log was in `%LOCALAPPDATA%/only-one-chat/logs/bench-<runId>.jsonl`. Tool calls appear as `activity` events of type `mcp_tool` or `tool` and text as `message` events.

## Verification and reproduction

- `pnpm check` and `pnpm test:e2e` run without `sandbox/`.
- `pnpm bench --system V1 --scenario calc-include` requires a private copy of the scenario and user approval because it consumes quota.
- The ACP probes sent `initialize`, `session/new` with `mcpServers: [{ name: 'ooc', … }]`, `session/set_model`, and `session/prompt`. They accepted only permission requests with titles matching `Run mcp_ooc_*` and logged notifications with timestamps for one to two minutes, including after the reply to `session/prompt`.
- The handoff server can run from source with `node --import <file:// URL for dev/ts-resolve.mjs> packages/runtime/src/handoff-main.ts` and tools in the `OOC_HANDOFF_TOOLS` JSON environment variable. Windows ESM import specifiers use file URLs, for example `file:///F:/Only%20One%20Chat/...`.
