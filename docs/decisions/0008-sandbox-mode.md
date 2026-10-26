# 0008. Modalità sandbox: scrittura confinata per le prove locali

Stato: Accettata (iterazione 2)

## Contesto

Finora gli agenti lavorano in sola lettura e le approvazioni sono tutte rifiutate (R9 non è
ancora implementato). La prima prova vera, una demo di scrittura di codice
(cartella `sandbox/` del repository), richiede che un agente scriva file ed esegua i
test del codice che ha scritto, senza nessuno che approvi a mano ogni passo.

## Decisione

Una **modalità sandbox** esplicita, mai attiva per default, per una cartella di lavoro nuova
e usa e getta (`%LOCALAPPDATA%\only-one-chat\sandbox\<run>`, fuori dal repository e dal
profilo dell'utente):

- **Claude**: `Write`, `Edit` e `Bash` si aggiungono a `Read`, `Grep` e `Glob`.
  - `--permission-mode acceptEdits` accetta senza chiedere le modifiche dei file **solo
    nella cartella di lavoro**.
  - `--allowedTools` ammette Bash soltanto per i comandi in whitelist (`Bash(python *)`).
    Ogni altro comando chiederebbe un permesso, e `--permission-prompts none` lo nega.
  - Restano negati `PowerShell`, notebook, `WebFetch`, `WebSearch` e i server MCP.
  - `init` deve riportare `acceptEdits`, altrimenti il turno viene fermato.
- **Codex** resta in sola lettura (`sandbox: "read-only"`): nella demo pianifica e giudica.
- **Approvazione automatica** dei messaggi fra agenti, solo nella modalità benchmark del
  runtime: è dichiarata nelle opzioni, registrata nel log come decisione `auto_approve` e
  visibile nel thread.

## Conseguenze

- **Rischio accettato dall'utente**: Claude esegue codice scritto da un modello sulla
  macchina dell'utente. Su Windows non c'è una sandbox del sistema operativo per i suoi
  processi, e un comando ammesso (`python …`) può fare qualsiasi cosa che può fare Python.
  La whitelist limita _quali_ programmi si avviano, non _cosa_ fanno.
- La modalità vale per prove locali con compiti innocui, come la calcolatrice della demo.
  Non è il modello di permessi del prodotto: le approvazioni mediate di R9 restano da
  progettare.
- Gli hook dell'utente (per esempio rtk) possono riscrivere i comandi Bash: se un comando
  riscritto non corrisponde più alla whitelist viene negato, e la prova lo mostra.
