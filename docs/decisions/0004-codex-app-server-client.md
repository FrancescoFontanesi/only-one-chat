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
