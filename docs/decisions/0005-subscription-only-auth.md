# 0005. Subscription-only authentication and a dedicated Codex profile

- Status: Superseded by [0006](0006-personal-cli-profiles.md) (2026-10-25)

## Context

The product must use personal subscriptions exclusively through official sign-in. A development machine can have API keys in its environment, proxies such as Headroom in the user's `config.toml`, or custom providers. See [../codex-auth.md](../codex-auth.md).

## Decision

1. **Fail closed.** Authorize only a `chatgpt` account with a provider that declares `requiresOpenaiAuth: true`. All other cases produce a refusal or `login_required`.
2. **Enforce the authentication gate in the client.** While account verification is pending or stale, the client sends only account-read requests.
3. **Set up a dedicated profile through `CODEX_HOME`.** This avoids using `--profile` or modifying the user's `config.toml`. Pin security-critical settings through `-c` overrides.
4. **Allowlist environment variables.** A new variable that enables a key or proxy stays excluded automatically.
5. **Use notifications only to downgrade authorization.** Authorization requires a successful `account/read` with no intervening change.

## Consequences

- On first use, the user signs in to ChatGPT in the dedicated profile, even if the personal profile is already signed in.
- Corporate proxies and managed system configuration remain known limitations.
