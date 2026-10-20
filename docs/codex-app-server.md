# Client Codex App Server

Stato: milestone 1. È implementata la connessione (avvio, handshake, richieste,
notifiche, errori, arresto). Thread, turni e approvazioni non sono ancora implementati.

Codice: `packages/adapters/src/codex/` (`app-server.ts`, `executable.ts`).
Test: `packages/adapters/test/`.

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
- **`close()`** è idempotente. Rifiuta le richieste pendenti, chiude stdin e attende
  l'uscita. Dopo `shutdownTimeoutMs` (default 5 s) invia `SIGTERM`, dopo il doppio
  `SIGKILL`.
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
  effettua chiamate al modello.

## Limiti noti

- Gli shim npm su Windows non sono supportati: serve il percorso del `codex.exe` nativo.
  TODO(adapters): valutare la risoluzione dello shim verso il binario nativo del
  pacchetto npm.
- Il kill forzato termina solo il processo diretto. Su Windows libuv mette i processi
  figli in un job object che li termina quando muore l'extension host, ma i processi
  avviati da Codex non vengono uccisi da `SIGTERM` o `SIGKILL` su POSIX.
  TODO(adapters): kill dell'intero albero di processi quando arriveranno i turni.
- Se un processo nipote eredita stdout e resta vivo, l'evento `close` arriva solo
  quando quel processo esce. Nel frattempo le richieste terminano per timeout.
- `startAppServer` passa l'ambiente così com'è. Per usare Codex servono `connectCodex`
  e il suo ambiente in allow-list: vedi [codex-auth.md](codex-auth.md).
- Nessuna validazione di versione o di schema oltre `userAgent` nella risposta a
  `initialize`.
