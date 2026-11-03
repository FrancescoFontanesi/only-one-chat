# 0012. Disposizione della chat, viste laterali, catalogo dei modelli

Stato: Accettata (iterazione 3). Sostituisce la parte "Viste" dell'ADR 0011 e i selettori di
reasoning nell'intestazione.

## Contesto

- **L'intestazione della chat aveva tutto:** ruoli, reasoning, cartella, approvazioni, storico.
  Le estensioni di Codex e Claude invece mettono in alto solo il titolo della conversazione, la
  nuova chat e lo storico, e in basso il riquadro di scrittura con i suoi comandi.
- **I modelli erano stringhe fisse** nelle impostazioni, senza sapere quali offre ogni CLI né
  quali livelli di reasoning supporta ciascun modello (Sol arriva a `ultra`, Haiku 4.5 non ne ha).
- **Il pannello dell'utilizzo** aveva una scheda per subscription, con note e contatori della
  chat: troppo per un'occhiata.
- **Mancava un riscontro in tempo reale** di chi sta lavorando e di cosa passa fra gli agenti.

## Decisione

### Chat

- **In alto:** il titolo della conversazione, lo stato, STORICO (l'elenco delle chat della
  cartella) e + NUOVA.
- **In basso:** il riquadro di scrittura e, sotto il divisore, le impostazioni del messaggio:
  - destinatario, LEADER o IMPLEMENTATORE (equivale a `@impl`);
  - la via chiesta al leader: decide lui, delega, fai tu, chiedi prima (equivalgono a `/delega`,
    `/fai`, `/chiedi`, che restano validi se scritti);
  - come passano i messaggi fra gli agenti: approvo io, automatiche;
  - il modello di chi riceve, INVIA e FERMA.
- **Invio** invia, **Maiusc+Invio** va a capo, come nelle estensioni ufficiali.

### Viste laterali, nel contenitore Only One Chat

- **Ruoli:** per ogni ruolo il modello, scelto fra quelli che i CLI offrono, raggruppati per
  provider; il reasoning fra quelli del modello; i permessi. I ruoli sono estendibili (revisore,
  redattore) senza cambiare la struttura.
- **Attività:** ogni ruolo con modello, stato (lavora, aspetta te, fermo), l'ultima attività e i
  sotto-agenti attivi; sotto, il registro degli eventi, il più recente in alto. Per ora è
  semplice: serve a capire cosa succede. Altre funzioni si decideranno.
- **Utilizzo:** una tabella, provider, 5h, 1w, con barre. Ora e note nei tooltip.

### Catalogo dei modelli

- **Letto dai CLI, senza turni e senza quota:**
  - Codex: `model/list` sull'app-server, tutte le pagine, solo i modelli non nascosti.
  - Claude Code: la richiesta di controllo `initialize` dello stream-json, con `-p` e nessun
    messaggio utente, poi stdin si chiude. Verificato su 2.1.308: risponde con i modelli e i
    livelli di effort, ed esce con codice 0 senza fare un turno.
- **Solo i campi dei modelli.** La stessa risposta di Claude contiene dati dell'account, che non
  si leggono né si conservano (security.md, T13).
- **Claude parte in una cartella temporanea**, lontano dalle impostazioni del progetto.
- **Una lettura per finestra**, poi su richiesta (pulsante della vista Ruoli).

### Ruoli durante la chat

- **Le impostazioni restano la fonte:** la vista Ruoli le scrive dove sono definite (cartella o
  utente), e la chat aperta le riceve.
- **Stesso provider, dal turno successivo del ruolo, nella stessa sessione:**
  - modello e reasoning: Codex li accetta per turno (`turn/start`), e per Claude ogni turno è un
    processo con `--model` e `--effort`;
  - permessi: la sessione del CLI si riapre con le nuove regole (`thread/resume`, `--resume`), con
    il suo contesto.
- **Il modello del leader resta quello di inizio chat** (decisione dell'utente, 2026-11-02):
  senza un handoff del leader, che dipende dal layer di memoria, la sua conversazione non cambia
  modello. Reasoning e permessi restano modificabili; il nuovo modello vale dalla chat
  successiva.
- **Un altro provider vale dalla chat successiva.** Una chat tiene i provider con cui è nata,
  anche riaperta dallo storico. Spostare il lavoro su un altro provider a chat avviata è un
  handoff: richiede un contesto condiviso (punto da cui riprendere, storico del progetto), che
  l'utente sta progettando a parte. Da decidere insieme.

## Conseguenze

- **Adapter:** `listCodexModels`, `listClaudeModels`, `setModel` sulle sessioni Codex e Claude.
- **I CLI finti** rispondono a `model/list` e a `initialize`.
- **La cronologia** salva i ruoli di ogni chat.
- **I contatori per chat** escono dalla vista Utilizzo; il consumo di ogni turno resta nella sua
  scheda.
