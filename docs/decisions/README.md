# Architecture Decision Records

Each decision has its own `NNNN-title.md` file with Status, Context, Decision, and Consequences. Keep superseded decisions and mark them "Superseded by NNNN."

| ADR                                               | Title                                                                | Status                                          |
| ------------------------------------------------- | -------------------------------------------------------------------- | ----------------------------------------------- |
| [0001](0001-toolchain.md)                         | Bootstrap toolchain and versions                                     | Accepted                                        |
| [0002](0002-reuse-policy.md)                      | Reuse policy for reference sources                                   | Accepted                                        |
| [0003](0003-monorepo-layout.md)                   | Monorepo layout and internal packages                                | Accepted                                        |
| [0004](0004-codex-app-server-client.md)           | Codex App Server client over stdio                                   | Accepted                                        |
| [0005](0005-subscription-only-auth.md)            | Subscription-only authentication and a dedicated Codex profile       | Superseded by 0006                              |
| [0006](0006-personal-cli-profiles.md)             | Personal CLI profiles                                                | Accepted                                        |
| [0007](0007-subagents-visible-not-intercepted.md) | D13: Visibility and constraints for native subagents                 | Accepted                                        |
| [0008](0008-sandbox-mode.md)                      | Sandbox mode for local tests with confined writes                    | Accepted                                        |
| [0009](0009-chatgpt-web-and-three-turn-layer.md)  | ChatGPT on the web with a three-turn agent workflow                  | Partially superseded by 0010                    |
| [0010](0010-leader-chat-adaptive-delegation.md)   | Leader chat and adaptive delegation across subscriptions             | Accepted, partially superseded by 0018          |
| [0011](0011-panels-roles-approvals-continuity.md) | Panels, roles, approvals, and implementer continuity                 | Partially accepted, superseded by 0012 and 0018 |
| [0012](0012-layout-roles-catalog.md)              | Chat layout, sidebar views, and model catalog                        | Accepted                                        |
| [0013](0013-settings-page.md)                     | Settings page and assessment of proposed features                    | Accepted                                        |
| [0014](0014-checkpoints-and-review.md)            | Folder checkpoints and change review                                 | Accepted                                        |
| [0015](0015-context-and-mentions.md)              | Context indicator and file mentions with `@`                         | Accepted                                        |
| [0016](0016-chat-squad-layout.md)                 | Chat, Squad, and Settings from the design canvas                     | Accepted                                        |
| [0017](0017-implementer-handoff.md)               | Implementer handoff                                                  | Accepted                                        |
| [0018](0018-delegation-cycle.md)                  | Delegation cycle                                                     | Accepted                                        |
| [0019](0019-skills-questions-visible-turn.md)     | Skills, leader questions, and visible turn activity                  | Accepted                                        |
| [0020](0020-role-prompts-brief-report.md)         | Role prompts, briefs, and reports                                    | Accepted                                        |
| [0021](0021-auto-mode-ignored-paths-waiting.md)   | Claude Code auto mode, ignored paths, and pending requests           | Accepted                                        |
| [0022](0022-providers-per-role.md)                | Provider-independent roles and Claude questions                      | Accepted                                        |
| [0023](0023-board-nodes-and-acp.md)               | Nodes on the Squad board and Antigravity over ACP                    | Accepted                                        |
| [0024](0024-markdown-and-latex.md)                | Markdown and LaTeX in agent messages                                 | Accepted                                        |
| [0025](0025-cli-paths-detect-pick.md)             | Finding CLI executables in settings                                  | Accepted                                        |
| [0026](0026-mention-and-attach.md)                | Mention a file with @ and attach it with +                           | Accepted                                        |
| [0027](0027-history-and-blocks.md)                | Unified chat history and grouped recipient dial                      | Accepted                                        |
| [0028](0028-groups-on-the-dial.md)                | Groups and standalone nodes on the dial, Squad in the composer       | Accepted                                        |
| [0029](0029-reviewer-findings-and-review.md)      | The reviewer, findings, and review report                            | Accepted                                        |
| [0030](0030-diff-checks.md)                       | Diff checks in verified facts                                        | Accepted                                        |
| [0031](0031-role-contract-and-brief.md)           | The role contract and brief structure                                | Accepted                                        |
| [0032](0032-change-risk.md)                       | Estimating change risk                                               | Partially accepted, superseded by 0033          |
| [0033](0033-reviewer-always-and-direct.md)        | Review every job, including direct work, and expose review in the UI | Accepted                                        |
| [0034](0034-remove-experimental-modes.md)         | Remove experimental runtime modes and the demo                       | Accepted                                        |
| [0035](0035-handoff-tools-and-english.md)         | Structured handoff tools and English across the project              | Accepted                                        |
| [0036](0036-verification-traceability.md)         | Traceability for reported verification commands                      | Accepted, implementation pending                |
| [0037](0037-persist-implementer-handoff.md)       | Persist implementer handoffs                                         | Accepted                                        |
| [0038](0038-verification-and-handoff.md)          | Review cycles, red-green verification, and handoff status            | Accepted                                        |
