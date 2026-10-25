# Diagnosi della configurazione dei CLI

Come sono configurati Codex e Claude nei profili personali dell'utente, e cosa ne segue
per gli adapter. Strumento: `pnpm diagnose` (`packages/adapters/dev/diagnose.ts`), che non
consuma quota del modello, stampa solo campi in whitelist e non apre file di credenziali.
Rilevazione del 2026-10-25 su Windows 11 x64.

## Risultati

| Voce                         | Codex                                                    | Claude                                                |
| ---------------------------- | -------------------------------------------------------- | ----------------------------------------------------- |
| CLI                          | 0.164.0, release ufficiale `rust-v0.164.0`               | 2.1.308 (canale stable), binario ufficiale            |
| Profilo                      | personale (`~/.codex`)                                   | personale                                             |
| Autenticazione               | `account/read`: `chatgpt`, piano `plus`                  | `auth status`: `claude.ai`, `firstParty`, piano `pro` |
| `requiresOpenaiAuth`         | `true` (lo dichiara il provider `headroom`)              | —                                                     |
| Fonte della chiave           | token ChatGPT gestito da Codex                           | evento `init`: `apiKeySource: "none"` (OAuth)         |
| Provider attivo              | `headroom` ("Headroom persistent proxy")                 | `firstParty`                                          |
| Base URL                     | `http://127.0.0.1:8787/v1` (anche `openai_base_url`)     | non esposto da `init`; nessun `ANTHROPIC_*` nell'env  |
| Variabili di chiave nell'env | nessuna                                                  | nessuna                                               |
| Consumo oltre il piano       | —                                                        | `overageStatus: "rejected"` (`org_level_disabled`)    |
| Modello del profilo          | `gpt-6.1-sol`, effort `high`                             | default dell'utente                                   |
| Modello economico            | `gpt-6-luna` (anche `gpt-5.6-luna`), effort minimo `low` | alias `haiku` → `claude-haiku-5-5`, `--effort low`    |

## Routing del traffico di Codex con il login ChatGPT

Il traffico dei turni passa da Headroom. `ModelProviderInfo::to_api_provider`
(`model-provider-info/src/lib.rs:429-447`, tag `rust-v0.164.0`) usa il `base_url` del
provider quando è impostato, qualunque sia l'autenticazione; ricade su
`https://chatgpt.com/backend-api/codex` solo se manca. Con `requires_openai_auth = true`
Codex invia a Headroom il token ChatGPT, che Headroom inoltra: la fatturazione resta la
subscription. Le chiamate di account e rate limit usano invece `chatgpt_base_url`
(`https://chatgpt.com/backend-api/`), non il provider.

## Turno Claude di diagnosi

Un turno `claude -p --input-format stream-json --output-format stream-json --verbose
--no-session-persistence --tools "" --strict-mcp-config --model haiku --effort low`,
prompt "Rispondi solo OK": risposta `OK`, `model: claude-haiku-5-5`, `apiKeySource:
none`, `per_turn_effort_active: true`. Un primo tentativo era stato rifiutato con `429`
(limite delle 5 ore esaurito) prima di qualsiasi inferenza (`model: "<synthetic>"`).

Osservazioni che entrano nell'adapter:

- `--tools ""` toglie gli strumenti integrati ma non quelli MCP: restavano attivi i
  connettori claude.ai, fra cui "Claude Docs" con `create`, `update` e `delete`, che
  scrivono su un servizio esterno. Serve `--strict-mcp-config`.
- `total_cost_usd` è una stima nominale anche con la subscription: non indica addebito.
- L'evento `rate_limit_event` riporta le finestre `five_hour` e `seven_day`
  (`utilization`, `resetsAt`), utili per il failover.
- `claude doctor` indica l'auto-update attivo (canale `latest`).
