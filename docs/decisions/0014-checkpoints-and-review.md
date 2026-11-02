# 0014. Checkpoint della cartella e revisione delle modifiche

Stato: Accettata (iterazione 3).

## Contesto

- **Dopo un messaggio** l'utente vedeva solo l'elenco dei file cambiati: nessun diff, nessun
  modo di rifiutare un file o di tornare indietro. Delegare a un altro modello senza poter
  controllare e annullare non regge su un progetto vero (ADR 0013, A6 e A7).
- **I CLI hanno i loro checkpoint** (Claude) o nessuno utilizzabile da fuori (Codex in
  app-server); servono uguali per entrambi, e sotto il controllo dell'estensione.

## Decisione

### Checkpoint

- **Prima di ogni messaggio dell'utente** l'estensione registra i file della cartella:
  - ogni contenuto una volta sola, sotto il suo SHA-256, nello storage dell'estensione per quella
    chat (`checkpoints/<chat>/blobs`), scritto in modo atomico;
  - un manifesto percorso → hash per il checkpoint (`checkpoints/<chat>/checkpoints/<id>.json`).
- **Niente git e niente repository ombra:** nessuna dipendenza, nessun `.git` toccato, e lo
  stesso comportamento su ogni cartella.
- **Le stesse esclusioni dei fatti verificati:** `.git`, `node_modules`, `__pycache__`, `.venv`,
  `venv`, `dist`, `out`; al massimo 5000 file.
- **I file oltre 2 MB** non si registrano: se cambiano, la scheda lo dice ("non annullabili") e
  il ripristino non li tocca, né li cancella.
- **Una chat tolta dallo storico** porta via i suoi checkpoint.

### Revisione

- **A fine messaggio, una scheda MODIFICHE:** ogni file con il tipo (aggiunto, modificato,
  tolto) e le righe aggiunte e tolte. Prende il posto dell'elenco semplice dei file cambiati;
  i fatti per il leader restano come prima.
- **Il diff si apre nel diff nativo di VS Code**, fra il contenuto prima e quello dopo il
  messaggio, entrambi registrati: resta il diff di quel messaggio anche se il file cambia poi.
- **ACCETTA** segna il file come visto. **RIFIUTA** lo rimette com'era prima del messaggio; se
  nel frattempo il file è cambiato ancora, chiede conferma.
- **"Ripristina qui"** sul messaggio dell'utente riporta la cartella a prima di quel messaggio,
  dopo una conferma.
- **La conversazione non si ripristina** (ADR 0013): le sessioni dei CLI non si accorciano.
  Invece, con il messaggio successivo il leader e l'implementatore ricevono una nota del
  runtime con i file rimessi com'erano, perché il loro contesto ricorda le modifiche.
- **Rifiuto e ripristino** non partono mentre un messaggio è in corso.

### Sicurezza

- **La webview nomina un file, l'host lo cerca nella scheda registrata:** si tocca solo un
  percorso che il checkpoint ha registrato, e mai fuori dalla cartella (il percorso risolto
  deve restare dentro).
- **I contenuti del diff** si leggono da uno schema in sola lettura
  (`only-one-chat-checkpoint:`), solo per hash validi.

## Conseguenze

- **Non coperti, e detto all'utente:** ciò che un comando fa fuori dalla cartella o nelle
  cartelle escluse, e i file oltre 2 MB.
- **Spazio:** il primo checkpoint di una chat copia i file della cartella; i successivi solo i
  contenuti nuovi.
- **Le note sui file rimessi** si salvano con la chat, per ruolo, finché ciascun ruolo non le
  riceve: sopravvivono alla chiusura di VS Code e tornano con la chat riaperta.
