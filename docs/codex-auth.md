# Autenticazione Codex: solo abbonamento ChatGPT

Stato: milestone 1.2. È implementata la verifica dell'account, in modalità fail-closed.
La UI di login, thread e turni non sono ancora implementati.

Codice: `packages/adapters/src/codex/auth.ts` (interpretazione dello stato) e
`session.ts` (profilo, ambiente, gate, login). Test: `test/codex-auth.test.ts`.

## Regola

Il modello si può usare **solo** se Codex risulta autenticato con un account **ChatGPT**
su un provider che usa l'autenticazione OpenAI. API key, gateway a consumo, proxy LLM,
provider personalizzati e fallback verso servizi fatturati a parte sono esclusi. Se lo
stato non è verificabile, il risultato è il rifiuto.

## Contratto

`connectCodex(options)` avvia `codex app-server` nel profilo dedicato, completa
l'handshake e **subito dopo** esegue `account/read`. Prima di questa lettura non viene
inviato nient'altro. Restituisce una sessione il cui stato `auth` è uno dei seguenti:

| Risposta di `account/read`                                                           | Stato                              |
| ------------------------------------------------------------------------------------ | ---------------------------------- |
| `requiresOpenaiAuth: true`, `account.type: "chatgpt"` con `planType`                 | `authorized`                       |
| `requiresOpenaiAuth: true`, `account: null`                                          | `login_required` (nessun fallback) |
| `account.type: "apiKey"`                                                             | `rejected / api_key`               |
| `account.type` diverso (`amazonBedrock`, tipi futuri)                                | `rejected / unsupported_mode`      |
| `requiresOpenaiAuth: false` (provider personalizzato o proxy), con qualsiasi account | `rejected / provider_not_verified` |
| errore, timeout, risposta incompleta o malformata                                    | `rejected / read_failed`           |

**Gate.** `session.request()` lascia passare senza verifica solo `account/read` e
`account/login/cancel`. Ogni altra richiesta, quindi ogni futura inferenza, richiede lo
stato `authorized` e non stale; altrimenti la Promise viene rifiutata con `CodexAuthError`
e **il messaggio non raggiunge il server**. `account/login/start` è accessibile solo da
`startLogin()`.

**Cambi di account.** `account/updated` e `account/login/completed` rendono lo stato
_stale_: la richiesta successiva rilegge `account/read`. La notifica da sola può solo
togliere l'autorizzazione:

- `authMode: "apikey"` → `api_key`;
- `null` → `login_required`;
- un altro valore → `unsupported_mode`;
- `"chatgpt"` → nessun effetto immediato, ma serve una rilettura.

Se un `account/updated` arriva mentre una lettura è in corso, quella lettura viene
scartata, perché potrebbe precedere il cambio.

**Login ufficiali.** `startLogin('chatgpt' | 'chatgptDeviceCode')` invia
`account/login/start { type }` e restituisce `{ loginId, authUrl }` oppure
`{ loginId, verificationUrl, userCode }`. Il tipo deve corrispondere a quello richiesto e
gli URL devono essere `https`. Qualsiasi altro metodo, `apiKey` compreso, viene rifiutato
prima di contattare il server. Aprire il browser e mostrare il codice è compito della
futura UI.

## Profilo dedicato e ambiente

- **`CODEX_HOME` dedicato**: percorso assoluto, creato se manca, mai uguale a
  `~/.codex` né al `CODEX_HOME` dell'ambiente padre. Così il `config.toml` personale
  (per esempio il proxy Headroom), i provider personalizzati e le credenziali esistenti
  non vengono caricati. Il login fatto in questo profilo resta in questo profilo.
- **Override della CLI**, che hanno la precedenza sui file di configurazione:
  - `-c forced_login_method="chatgpt"`: il server rifiuta il login con API key
    (`account_processor.rs:454-461`);
  - `-c model_provider="openai"`: il provider integrato;
  - `-c openai_base_url=""`: una stringa vuota equivale ad assente, quindi si usa
    l'endpoint ufficiale (`core/src/config/mod.rs:3946`).
  - `-c features.plugins=false`: niente plugin. All'avvio, anche senza login, Codex
    sincronizzerebbe il catalogo da `https://github.com/openai/plugins.git` con il `git`
    del `PATH` e chiederebbe i plugin "featured" a `chatgpt.com`. Il profilo dedicato non
    deve scaricare né caricare contenuti che non abbiamo scelto. Fonti al tag
    `rust-v0.164.0`: `core-plugins/src/manager.rs:763`, `manager.rs:1286`,
    `core/src/config/mod.rs:1793`; verificato con il binario reale (nessun processo `git`
    e nessuna richiesta ai plugin all'avvio).
- **Ambiente in allow-list**: passano solo `PATH`, le variabili di sistema di Windows e
  POSIX, `LANG`, `LC_*`, `TZ`, `TERM`, `XDG_*` e `DBUS_SESSION_BUS_ADDRESS`, più
  `CODEX_HOME`. Restano quindi esclusi per costruzione:
  - chiavi: `OPENAI_API_KEY`, `CODEX_API_KEY`, `CODEX_ACCESS_TOKEN`
    (`login/src/auth/manager.rs:954-956`);
  - override di endpoint e di autenticazione: `CODEX_*_OVERRIDE`, `CODEX_AUTHAPI_BASE_URL`,
    `CODEX_OSS_*`, `OPENAI_BASE_URL`, `OPENAI_ORGANIZATION`, `OPENAI_PROJECT`;
  - proxy: `HTTP(S)_PROXY`, `ALL_PROXY`;
  - certificati: `SSL_CERT_*`;
  - chiavi di altri provider.
- Il client **non legge, non copia e non modifica** token o file di credenziali:
  l'autenticazione resta interamente a Codex.

## Comportamenti verificati

Con il fake server: account ChatGPT autorizzato; API key, Bedrock e tipi sconosciuti
rifiutati; account assente → `login_required` senza alcuna altra chiamata; provider
personalizzato rifiutato anche con un account ChatGPT; errore o risposta incompleta → nessuna
autorizzazione; passaggio da ChatGPT ad API key → richieste successive bloccate; notifica
ChatGPT → rilettura; lettura in corsa con un cambio → scartata; ambiente ostile filtrato;
override presenti prima di `app-server`; profilo personale rifiutato; login `chatgpt` e
`chatgptDeviceCode`; URL non https rifiutati; login con API key impossibile.

Mutation test: 14 mutazioni sui controlli di sicurezza, tutte rilevate (vedi il messaggio
di commit di M1.2).

Con Codex reale: test opt-in (`CODEX_EXECUTABLE`), che si aspetta `login_required` in un
profilo nuovo. **Non è stato eseguito**, perché nessun `codex.exe` nativo è installato.

## Limiti residui

- **Validità del token.** `account/read` viene chiamato con `refreshToken: false`: riporta
  le credenziali salvate, non garantisce che il token sia ancora accettato dal backend.
  L'errore emergerà alla prima richiesta reale.
- **Configurazione gestita di sistema.** Le configurazioni amministrate (managed config o
  requirements a livello di sistema) hanno la precedenza sugli override e non sono sotto
  il nostro controllo. Se impongono un provider personalizzato, la verifica lo rileva
  (`provider_not_verified`); un `openai_base_url` imposto in questo modo non è
  rilevabile da `account/read`.
- **Proxy di sistema di Windows.** Le impostazioni proxy di Windows (registro e WinHTTP)
  non passano dalle variabili d'ambiente e il client non può escluderle. Lo stesso vale
  per file `hosts` o DNS manipolati.
- **Archivio delle credenziali.** Dove Codex salva il login del profilo dedicato (file nel
  profilo oppure keyring di sistema) dipende da Codex. Non lo verifichiamo, per non
  leggere le credenziali.
- **Configurazione globale dei processi lanciati da Codex.** Il filtro dell'ambiente
  vale per Codex, non per la configurazione su disco dei programmi che Codex avvia: oggi
  `git` per la sincronizzazione dei plugin (disattivata dall'override), domani i comandi
  eseguiti durante i turni. Questi leggono la configurazione globale dell'utente, per
  esempio `~/.gitconfig` con `http.proxy`, `url.*.insteadOf` o i credential helper.
  Non è sotto il nostro controllo.
- **Proxy aziendali.** Un ambiente che richiede `HTTPS_PROXY` per uscire non funziona:
  oggi le variabili proxy vengono sempre escluse. Serve un opt-in esplicito futuro.
- **Piano.** Non viene fatta alcuna distinzione fra i piani ChatGPT (`free`, `plus`,
  `pro`, …): basta un account `chatgpt`.
