# Codex authentication with a personal profile and verified subscription

Iteration 1. Codex runs in the user's personal profile.
[ADR 0006](decisions/0006-personal-cli-profiles.md) supersedes ADR 0005.

`packages/adapters/src/codex/auth.ts` interprets auth status, `session.ts` handles launch,
the authentication gate, and denied methods, and `src/environment.ts` filters the
environment. Tests live in `test/codex-auth.test.ts` and `test/codex-contract.test.ts`.

## Policy

Access to the model requires a **ChatGPT** account with a provider that uses OpenAI
authentication (`requiresOpenaiAuth: true`). For providers that cannot verify the
subscription, such as proxies or custom providers that use a different authentication
method, access requires the caller to enable `allowUnverifiedProvider`. The gate always
rejects API keys and fails closed when it cannot verify status.

## Contract

`connectCodex(options)` starts `codex app-server` without overrides, completes the
handshake, and immediately calls `account/read` followed by `config/read` to identify
the provider. The `auth` state is one of the following:

| `account/read` response                                            | State                                    |
| ------------------------------------------------------------------ | ---------------------------------------- |
| `account.type: "apiKey"` with any provider                         | `rejected / api_key`                     |
| `requiresOpenaiAuth: true`, `account.type: "chatgpt"`, and a plan  | `authorized`                             |
| `requiresOpenaiAuth: true`, `account: null`                        | `login_required` (login in the terminal) |
| `requiresOpenaiAuth: false` with `allowUnverifiedProvider` enabled | `unverified_provider { provider }`       |
| `requiresOpenaiAuth: false` with the option disabled               | `rejected / provider_not_verified`       |
| Other `account.type` values (`amazonBedrock`, future types)        | `rejected / unsupported_mode`            |
| Error, timeout, incomplete response, or malformed response         | `rejected / read_failed`                 |

`provider` is `{ id, name, baseUrl, unofficialBaseUrl }` from `config/read`, using
`model_provider` and its entry in `model_providers` (`name`, `base_url`).
`unofficialBaseUrl` is true when `base_url` points outside the HTTPS endpoints at
`api.openai.com` and `chatgpt.com`, or when a provider other than `openai` omits it.
If `config/read` fails, the value is
`{ id: "unknown", name: null, baseUrl: null, unofficialBaseUrl: true }`. The
`provider_not_verified` message names the provider and explains how to enable it.

**Provider display.** `session.provider` reports the latest provider even with
`requiresOpenaiAuth: true`. It supports the "via proxy" indicator (for Headroom,
`headroom`, `http://127.0.0.1:8787/v1`, and `unofficialBaseUrl: true`). The `auth`
state alone controls access.

**Gate.** `session.request()` lets only `account/read` through without verification.
Each other request requires a current `authorized` or `unverified_provider` state.
Otherwise, the promise rejects with `CodexAuthError` before the message reaches the
server. For `login_required`, the message directs the user to run `codex login` in a
terminal.

**Methods denied in every state** (`deniedReason`):

| Method                                 | Reason                                      |
| -------------------------------------- | ------------------------------------------- |
| `account/rateLimitResetCredit/consume` | Spends a rate-limit reset credit            |
| `account/sendAddCreditsNudgeEmail`     | Sends email                                 |
| `feedback/upload`                      | Sends feedback, logs, and threads to OpenAI |
| `plugin/share/save`                    | Publishes a plugin to other people          |
| `plugin/share/updateTargets`           | Changes who a plugin is shared with         |
| `account/login/start`, `/cancel`       | Login uses the CLI in the terminal          |
| `account/logout`                       | Logs out the user's profile                 |
| `remoteControl/*`                      | The user controls remote control            |

`initialize` omits the `experimentalApi` capability required by experimental methods,
including remote control. The user's own remote control configuration remains in effect.

**Account changes.** `account/updated` and `account/login/completed` mark the state as
_stale_. The next request rereads `account/read`. A notification alone can only remove
authorization (`apikey` → `api_key`, `null` → `login_required`, another value →
`unsupported_mode`). `chatgpt` requires a fresh read. An in-flight read is discarded
if the account changes.

**Startup.** In a signed-in profile, Codex announces the account through
`account/updated` with `authMode: "chatgpt"` **during** the first `account/read`, which
is then discarded. In `personal-startup.jsonl`, the notification occurred once at
0.58 s in a 65 s idle observation. At startup, `connectCodex` reads at most **3 times**
until a read completes without an intervening change. If none does, the state remains
`rejected / read_failed`.

## Environment and launch

- The launch uses the user's profile and configuration without forcing `CODEX_HOME` or
  passing `-c` overrides.
- The user's environment is passed through except for key variables, matched
  case-insensitively: `OPENAI_API_KEY`, `CODEX_API_KEY`, `CODEX_ACCESS_TOKEN`,
  `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `GEMINI_API_KEY`, and `GOOGLE_API_KEY`.
  Base URLs, proxies, and Headroom and rtk variables are preserved.
- **Isolated test and recorder profiles** use a temporary `CODEX_HOME`,
  `-c features.plugins=false`, and `-c skills.bundled.enabled=false`
  (`dev/isolated-profile.ts`) to make recordings reproducible and network-free.

## Verified behavior

Fake-server checks covered authorization for ChatGPT, API key rejection even with a custom
provider and `allowUnverifiedProvider`, and `login_required` with instructions to run
`codex login` and no additional calls. They covered rejection of Bedrock and unknown
account types, default rejection of custom providers with the name and setup instructions,
and opt-in access. The tests checked that every read exposes the provider and base URL,
that an account announcement prompts a reread with a three-read cap, and that account
changes are handled. They also covered rejection of errors and incomplete responses,
environment filtering that preserves the base URL and proxy, launch without overrides,
and blocking denied methods.

Historical findings from the real Codex CLI 0.164.0:

- With a new isolated profile, `account/read` returned
  `{ account: null, requiresOpenaiAuth: true, workspaceRouting: null }`, so the state
  was `login_required`. `config/read` returned `model_provider: null` and
  `model_providers: {}` (the `openai` provider). With a custom provider that bypasses
  OpenAI authentication, `requiresOpenaiAuth` was false and `config/read` reported the
  provider's `name`. See the `startup.jsonl` and `custom-provider.jsonl` transcripts.
- The user's personal profile had ChatGPT Plus and the `headroom` provider with
  `requires_openai_auth = true`, yielding `authorized`. `workspaceRouting` was an object
  with `chatgptAccountId`, `backendOrigin`, and `accountRoutingOverride`. Remote control
  was `disabled` with `environmentId: null`. See [diagnosis.md](diagnosis.md) and
  `personal-startup.jsonl`.

## Remaining limitations

- **Trust in the provider.** With `requires_openai_auth = true`, Codex sends the ChatGPT
  token to the provider's `base_url` (Headroom in the user's case). Verification relies
  on that declaration and the user-configured proxy.
- **Token validity.** `account/read` reports stored credentials. An expired or revoked
  token fails on the first real request.
- **System-managed configuration** takes precedence and is outside the extension's
  control. `requiresOpenaiAuth` still identifies a provider imposed this way.
- **Global configuration for processes started by Codex.** Processes such as plugin
  `git` today and commands during future turns read the user's global configuration,
  including `~/.gitconfig` with `http.proxy`, `url.*.insteadOf`, or credential helpers.
- **Plan.** ChatGPT plans (`free`, `plus`, `pro`, and others) are treated the same.
