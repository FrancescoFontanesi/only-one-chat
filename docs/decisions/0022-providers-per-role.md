# 0022. Provider-independent roles and Claude questions

Status: Accepted (iteration 3). Clarifies permissions per role in ADR 0011 and leader questions in ADR 0019.

## Context

- **Settings and Squad already allowed provider selection per role.** The backend still chose between Codex and Claude in one `if`, restricted questions to Codex leaders, and reserved the permissions bridge for Claude roles with write access.
- **A Claude leader already worked with a Codex implementer.** Interactive questions were missing.
- **Future providers include other CLIs and local models.** Chat and Squad should work from the role's requirements and let the provider handle its own integration.
- **Claude Code provides `AskUserQuestion`.** Tests on 2.1.322 showed how the tool is enabled.
  - `-p` with `--permission-prompts none` omits the tool even if `--tools` lists it.
  - `--permission-prompts host` also omits it.
  - `--permission-prompt-tool stdio` enables it through the Agent SDK host protocol. The stream carries a `can_use_tool` control request and the host approves it with `answers` in the input.
  - A `PermissionRequest` hook alone leaves the tool unavailable.

## Decision

1. **A provider registry** in `apps/vscode/src/session/providers.ts`. The chat describes the role with a CLI, model, reasoning level, permissions, and whether it is the leader. The provider translates that description to its own harness. Each provider defines how to create sessions, whether it requests permission through the extension bridge (Claude) or its own protocol (Codex), and the disallowed subagent names. Adding a provider requires a registry entry and adapter.
2. **All leaders can ask questions.** Codex uses `requestUserInput` and Claude uses `AskUserQuestion`.
3. **A Claude leader hosts the SDK protocol for questions only.**
   - The turn starts with `AskUserQuestion` in `--tools` and replaces `--permission-prompts none` with `--permission-prompt-tool stdio`.
   - The turn's `onQuestion` handles `can_use_tool` requests for `AskUserQuestion` through the same runtime path as Codex. Questions are logged and cancelled when the turn stops.
   - The returned input keys each answer by question text and separates multiple selections with commas. The call is denied if no answer is returned.
   - All other requests that would prompt are denied immediately with a message attributing the denial to the read-only role. The historical message was `Negato dal ruolo` (Denied by role). The effect matches `--permission-prompts none`.
   - The leader runs without a bridge or hook. `--tools` excludes write tools.
4. **The Claude implementer continues to use the permission hook (R9) and auto mode (ADR 0021).** Interactive questions remain exclusive to the leader (ADR 0019).

## Consequences

- A Claude leader and Codex implementer can delegate, report, review, and ask questions like the reverse pairing.
- Provider-specific details remain in `ChatConfig` for executables and subagents, and in model catalogs, usage retrieval, and UI labels.
- The integration uses `can_use_tool` directly without the SDK. A Claude Code change to that control protocol could break questions. Permissions use a separate mechanism.
