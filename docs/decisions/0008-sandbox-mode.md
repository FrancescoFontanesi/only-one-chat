# 0008. Modalità sandbox: scrittura confinata per le prove locali

Stato: Accettata (iterazione 2)

## Contesto

Finora gli agenti lavorano in sola lettura e le approvazioni sono tutte rifiutate (R9 non è
ancora implementato). La prima prova vera, una demo di scrittura di codice
([sandbox/README.md](../../sandbox/README.md)), richiede che un agente scriva file ed esegua i
test del codice che ha scritto, senza nessuno che approvi a mano ogni passo.

## Decisione

Una **modalità sandbox** esplicita, mai attiva per default, per una cartella di lavoro nuova
e usa e getta (`%LOCALAPPDATA%\only-one-chat\sandbox\<run>`, fuori dal repository e dal
profilo dell'utente):

- **Claude**: `Write`, `Edit` e `Bash` si aggiungono a `Read`, `Grep` e `Glob`, in
  `--permission-mode default`.
  - `--allowedTools` ammette senza chiedere solo `Edit(./**)`, cioè le modifiche dei file
    sotto la cartella di lavoro (anche `Write` è controllato con le regole `Edit`), e Bash
    per i comandi in whitelist (`Bash(python *)`).
  - Tutto il resto che chiederebbe un permesso, come `rm`, `mv`, una modifica fuori dalla
    cartella o un altro programma, viene negato da `--permission-prompts none`. I comandi in
    sola lettura (`ls`, `cat`, un `cd` dentro la cartella) passano in ogni modalità.
  - Restano negati `PowerShell`, notebook, `WebFetch`, `WebSearch` e i server MCP.
  - `init` deve riportare `default`, altrimenti il turno viene fermato.
  - Correzione dopo il primo benchmark: la prima versione usava `acceptEdits`, che approva
    da solo anche `mkdir`, `touch`, `rm`, `rmdir`, `mv`, `cp` e `sed` nella cartella di
    lavoro. Opus ha eseguito così `rm` sul proprio `parser.py`.
- **Codex** resta in sola lettura (`sandbox: "read-only"`): nella demo pianifica e giudica.
- **Approvazione automatica** dei messaggi fra agenti, solo nella modalità benchmark del
  runtime: è dichiarata nelle opzioni, registrata nel log come decisione `auto_approve` e
  visibile nel thread.

## Conseguenze

- **Rischio accettato dall'utente**: Claude esegue codice scritto da un modello sulla
  macchina dell'utente. Su Windows non c'è una sandbox del sistema operativo per i suoi
  processi, e un comando ammesso (`python …`) può fare qualsiasi cosa che può fare Python:
  le regole `Edit` non valgono per i file che uno script apre da sé. La whitelist limita
  _quali_ programmi si avviano, non _cosa_ fanno.
- La modalità vale per prove locali con compiti innocui, come la calcolatrice della demo.
  Non è il modello di permessi del prodotto: le approvazioni mediate di R9 restano da
  progettare.
- Gli hook dell'utente (per esempio rtk) possono riscrivere i comandi Bash: se un comando
  riscritto non corrisponde più alla whitelist viene negato, e la prova lo mostra.
