# Autenticazione Codex: profilo personale, subscription verificata

Stato: iterazione 1. Codex gira nel profilo personale dell'utente
([ADR 0006](decisions/0006-personal-cli-profiles.md), che sostituisce lo 0005).

Codice: `packages/adapters/src/codex/auth.ts` (interpretazione dello stato),
`session.ts` (lancio, gate, metodi negati), `src/environment.ts` (filtro dell'ambiente).
Test: `test/codex-auth.test.ts`, `test/codex-contract.test.ts`.

## Regola

Il modello si può usare con un account **ChatGPT** su un provider che usa
l'autenticazione OpenAI (`requiresOpenaiAuth: true`). Un provider che non la usa (proxy o
provider personalizzato) non permette di verificare la subscription: è ammesso solo se il
chiamante lo abilita con `allowUnverifiedProvider`. Le API key sono sempre rifiutate. Se
lo stato non è verificabile, il risultato è il rifiuto.

## Contratto

`connectCodex(options)` avvia `codex app-server` senza override, completa l'handshake e
**subito dopo** esegue `account/read` seguito da `config/read`, che dà il provider. Lo
stato `auth` è uno dei seguenti:

| Risposta di `account/read`                                    | Stato                                  |
| ------------------------------------------------------------- | -------------------------------------- |
| `account.type: "apiKey"`, con qualsiasi provider              | `rejected / api_key`                   |
| `requiresOpenaiAuth: true`, `account.type: "chatgpt"` + piano | `authorized`                           |
| `requiresOpenaiAuth: true`, `account: null`                   | `login_required` (login nel terminale) |
| `requiresOpenaiAuth: false`, `allowUnverifiedProvider` attivo | `unverified_provider { provider }`     |
| `requiresOpenaiAuth: false`, opzione spenta                   | `rejected / provider_not_verified`     |
| `account.type` diverso (`amazonBedrock`, tipi futuri)         | `rejected / unsupported_mode`          |
| errore, timeout, risposta incompleta o malformata             | `rejected / read_failed`               |

`provider` è `{ id, name, baseUrl, unofficialBaseUrl }` da `config/read`
(`model_provider` e la sua voce in `model_providers`: `name`, `base_url`).
`unofficialBaseUrl` è vero quando il `base_url` non è un endpoint HTTPS di
`api.openai.com` o `chatgpt.com`, oppure quando un provider diverso da `openai` non ne
dichiara uno; se `config/read` fallisce vale `{ id: "unknown", name: null, baseUrl: null,
unofficialBaseUrl: true }`. Il messaggio di `provider_not_verified` nomina il provider e
spiega come abilitarlo.

**Provider visibile.** `session.provider` riporta il provider dell'ultima lettura, sempre,
anche con `requiresOpenaiAuth: true`. È informativo e non bloccante: serve all'indicatore
"via proxy" (con Headroom: `headroom`, `http://127.0.0.1:8787/v1`,
`unofficialBaseUrl: true`); l'accesso lo decide solo lo stato `auth`.

**Gate.** `session.request()` lascia passare senza verifica solo `account/read`. Ogni
altra richiesta richiede `authorized` o `unverified_provider`, non stale; altrimenti la
Promise viene rifiutata con `CodexAuthError` e **il messaggio non raggiunge il server**.
Per `login_required` il messaggio dice di eseguire `codex login` in un terminale.

**Metodi mai inviati**, in qualsiasi stato (`deniedReason`):

| Metodo                                 | Motivo                                     |
| -------------------------------------- | ------------------------------------------ |
| `account/rateLimitResetCredit/consume` | spende un credito di reset dei rate limit  |
| `account/sendAddCreditsNudgeEmail`     | invia un'e-mail                            |
| `feedback/upload`                      | invia feedback, log e thread a OpenAI      |
| `plugin/share/save`                    | pubblica un plugin ad altre persone        |
| `plugin/share/updateTargets`           | cambia con chi è condiviso un plugin       |
| `account/login/start`, `/cancel`       | il login si fa con il CLI nel terminale    |
| `account/logout`                       | disconnetterebbe il profilo dell'utente    |
| `remoteControl/*`                      | il client non pilota mai il remote control |

`initialize` non dichiara mai la capability `experimentalApi`, che i metodi sperimentali
(remote control compreso) richiedono. Il remote control resta una funzione dell'utente:
nulla viene disattivato nella sua configurazione.

**Cambi di account.** `account/updated` e `account/login/completed` rendono lo stato
_stale_: la richiesta successiva rilegge `account/read`. La notifica da sola può solo
togliere l'autorizzazione (`apikey` → `api_key`, `null` → `login_required`, altro →
`unsupported_mode`; `chatgpt` richiede una rilettura). Una lettura in corsa con un cambio
viene scartata.

**Avvio.** Con un profilo in cui l'utente ha fatto login, Codex annuncia l'account
(`account/updated` con `authMode: "chatgpt"`) **mentre** è in corso la prima
`account/read`, che quindi viene scartata (transcript `personal-startup.jsonl`; misurato a
riposo per 65 s: la notifica arriva una volta sola, a 0,58 s). All'avvio `connectCodex`
rilegge al massimo **3 volte** finché una lettura si completa senza cambi in mezzo; se non
succede, lo stato resta `rejected / read_failed`.

## Ambiente e lancio

- Profilo e configurazione dell'utente: nessun `CODEX_HOME` imposto, nessun override `-c`.
- Ambiente dell'utente meno le sole variabili di chiave: `OPENAI_API_KEY`,
  `CODEX_API_KEY`, `CODEX_ACCESS_TOKEN`, `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`,
  `GEMINI_API_KEY`, `GOOGLE_API_KEY` (in qualsiasi combinazione di maiuscole). Base URL,
  proxy e le variabili di Headroom e rtk passano.
- **Profili isolati di test e registratore**: solo lì un `CODEX_HOME` temporaneo e
  `-c features.plugins=false`, `-c skills.bundled.enabled=false`
  (`dev/isolated-profile.ts`), per avere registrazioni riproducibili e senza rete.

## Comportamenti verificati

Con il fake server: account ChatGPT autorizzato; API key rifiutata anche con un provider
personalizzato e `allowUnverifiedProvider`; `login_required` senza altre chiamate e con il
rimando a `codex login`; Bedrock e tipi sconosciuti rifiutati; provider personalizzato
rifiutato per default con nome e istruzioni, ammesso con l'opzione; provider e base URL
esposti a ogni lettura; annuncio dell'account durante la prima lettura (rilettura) e
limite delle 3 letture; errori e risposte incomplete rifiutati; cambi di account; ambiente con
chiavi tolte e base URL e proxy conservati; lancio senza override; metodi negati mai
inviati.

Con Codex CLI 0.164.0 reale:

- profilo isolato nuovo: `account/read` →
  `{ account: null, requiresOpenaiAuth: true, workspaceRouting: null }`, quindi
  `login_required`; `config/read` → `model_provider: null`, `model_providers: {}`
  (provider `openai`); con un provider personalizzato senza auth OpenAI →
  `requiresOpenaiAuth: false` e il suo `name` in `config/read` (transcript
  `startup.jsonl` e `custom-provider.jsonl`);
- profilo personale dell'utente (diagnosi, [diagnosis.md](diagnosis.md), e transcript
  `personal-startup.jsonl`): ChatGPT Plus, provider `headroom` con
  `requires_openai_auth = true`, quindi `authorized`; `workspaceRouting` è un oggetto
  (`chatgptAccountId`, `backendOrigin`, `accountRoutingOverride`); remote control
  `disabled`, `environmentId: null`.

## Limiti residui

- **Fiducia nel provider.** Con `requires_openai_auth = true` Codex invia il token ChatGPT
  al `base_url` del provider (Headroom, nel caso dell'utente). La verifica si fida di
  quella dichiarazione e del proxy configurato dall'utente.
- **Validità del token.** `account/read` riporta le credenziali salvate, non garantisce
  che il token sia ancora accettato: l'errore emergerà alla prima richiesta reale.
- **Configurazione gestita di sistema** (managed config, requirements): ha la precedenza
  e non è sotto il nostro controllo; un provider imposto così viene comunque rilevato da
  `requiresOpenaiAuth`.
- **Configurazione globale dei processi lanciati da Codex**: `git` per i plugin oggi, i
  comandi durante i turni domani, leggono la configurazione globale dell'utente (per
  esempio `~/.gitconfig` con `http.proxy`, `url.*.insteadOf` o i credential helper).
- **Piano.** Nessuna distinzione fra i piani ChatGPT (`free`, `plus`, `pro`, …).
