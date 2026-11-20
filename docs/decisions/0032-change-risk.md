# 0032. Estimating change risk

Status: Partially accepted and superseded by ADR 0033. The reviewer now runs for every change, and risk remains a fact for the reviewer and leader. ADR 0033 removed `onlyOneChat.reviewer.trigger` (item 4).

## Context

- **A review costs about as much as an implementation turn**, taking 60–90 seconds and using 30,000–100,000 tokens. Seven reviews of real work found nothing in the evaluations.
- **Even small tasks can have defects.** The small `round` task had a real minor defect.
- **The estimate needs to be deterministic, repeatable, and explainable,** with no model involved.
- **Sources.**
  - Just-in-time defect prediction (Kamei et al.) identifies change size as the strongest signal, followed by dispersion across files and folders.
  - Risk estimation tools look at added decision points (cyclomatic complexity), files that depend on changed files, and sensitive areas. Signals are bounded to 0–1 and combined with fixed weights.

## Decision

1. **`apps/vscode/src/session/risk.ts` estimates low, medium, or high risk** from before-and-after file contents already captured in the message checkpoint.
   - **Size (0.30)** counts changed source lines on a logarithmic scale, capped at 400.
   - **Dispersion (0.20)** takes the larger of the changed source file count (capped at 10) and the folder count (capped at 5), each normalized to its cap.
   - **Added complexity (0.20)** counts new decision points (`if`, loops, `case`, `catch`, `&&`, `||`, and ternaries), capped at 25.
   - **Dependents (0.15)** counts the source files importing the most widely used changed file, on a logarithmic scale capped at 20.
   - **No test changes (0.15)** applies when more than 20 source lines change and tests are untouched.

   A score below 0.25 is low. A score of at least 0.55 is high.

2. **Two signals raise the level regardless of the score.**
   - Added code dealing with inputs an attacker can control (files and paths, commands, network, untrusted code or data, composed queries, credentials) makes the risk high.
   - A runtime diff check flag (ADR 0030) makes the risk at least medium.
3. **Runtime facts include the level and reasons** alongside the diff checks.
4. **Historical `onlyOneChat.reviewer.trigger` behavior.**
   - `risk` (default) runs the reviewer at medium risk or higher.
   - `always` runs the reviewer every time.

   A skipped review appears in the leader's facts and the thread. A change without a checkpoint is reviewed because its risk cannot be estimated.

## Consequences

- In the ten real tasks evaluated, all five `round` changes were low risk (0.20–0.24), and all five `include` changes were high risk because they handled files and paths.
- The weights and thresholds need calibration on other projects. The score gives a reason to review. Under this rule, the minor `round` defect would have gone unreviewed.
- The patterns match text, including words in comments.
- At the time of this decision, a manual review request for a single low-risk delegation remained open.
