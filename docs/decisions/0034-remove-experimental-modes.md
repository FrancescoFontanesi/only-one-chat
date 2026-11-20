# 0034. Remove experimental runtime modes and the demo

Status: Accepted. Retires modes kept for the experiments in ADRs 0009 and 0010.

## Context

- **The runtime had six modes** covering `loop` (default), `question`, `pipeline`, `gateway` (with a `light` variant), `leader`, and `review`. The extension uses `leader` and `review`.
- **The other modes supported the ADR 0009 and 0010 experiments** on the gateway and three-turn layer, and the terminal demo (`pnpm demo`). The experiments are finished. Their results remain in `sandbox/results/` and `docs/role-evaluation.md`.
- **They added prompts, branches, and tests unreachable from the extension.** They also brought `loop.ts` above 1,800 lines, in the area the next ADR changes for the role handoff protocol.

## Decision

1. **Keep only `leader` and `review`** in the runtime. Remove `loop`, `question`, `pipeline`, `gateway`, and `light`, along with their prompts and tests.
2. **Keep the web app brief** (`<<<OOC-BRIEF`, ADRs 0018 and 0020). The leader still recognizes and delivers it. Remove the brief handling exclusive to the retired modes.
3. **Remove `dev/demo.ts` and `pnpm demo`.** Use `pnpm playground` for manual testing.
4. **Keep `leader`, `single`, and `session` systems in the benchmark.** Remove `pipeline` and `gateway` from the harness and scenarios.
5. **Split `loop.ts` by responsibility,** with role prompts separate from the loop. Make exports private if they have no callers outside their own file.

## Consequences

- Gateway and pipeline experiments require the historical code in Git. Their results remain available.
- Removing the unused modes reduces the code affected by the structured handoff protocol and English migration.
