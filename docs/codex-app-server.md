# Client Codex App Server

Stato: milestone 1. È implementata la connessione (avvio, handshake, richieste,
notifiche, errori, arresto dell'intero albero di processi), verificata contro Codex CLI
0.164.0 reale. Thread, turni e approvazioni non sono ancora implementati.

Codice: `packages/adapters/src/codex/` (`app-server.ts`, `executable.ts`,
`process-tree.ts`). Test: `packages/adapters/test/`. Registratore di transcript:
`packages/adapters/dev/`.

## Protocollo verificato

| Aspetto                 | Comportamento                                                                                        | Fonte                                                                                                   |
| ----------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Trasporto               | stdio (default di `codex app-server`)                                                                | documentazione ufficiale                                                                                |
| Framing                 | un oggetto JSON per riga, terminato da `\n` (JSONL)                                                  | documentazione ufficiale; `codex-rs/app-server/tests/suite/v2/connection_handling_stdio_tests.rs:72-86` |
| Versione                | forme JSON-RPC 2.0 **senza** il campo `"jsonrpc"`                                                    | documentazione; `codex-rs/app-server-protocol/src/rpc.rs:1-2`                                           |
| ID                      | intero oppure stringa                                                                                | `rpc.rs:17-21`                                                                                          |
| Errore                  | `{ id, error: { code, message, data? } }`                                                            | `rpc.rs:76-88`                                                                                          |
| Handshake               | `initialize { clientInfo: { name, title?, version }, capabilities? }`, poi la notifica `initialized` | documentazione; `protocol/v1.rs:29-41`                                                                  |
| Risposta a `initialize` | `{ userAgent, codexHome, platformFamily, platformOs }`                                               | `protocol/v1.rs:74-84`                                                                                  |
| Prima dell'handshake    | errore "Not initialized"; un secondo `initialize` dà "Already initialized"                           | documentazione                                                                                          |
| Richieste dal server    | il server può inviare richieste (es. `item/permissions/requestApproval`) e attende una risposta      | documentazione                                                                                          |
| stderr                  | va letto: se il pipe si riempie il trasporto si blocca                                               | `connection_handling_stdio_tests.rs:88-96`                                                              |
| Arresto                 | la fine di stdin (EOF) avvia lo spegnimento                                                          | `connection_handling_stdio_tests.rs` (`Shutdown::Eof`)                                                  |
| Cancellazione           | non esiste una cancellazione generica delle richieste                                                | ricerca in `app-server-protocol/src`                                                                    |
| Metodo sconosciuto      | errore `-32600` "Invalid request: unknown variant …", non `-32601`                                   | transcript 0.164.0 (`startup.jsonl`)                                                                    |
| Notifiche               | `emittedAtMs` (ms Unix) accanto a `method` e `params`, non dentro `params`                           | transcript 0.164.0; `protocol/common.rs:2101-2114`                                                      |
| Dopo l'handshake        | notifica non richiesta `remoteControl/status/changed`, prima delle risposte successive               | transcript 0.164.0                                                                                      |
| `userAgent`             | `<clientInfo.name>/<versione Codex> (<os>; <arch>) <terminale> (<name>; <version>)`                  | transcript 0.164.0                                                                                      |

Documentazione ufficiale: <https://developers.openai.com/codex/app-server>, che oggi
reindirizza a <https://learn.chatgpt.com/docs/app-server> (consultata il 2026-10-20).
Sorgenti Codex al commit fissato in [reference-sources.md](reference-sources.md).
usturlab (`packages/core/src/adapters/codex.ts`, `jsonRpc.ts`, `spawn.ts`) è stato letto
solo per capire i problemi pratici (shim npm, stderr). Nessun codice è stato ripreso
(ADR 0002).

## Contratto del client

- **Avvio**: `spawn` senza shell, `windowsHide`, stdin, stdout e stderr in pipe.
  `startAppServer` risolve solo dopo `initialize` riuscito e l'invio di `initialized`. Se
  fallisce, il processo viene arrestato prima del rifiuto.
- **Ogni richiesta termina sempre**, con uno di questi esiti: risultato, errore `rpc`,
  `timeout` (default 60 s), `cancelled` (AbortSignal), `exited` (processo terminato) o
  `closed` (`close()` chiamato).
- **Uscita del processo**: le richieste pendenti vengono rifiutate all'evento `close` del
  processo, cioè dopo la fine di stdout. Così una risposta già scritta non va persa.
  Il messaggio d'errore include la coda di stderr.
- **Righe non valide** (JSON malformato, valori non oggetto, messaggi senza `method` né
  `id`) e **risposte con ID sconosciuto** vengono riportate a `onProtocolError` e
  ignorate: la connessione resta utilizzabile.
- **Risposta invalida per un ID pendente** (né `result` né `error` valido): quella
  richiesta viene rifiutata come `protocol`, invece di restare in attesa fino al timeout.
- **Richieste del server**: le gestisce `onServerRequest`. Senza handler la risposta è
  `-32601`; se l'handler fallisce è `-32603`. Il server non resta mai in attesa.
- **Cancellazione e timeout** agiscono solo localmente, perché il protocollo non ha un
  cancel generico. Una risposta tardiva viene riportata come ID sconosciuto.
- **`close()`** è idempotente e risolve solo quando il processo è uscito **e** il suo
  stdio è chiuso, oppure dopo la pulizia. Ogni passo ha `shutdownTimeoutMs` (default 5 s):
  1. rifiuta le richieste pendenti e chiude stdin (EOF): l'uscita pulita resta la via
     normale;
  2. se Codex non esce, termina l'**albero** mentre il processo è ancora vivo: su Windows
     `taskkill.exe /PID <pid> /T /F` (percorso da `SystemRoot`, senza shell); su POSIX
     `SIGTERM` al process group, poi `SIGKILL` (Codex è avviato in un proprio gruppo);
  3. dopo l'uscita attende la chiusura di stdio. Se i pipe restano aperti, un processo
     avviato da Codex li tiene: su POSIX `SIGKILL` al process group; su Windows cerca i
     processi con `ParentProcessId` uguale al PID di Codex e creati **tra** l'avvio e
     l'uscita di Codex (dopo l'uscita il PID può essere riassegnato), poi
     `taskkill /PID <pid> /T /F` su ciascuno. La ricerca usa `powershell.exe` da
     `SystemRoot` con `-NoProfile -NonInteractive` e solo in questo percorso lento.
- **Segnalazione**: se è stato necessario terminare qualcosa, `onForcedShutdown` riceve
  `{ reason: 'exit-timeout' | 'stdio-open', terminated, errors }`. Un arresto pulito non
  la chiama. Un processo già uscito con stdio chiuso non avvia alcuna ricerca né
  terminazione.
- **Ambiente**: per default `process.env`. Il client non legge e non modifica la
  configurazione né le credenziali di Codex.

## Rilevamento dell'eseguibile

`resolveCodexExecutable({ configuredPath?, env? })`:

- con `configuredPath`: deve essere un percorso assoluto, esistente, che indichi un file
  (eseguibile su POSIX);
- senza: cerca `codex.exe` (Windows) o `codex` (POSIX) nel `PATH`;
- non cerca mai i binari privati inclusi nelle estensioni VS Code;
- su Windows rifiuta `.cmd`, `.bat` e `.ps1`, inclusi gli shim creati da npm, perché si
  possono eseguire solo tramite shell. L'errore indica lo shim trovato e chiede il
  percorso dell'eseguibile nativo.

## Test

- **Fake server** (`test/fixtures/fake-app-server.mjs`): processo Node reale e
  indipendente dal client, che implementa il framing e l'handshake documentati più
  alcuni metodi `test/*`. Scrive con `fs.writeSync`, quindi la frammentazione in chunk e
  la back-pressure dei pipe sono reali.
- **Codex reale** (`test/codex-app-server.real.test.ts`): opt-in, impostando
  `CODEX_EXECUTABLE=<percorso di codex.exe>`. Usa un `CODEX_HOME` temporaneo e non
  effettua chiamate al modello. Segnala con un avviso e uno _skip_ motivato quando la
  versione installata non è fra quelle registrate nelle fixture.
- **Transcript reali** (`test/fixtures/codex/<versione>/*.jsonl`): registrati da
  `dev/record-codex.ts` (`pnpm record:codex`, scenario in `CODEX_RECORD_SCENARIO`), che
  parla il protocollo da solo, senza passare dal client in prova, e avvia Codex con
  `prepareCodexLaunch`, lo stesso lancio di `connectCodex`. Ogni file inizia con una riga
  `meta` (versione, `userAgent`, data, comandi). Solo interazioni senza quota del
  modello. La redaction avviene in memoria prima della scrittura e il file non viene
  scritto se lo scanner trova ancora qualcosa; `test/codex-fixtures.test.ts` ripete il
  controllo su tutte le fixture.
- **Contract test** (`test/codex-contract.test.ts`): i parser e i controlli del client
  sui messaggi reali, e la parità del fake: i messaggi del client registrati vengono
  rigiocati contro il fake e le risposte devono avere la stessa forma, gli stessi codici
  d'errore e lo stesso ordine di quelle reali. Se divergono, si corregge il fake.

## Rate limit

`account/rateLimits/read` (parametri vuoti) non usa quota del modello: legge
`GET /wham/usage` e `GET /wham/rate-limit-reset-credits` (`backend-client/src/client/
rate_limit_resets.rs:73-85`, `app-server/src/request_processors/account_processor.rs:
1150-1190`, tag `rust-v0.164.0`). Senza login risponde `-32600` prima di qualsiasi rete.
Da non usare: `supportsLunaReserve: true` (registra l'esposizione a un esperimento) e
`account/rateLimitResetCredit/consume` (`POST`, consuma un credito di reset).

## Limiti noti

- Gli shim npm su Windows non sono supportati: serve il percorso del `codex.exe` nativo.
  TODO(adapters): valutare la risoluzione dello shim verso il binario nativo del
  pacchetto npm.
- Terminazione dell'albero, limiti residui:
  - Windows, dopo l'uscita di Codex: si trovano solo i figli **diretti** di Codex (con i
    loro sottoalberi). Un nipote il cui genitore intermedio è già uscito non è più
    raggiungibile; se tiene i pipe, il client smette di leggerli (lo segnala in
    `errors`) e il processo resta vivo fino alla chiusura dell'extension host, quando il
    job object di libuv lo termina.
  - La finestra temporale usa i millisecondi osservati da Node: un PID riassegnato e un
    suo figlio creati entrambi nei pochi millisecondi fra l'uscita reale e l'evento
    `exit` passerebbero il controllo.
  - POSIX: un discendente che crea una propria sessione o un proprio gruppo (`setsid`)
    esce dal process group e non viene raggiunto.
- Se un processo nipote eredita stdout e resta vivo, l'evento `close` arriva solo
  quando quel processo esce o quando `close()` lo termina. Nel frattempo le richieste
  pendenti terminano per timeout.
- `startAppServer` passa l'ambiente così com'è. Per usare Codex serve `connectCodex`,
  che toglie le chiavi API e applica la policy dell'account: vedi
  [codex-auth.md](codex-auth.md).
- Nessuna validazione di versione o di schema oltre `userAgent` nella risposta a
  `initialize`.
