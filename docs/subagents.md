# Subagents

Iteration 1, decision D13 ([ADR 0007](decisions/0007-subagents-visible-not-intercepted.md)).
`packages/runtime/src/loop.ts` handles policy, labels, and checks. Provider code lives
in `packages/adapters/src/codex/agent.ts`, `src/claude/agent.ts`, and `src/claude/turn.ts`.

## Model

- **External agents** (Codex, Claude) hand work off through the runtime. The user can
  approve, edit, or cancel the intercepted delegation. ADR 0035 replaced the original
  delegation block with a structured tool call.
- **Subagents** run within the same CLI and only on explicit request. Like Codex
  extension subagents, they require no approval. They are **always visible** and
  **constrained** by model, effort, count, and name. The role policies use Luna for Codex
  and Haiku 5.5 for Claude, both with effort `low` and up to two running at once. The
  `dev/subagent-check.ts` trial read the `OOC_CODEX_SUBAGENT_*` and
  `OOC_CLAUDE_SUBAGENT_*` variables.
- A subagent may neither use nor claim the name of an external agent or its model.
  Role instructions specify this and the runtime checks whole words by provider. For
  Codex, `CODEX_SUBAGENT_FORBIDDEN_NAMES` forbids `claude`, `haiku`, `opus`, `sonnet`, and
  `gemini`. For Claude, `CLAUDE_SUBAGENT_FORBIDDEN_NAMES` forbids `codex`, `luna`, `sol`,
  `gpt`, and `gemini`. Its own provider names are valid, so Claude permits
  `haiku-file-reader`. `solution-finder` contains no whole-word match for `sol`.

Each role configures its policy through `LoopOptions.subagents` (`model`, `effort`,
`maxConcurrent`, and `forbiddenNames`). The runtime generates `subagentRules` and
passes the rules and policy to the agent factory. The adapter applies them through
native CLI mechanisms and leaves the user's configuration untouched.

## Enforced constraints

**Codex** uses per-thread `thread/start` `config` overrides. The keys come from
`codex-rs/core/config.schema.json` at `rust-v0.164.0` (multi-agent backend v2).

| Key                                                               | Value                                        |
| ----------------------------------------------------------------- | -------------------------------------------- |
| `agents.default_subagent_model`                                   | Policy model (`gpt-6-luna`)                  |
| `agents.default_subagent_reasoning_effort`                        | Policy effort (`low`)                        |
| `agents.max_concurrent_threads_per_session` and its v2 equivalent | `maxConcurrent` (2)                          |
| `features.multi_agent_v2.expose_spawn_agent_model_overrides`      | `false`, preventing model selection at spawn |
| `features.multi_agent_v2.multi_agent_mode_hint_text`              | Spawn only on explicit request               |
| `features.multi_agent_v2.root_agent_usage_hint_text`              | Tools, `fork_turns: "none"`, and rules       |
| `features.multi_agent_v2.subagent_usage_hint_text`                | Internal identity and rules                  |

The two role hints fully replace those in Codex (`core/src/session/multi_agents.rs`),
so they also describe the tools. A real `thread/start` with no turns verified that
`MultiAgentV2ConfigToml` rejects unknown keys.

**Claude** sets `CLAUDE_CODE_SUBAGENT_MODEL` with `_FORCE=1`,
`CLAUDE_CODE_EFFORT_LEVEL`, `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH=1`, and
`CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` in the child process environment only. These
names are documented and present in the 2.1.308 binary. The adapter adds the `Agent`
tool to `Read,Grep,Glob` and passes `--forward-subagent-text`.

- Subagents inherit the parent tools and stay read-only.
- Without `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS`, a subagent runs in the background and
  reports in a later turn, which a resumed `-p` turn may miss. With the variable set,
  Claude waits within the same turn. `calc-session` documents the case.
  `CLAUDE_CODE_EFFORT_LEVEL` also applies to the parent session, so the policy effort
  must match the parent effort.

## Monitoring

| Activity              | Codex                                                                             | Claude                                                                                                              |
| --------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Start                 | `subAgentActivity` `started` on the parent thread with resolved model and effort  | `Agent` `tool_use` with the name from `subagent_type`. Model arrives with the first message (`parent_tool_use_id`). |
| Messages and commands | Subagent thread notifications on the same connection                              | Messages with `parent_tool_use_id`                                                                                  |
| End                   | `subAgentActivity` `completed` or `interrupted`, and the child's `turn/completed` | `tool_result` for the `Agent` call                                                                                  |
| Stop                  | `turn/interrupt` for each active subagent turn and for the parent                 | Process tree termination                                                                                            |

Each subagent becomes a thread event (`subagent`) nested under the turn that created it.
The runtime labels it with the parent agent, name, model, effort, and status. Text and
commands stream through `subagent_text` and `subagent_activity`.

**Post-launch checks** (`checkSubagent`) stop the turn with `subagent_violation` and a
clear `failed` result if the model or effort conflicts with the policy, the subagent
name contains a whole-word external agent name (such as `/root/claude_review`), or the
count exceeds the limit. A value omitted by the CLI is allowed and shown as
"not reported" in the label.

**Former attribution warning.** Until ADR 0034, the runtime emitted
`attribution_warning` when the leader's conclusion named an external agent that had
done no work. ADR 0034 removed it along with the experimental modes.

## Historical live verification (`dev/subagent-check.ts`, one turn per CLI)

- **Claude Code 2.1.308, Haiku, low.** The user's custom `haiku-file-reader` agent ran
  on `claude-haiku-5-5` at depth 1 with only `Grep` and `Read`, with no violation.
  Effort was enforced and absent throughout the stream and `result` (`modelUsage`,
  `subagent_stats`). The real stream also included `system` events `task_started`,
  `task_progress`, `task_updated`, and `task_notification`. `init` listed the tool as
  `Task`. The fake replays the recording in `turn-subagent.jsonl`.
- **Codex 0.164.0, Luna, low, first turn.** Creation failed with `no rollout found`
  and launched no subagent. `spawn_agent` inherits the full parent history by default
  (`fork_turns: "all"`), which an `ephemeral` thread does not keep on disk. The role
  instructions now ask for `fork_turns: "none"` and context in the task.
- **Codex, second turn** (`subagent-turn.jsonl`). The subagent `/root/env_read` started
  with its own thread, ran a read command, and reached `completed`.
  `subAgentActivity` reported `gpt-6-luna` and effort `low` while the parent thread
  used the profile default `high`. The `default_subagent_reasoning_effort` override
  took effect (`medium` in run 2 without the override). There was no violation.
  `multiAgentMode` in the `thread/start` response stayed `explicitRequestOnly` with
  the per-thread hint, so the field did not reflect it. The one explicitly requested
  subagent is consistent with both the hint and the default mode, leaving application
  of the hint unverified.

## Limits

- Codex has no spawn approval request in its protocol. The runtime checks after
  the launch has already used some quota (28 ms before the subagent turn in run 2).
- A user-defined Codex role (`agents.<name>.config_file`) could set another model.
  The post-launch check detects this.
- **Claude subagent effort is unobservable.** The adapter sets
  `CLAUDE_CODE_EFFORT_LEVEL` in the process environment. In the real turn, Claude Code
  2.1.308 omitted effort from subagent messages, `system` `task_*` events, and `result`
  (`modelUsage`, `subagent_stats`). The post-launch check can verify only the model.
  The label says "effort not reported", and an effort mismatch cannot stop the turn.
  If a future version reports effort, pass it in the `identified` event.
- User-defined agent names become subagent names. A whole-word external provider or
  model name, such as `gpt-helper` under Claude, stops the turn.
