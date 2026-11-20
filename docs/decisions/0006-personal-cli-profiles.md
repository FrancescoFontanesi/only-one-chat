# 0006. Personal CLI profiles

- Status: Accepted (2026-10-25)
- Supersedes: [0005](0005-subscription-only-auth.md)

## Context

ADR 0005 isolated Codex in a dedicated `CODEX_HOME`, with overrides pinning the provider, base URL, and sign-in method, plus an environment allowlist. This required signing in again and disabled the user's configuration, including Headroom (a local compression proxy configured as the `headroom` Codex provider) and rtk (a hook that compresses command output). The 2026-10-25 diagnosis found that on the user's machine Codex uses a ChatGPT Plus account through Headroom and Claude uses a claude.ai Pro sign-in. [../diagnosis.md](../diagnosis.md)

## Decision

1. **Use personal profiles.** Adapters launch CLIs with the user's profile (`~/.codex` or `CODEX_HOME` from the environment for Codex, the user's profile for Claude). The CLIs retain control of sign-in, credentials, and configuration. The extension leaves sign-in and sign-out to the user's terminal, keeps credential files untouched, and reads configuration only through CLI commands or protocols. If the user needs to sign in, the extension tells them.
2. **Filter API credentials from the user's environment.** Remove only `OPENAI_API_KEY`, `CODEX_API_KEY`, `CODEX_ACCESS_TOKEN`, `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `GEMINI_API_KEY`, and `GOOGLE_API_KEY`. Pass through base URLs and proxies because the user's configuration depends on them.
3. **Fail closed on Codex account verification.**
   - API key authentication is rejected for every provider.
   - ChatGPT with `requiresOpenaiAuth: true` is authorized. Headroom qualifies because it forwards the ChatGPT token.
   - `requiresOpenaiAuth: false` indicates a custom provider whose subscription cannot be verified. It requires `allowUnverifiedProvider`. The status shows the provider returned by `config/read`.
   - Errors and malformed responses cause refusal.
4. **Block methods that spend credits or send communications** (`account/rateLimitResetCredit/consume`, `account/sendAddCreditsNudgeEmail`, `feedback/upload`, `plugin/share/save`, and `plugin/share/updateTargets`), plus sign-in, sign-out, and `remoteControl/*`. `initialize` always omits `experimentalApi`.
5. **Keep isolated profiles for tests and the recorder only.** Overrides in `dev/isolated-profile.ts` make them reproducible and disable network access. Production uses personal profiles.

## Consequences

- The user keeps their current sign-in and configuration, including Headroom, rtk, plugins, and skills.
- A proxy declaring `requires_openai_auth = true` receives the ChatGPT token. Subscription verification trusts the declaration of the provider configured by the user.
- The user's profile remains under their control. For example, Codex remote control can remain enabled in the profile, and the client leaves its controls to Codex and the user.
- Processes launched by the CLIs read the user's global configuration (for example, `~/.gitconfig`) independently of the extension.
