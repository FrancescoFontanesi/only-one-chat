# 0004. Client Codex App Server: stdio, niente shell, terminazione garantita

- Stato: Accettata (2026-10-20)

## Contesto

Il primo adapter parla con `codex app-server`. Dettagli del protocollo e fonti sono in
[../codex-app-server.md](../codex-app-server.md).

## Decisione

1. **Trasporto stdio con framing JSONL**, l'unico non sperimentale secondo la
   documentazione. WebSocket e socket Unix sono esclusi.
2. **Nessuna shell.** `spawn` diretto dell'eseguibile nativo. Gli shim `.cmd`, `.bat` e
   `.ps1` vengono rifiutati invece di essere eseguiti tramite `cmd.exe`, per evitare
   problemi di quoting e iniezione (CVE-2024-27980).
3. **Un solo modulo per trasporto e protocollo.** I test li esercitano insieme attraverso
   pipe reali, quindi una separazione non serve.
4. **Terminazione garantita di ogni richiesta**, con le richieste pendenti rifiutate
   all'evento `close` del processo (dopo la fine di stdout) e non all'evento `exit`.
5. **Errori non fatali per righe invalide o ID sconosciuti**, che vengono riportati a
   `onProtocolError`. Fatali sono solo l'uscita del processo e `close()`.
6. **Nessuna nuova dipendenza.** Si usano solo `node:child_process`, `node:readline` e
   `node:fs`.

## Conseguenze

- Su Windows bisogna indicare il `codex.exe` nativo se il CLI è stato installato via npm.
- Lo strato adapter dovrà aggiungere il filtraggio dell'ambiente e il kill dell'albero di
  processi prima di eseguire turni reali.

## Nota (2026-10-25): terminazione dell'albero

Contro Codex 0.164.0 reale, `codex app-server` esce pulito subito dopo l'EOF ma lascia
vivi i processi che ha avviato (allora `git`, per la sincronizzazione dei plugin), che
tengono aperti i suoi pipe. Il contratto di `close()` cambia così:

- `close()` risolve solo quando il processo è uscito **e** il suo stdio è chiuso, oppure
  dopo la pulizia; prima risolveva all'uscita del processo diretto.
- Se Codex non esce entro `shutdownTimeoutMs`, si termina l'albero mentre è vivo
  (Windows `taskkill /T /F`, POSIX process group); se esce ma i pipe restano aperti, si
  terminano i discendenti (Windows: figli per `ParentProcessId` creati tra avvio e
  uscita; POSIX: process group).
- Su POSIX Codex viene avviato `detached`, cioè in un proprio process group; su Windows
  no, per restare nel job object di libuv.
- Ogni terminazione è segnalata con `onForcedShutdown`; restano invariati l'idempotenza
  e l'ordine EOF, uscita pulita, terminazione forzata.

Dettagli e limiti residui in [../codex-app-server.md](../codex-app-server.md).
