# 0029. The reviewer, findings, and review report

Status: Accepted. The prompt, runtime, and extension settings and thread were implemented. The reviewer was still absent from the Squad board at the time of this decision. Clarifies ADR 0020 on the brief and report and extends the delegation cycle in ADR 0018.

## Context

- **The implementer writes both code and its proof.** The implementer report states what was done. The leader compares the report with runtime facts, which list only changed files when no verification command is configured.
- **The leader needs a tested judgment and file references.** Its context is for reasoning and decisions (ADR 0018), so reviewing the full diff belongs elsewhere.
- **An independent assessment requires a third model** on a user-selected provider. This model has authored neither the brief nor the code.
- **One pair omitted the historical `Bloccato su` (Blocked on) section** in the first role evaluation. The instructions made it optional for a completed outcome.

## Decision

1. **A third role prompt**, `packages/runtime/prompts/reviewer.md`, loads like the other two (`REVIEWER_ROLE_INSTRUCTIONS`). The reviewer has three responsibilities.
   - Receive the original brief sent to the implementer, the report, verified facts, and the number of correction rounds left. The conversation between user and leader is private to them.
   - Run commands and write tests. It suggests corrections to the implementer, who owns changes to the code under review. See "The reviewer writes tests" below.
   - Start with the brief, then read the changes, rerun the checks, and test behaviors the existing tests miss.
2. **A finding requires evidence.** Provide a command or test with its expected and actual outcomes, or the exact location and input that triggers the defect. Cite the violated criterion, constraint, or repository rule. Assign a stable number (R1, R2, and so on) and severity, historically `bloccante` (blocking) or `minore` (minor). Put an unproven concern under `Non verificato` (Unverified). Ambiguity in the brief goes to the leader for a decision.
3. **Two blocks, one per turn.** The runtime recognizes opening and closing lines and routes the blocks as written (`packages/runtime/src/review.ts`).
   - `<<<RILIEVI` … `RILIEVI>>>` goes to the implementer on its own. The reviewer emits it if at least one blocking finding exists and correction rounds remain.
   - `<<<REVISIONE` … `REVISIONE>>>` goes to the leader and ends the review. The historical sections were `Verdetto` (Verdict), `Criteri` (Criteria), `Modifiche` (Changes), `Rilievi` (Findings), `Decisioni` (Decisions), `Sul brief` (About the brief), and `Non verificato` (Unverified). Verdict values were `approvato` (approved), `con riserve` (with reservations), and `respinto` (rejected).
   - A response missing a complete block, or findings submitted after the final correction round, ends the review and reaches the leader unchanged, so nothing the reviewer found is lost. If both blocks appear, the review report takes precedence.
4. **Runtime cycle** (`leader` mode, the `reviewer` option of `runLoop`).
   - After the implementer reports, the runtime opens a reviewer session for that delegation and closes it when the cycle ends. Its context covers only that brief.
   - A `bloccato` report goes directly to the leader. `completato`, `parziale`, and reports without a readable outcome receive a review.
   - There are two correction rounds by default and up to three (`reviewRounds`). Each round sends findings to the implementer as data. The implementer updates its report, the runtime recalculates verified facts, and the reviewer checks again.
   - Reviewer and implementer messages pass automatically, like reports in ADR 0018. Each appears in the thread and the log.
   - The runtime then logs a `reviewed` event with reviewer, implementer, verdict, and round count. The leader receives the review report and facts in place of the implementer report. With deferred review (`review: 'deferred'`), the leader receives it with the user's next message.
5. **The exchange has a fixed end.** The implementer reproduces the evidence before fixing it and responds to each finding as fixed, disputed on the grounds of the brief, or left open. The reviewer rechecks open findings and the effects of the fix. An unresolved disagreement goes to the leader with both positions, without filing the same finding again.
6. **The implementer report (ADR 0020) changes.**
   - Every section is required. An empty section says `nessuno` (none).
   - The outcome is `completato` only when each criterion has a verification command executed in the turn.
   - `Modifiche` connects each file to its criterion and lists tests.
   - `Verifica` gives a status per criterion and discloses new tests observed to fail before the change and existing tests that were modified, skipped, or removed.
   - After findings, the implementer rewrites the entire report because the latest report supersedes earlier ones. A `Rilievi` section follows the outcome.
7. **The brief (ADR 0020) changes.**
   - Each criterion defines observable behavior with concrete input and expected output examples wherever the value matters. Return an untestable criterion to the user as a decision.
   - Each brief asks for one outcome, specifies agreed interfaces in full, and uses the repository's verification commands.
   - The reviewer reads the brief too. Write down the requirements that review will enforce.
8. **The implementer runs new tests before writing the code** and observes them fail. A test that already passes provides no evidence of the change.

## Consequences

- The leader receives changed file references tied to criteria and the command the reviewer ran for each criterion.
- Review costs a second model for each brief, plus one implementer turn per correction round. Review is optional. Disabling it restores the previous cycle.
- A flawed brief can mislead both roles. Review verifies the implementation against the brief, so the brief still needs to be right.
- The `reviewed` event supplies the first history data by role and model, with a verdict and round count per job. See the [roadmap](../roadmap.md).
- **Extension settings for the reviewer.**
  - The reviewer is the third role, with a provider, model, and reasoning level. Codex, Claude, and Antigravity are supported because the reviewer does not ask the user questions.
  - The Reviewer section enables review through `onlyOneChat.reviewer.enabled`, off by default at this point, and sets the correction rounds through `reviewer.rounds`. Reviewer instructions are alongside the other role instructions.
  - Changes apply from the next chat. If the CLI lacks the selected model, the chat starts without a reviewer and reports why.
- **The reviewer writes tests.** This was the user's decision after the third role evaluation. The read-only reviewer had missed a real defect that it could not test.
  - Like the implementer, the reviewer works in the project folder with the CLI's native permissions.
  - Before each reviewer turn, the runtime checkpoints the folder. After the turn it restores every changed file other than tests (`apps/vscode/src/session/guard.ts`) and tells both the leader and the implementer.
  - Reviewer tests stay as evidence. The implementer needs to fix the code so these tests pass.
  - If the runtime cannot checkpoint the folder, such as when it contains too many files, the reviewer falls back to read-only mode and learns this in its first prompt.
  - The runtime reverts code writes after the turn. Blocking those writes during the turn would cover only Claude's editing tools, since shell commands can also write, and would add another permission layer. The user confirmed the post-turn approach.
- **The thread labels its turns REVIEWER.** Findings and review reports get cards like the implementer report, with a verdict on the review card. A notice shows the verdict and round count after the review. The session lasts for one delegation, so there is no reviewer session to resume.
- **The reviewer assesses three dimensions beyond the criteria** based on the third role evaluation (`docs/role-evaluation.md`). Integrity asks whether the implementation cheats, security takes precedence over functionality, and currency checks the versions the project actually uses. The historical `Giudizio` (Assessment) section has one line per dimension. A doubtful assessment prevents approval. Model capability matters here. With this prompt, Haiku, Terra, and Hydrogen found a seeded defect that Luna missed in an earlier test.
- **A read-only Antigravity reviewer cannot execute commands.** The session denies every permission request, and a denial could end a turn without text. In read-only mode, the runtime explains this in the first prompt (`NO_COMMANDS_NOTE`). An empty review cannot approve the work (`EMPTY_REVIEW`), and the ACP adapter treats an empty turn with an abnormal stop reason as an error.
- **When review runs** was governed by estimated risk (ADR 0032).

Remaining work under TODO(reviewer).

- Add the reviewer to the Squad board and agent activity monitor, which currently show the two roles on the dial.
- Test reviewer-written tests using the real CLI for each provider, and run the findings cycle on the real null-byte defect in `calc-include`.
- Qualify reviewers on seeded defects, with one test per defect and four models.
