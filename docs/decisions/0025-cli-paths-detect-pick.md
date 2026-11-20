# 0025. Finding CLI executables in settings

Status: Accepted (iteration 3).

## Context

- **The Providers section** required users to type the executable paths for Codex and Claude Code and omitted Antigravity.
- **The CLIs are often installed by the provider outside PATH.** `openai.chatgpt` ships `bin/<platform>/codex.exe`, `anthropic.claude-code` ships `resources/native-binary/claude.exe`, and the Antigravity installer puts `agy` in `%LOCALAPPDATA%\agy\bin`.

## Decision

1. **The protocol accepts Codex, Claude Code, and Antigravity.** It rejects all other provider names.
2. **Each path has three input methods.**
   - **Detect** looks in PATH, then in known locations for the provider's extension or installer.
   - **Select** opens a folder picker and searches the chosen folder and its `bin` subdirectory.
   - Users can still enter a path manually.
3. **Detection uses the same resolver as startup.** `resolveNativeExecutable` rejects `.cmd` and `.ps1` launchers. The check runs no programs and saves a path only when the executable exists.
4. **These machine-scoped settings are written to user settings.**

## Consequences

- VS Code returns the path of the active provider extension version. After that extension updates, the saved path still points to the old version until the user selects Detect again or clears the path. If the executable is missing, startup reports it.
