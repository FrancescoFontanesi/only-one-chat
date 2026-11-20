# CLI configuration diagnosis

This record describes the user's personal Codex and Claude profiles and the implications
for their adapters. `pnpm diagnose` (`packages/adapters/dev/diagnose.ts`) uses no model
quota, prints only allow-listed fields, and leaves credential files unopened. The
findings are from 2026-10-25 on Windows 11 x64.

## Findings

| Item                      | Codex                                                    | Claude                                                              |
| ------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------- |
| CLI                       | 0.164.0, official `rust-v0.164.0` release                | 2.1.308 (stable channel), official binary                           |
| Profile                   | Personal (`~/.codex`)                                    | Personal                                                            |
| Authentication            | `account/read` reports `chatgpt`, `plus` plan            | `auth status` reports `claude.ai`, `firstParty`, `pro` plan         |
| `requiresOpenaiAuth`      | `true` (declared by the `headroom` provider)             | —                                                                   |
| Key source                | ChatGPT token managed by Codex                           | `init` event reports `apiKeySource: "none"` (OAuth)                 |
| Active provider           | `headroom` ("Headroom persistent proxy")                 | `firstParty`                                                        |
| Base URL                  | `http://127.0.0.1:8787/v1` (also `openai_base_url`)      | `init` omits it, and the environment has no `ANTHROPIC_*` variables |
| Key environment variables | None                                                     | None                                                                |
| Usage beyond the plan     | —                                                        | `overageStatus: "rejected"` (`org_level_disabled`)                  |
| Profile model             | `gpt-6.1-sol`, effort `high`                             | User default                                                        |
| Lower-cost model          | `gpt-6-luna` (also `gpt-5.6-luna`), minimum effort `low` | `haiku` alias → `claude-haiku-5-5`, `--effort low`                  |

## Codex traffic routing with ChatGPT login

Turn traffic passes through Headroom. `ModelProviderInfo::to_api_provider`
(`model-provider-info/src/lib.rs:429-447`, tag `rust-v0.164.0`) uses the provider's
`base_url` when set, regardless of authentication. It falls back to
`https://chatgpt.com/backend-api/codex` when that value is absent.
With `requires_openai_auth = true`, Codex sends the ChatGPT token to Headroom, which
forwards it. Billing remains on the subscription. Account and rate-limit calls use
`chatgpt_base_url` (`https://chatgpt.com/backend-api/`).

## Claude diagnostic turn

The command was `claude -p --input-format stream-json --output-format stream-json --verbose
--no-session-persistence --tools "" --strict-mcp-config --model haiku --effort low`. The
prompt asked Claude to reply only with OK. Claude returned `OK` with
`model: claude-haiku-5-5`, `apiKeySource: none`, and `per_turn_effort_active: true`.
An initial attempt returned `429` (five-hour limit exhausted) before any inference
(`model: "<synthetic>"`).

Adapter findings:

- `--tools ""` removes built-in tools. The claude.ai MCP connectors remained active,
  including "Claude Docs" with `create`, `update`, and `delete`, which write to an
  external service. The adapter needs `--strict-mcp-config`.
- `total_cost_usd` is a nominal estimate under the subscription and does not represent
  a charge.
- `rate_limit_event` reports the `five_hour` and `seven_day` windows with
  `utilization` and `resetsAt`, which can inform failover.
- `claude doctor` reports that auto-update is active on the `latest` channel.
