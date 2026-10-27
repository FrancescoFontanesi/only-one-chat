# 0011. Pannelli, ruoli, approvazioni e continuità dell'implementatore

Stato: Accettata in parte (iterazione 3).

- Decisi dall'esperimento qui sotto: chi fa le modifiche piccole, la sessione
  dell'implementatore che continua, `@impl` e i rapporti in coda.
- Da ragionare: come gestire il passaggio fra un filone e l'altro.
- Viste, autorizzazioni e persistenza sono la proposta per il pannello. La grafica viene dopo.

## Contesto

- **L'ADR 0010** ha messo al centro la chat con il leader. Il pannello attuale è una sola
  scheda: chat, approvazioni delle deleghe e fatti del runtime.
- **L'utente vuole le primitive delle estensioni di Codex e Claude:**
  - allegati di file;
  - indicatore di contesto;
  - scelta di modello e reasoning;
  - livelli di autorizzazione.
- **Vuole anche altri pannelli:** uno per assegnare i ruoli (estendibile), uno per le quote di
  tutti i modelli collegati, uno con il flusso fra gli agenti e il modello attivo evidenziato.
- **Può parlare direttamente con l'implementatore.**
- **Oggi l'implementatore riparte da zero a ogni delega.** In calc-session, una correzione
  legata al lavoro appena fatto ha fatto rileggere 56k di contesto a una sessione nuova.
- **La ricognizione** è in [ui-primitives.md](../ui-primitives.md): estensioni ufficiali e
  usturlab.

## Decisione

### Viste

- **Un contenitore nella barra laterale** con quattro viste:
  - **Chat:** la conversazione, con le approvazioni e i fatti, come oggi.
  - **Flusso:** Tu → Leader → Implementatore, con i sotto-agenti sotto chi li ha creati. Il
    modello che lavora è evidenziato, e brief e rapporti compaiono quando passano.
  - **Ruoli:** per ogni ruolo CLI, modello, reasoning e livello di autorizzazione. Oggi i
    ruoli sono leader e implementatore; altri (revisore, redattore, esploratore) si aggiungono
    senza cambiare la struttura.
  - **Quote:** 5 ore e settimana per ogni subscription collegata, con l'orario dell'ultima
    lettura.
- **La chat** può aprirsi anche in una scheda dell'editor, come oggi.

### Composer

- **Destinatario:** di default il leader; con `@impl` il messaggio va direttamente
  all'implementatore.
- **Comandi per forzare la via del leader:** `/fai`, `/delega`, `/chiedi`.
- **Allegati:** si passano come **percorsi**. Il leader li fa leggere ai sotto-agenti, e il suo
  contesto non si riempie. Una selezione si include nel testo solo se è piccola.
- **Selettori di modello e reasoning** per il ruolo a cui si scrive. Valgono dal turno
  successivo, senza aprire una nuova sessione: Codex accetta l'effort per singolo turno, e per
  Claude ogni turno è un processo con il suo `--effort`.
- **Indicatore di contesto** della sessione a cui si scrive:
  - Claude: l'uso dell'ultimo messaggio dell'assistente, rispetto alla finestra del modello;
  - Codex: le notifiche sui token del thread.

### Autorizzazioni

- **Tre livelli per ruolo:** sola lettura, chiedi, automatico nella cartella. Corrispondono alle
  modalità native:
  - Codex: `read-only` oppure `workspace-write`, con `approvalPolicy` `on-request`;
  - Claude: lista di strumenti e comandi, più le richieste di permesso.
- **Nessun livello salta i controlli.**
- **Le approvazioni** compaiono come scheda bloccante nel thread: Consenti, Consenti per la
  sessione, Nega. "Per la sessione" vale per il comando completo, mai per il primo token
  (threat T5).
- **Codex:** le richieste arrivano già dal protocollo; oggi le rifiutiamo, d'ora in poi le
  inoltriamo.
- **Claude in modalità headless: un hook `PermissionRequest`**, non uno strumento MCP.
  - **Perché l'hook.** La documentazione di Claude Code lo specifica per intero: cosa riceve e
    cosa deve restituire. Il contratto di `--permission-prompt-tool` invece non è documentato.
  - **Come entra nel turno.** L'hook si passa per ogni turno con `--settings`; le impostazioni
    dell'utente non si toccano.
  - **Cosa fa lo script** (`packages/adapters/hooks/permission-request.mjs`, eseguito dal Node
    dell'editor):
    - chiede all'estensione tramite un ponte su 127.0.0.1, con un token casuale per ogni ruolo;
    - nega se manca il token, se il ponte non risponde o se la risposta non arriva entro 9 minuti.
  - **Il livello "chiede" per Claude:** nessuna `--allowedTools`, quindi ogni modifica e ogni
    comando che chiederebbe permesso passano da te.
  - **Il livello "auto":** valgono la cartella e i comandi ammessi. Il resto, invece di essere
    negato, viene chiesto a te.
  - **"Per la sessione" lo ricorda il ponte:** solo per lo stesso strumento con lo stesso input
    completo (threat T5).
  - **Ciò che l'hook non decide** resta negato (`--permission-prompts none`).
  - **Verificato su Claude 2.1.308, con un turno reale di Haiku:** l'hook viene chiamato,
    l'allow si applica, e il comando parte.
  - **Limite trovato.** Su una cartella con un nome abbreviato 8.3 (per esempio `FRANCE~1`)
    Claude esige un'approvazione manuale che nessun hook può dare. Per questo l'estensione
    espande sempre la cartella nel nome lungo.
  - **Threat model:** T12 in [security.md](../security.md).

### Continuità dell'implementatore

- **Sessione per filone.** Il leader dichiara nel blocco di delega se continua il filone
  precedente o ne apre uno nuovo. Sullo stesso filone l'implementatore riprende la sua
  sessione.
- **Reset della sessione:**
  - su un filone nuovo;
  - quando il contesto supera una soglia (per esempio il 65% della finestra);
  - con "Nuova chat".
- **Mappa del lavoro.** Il rapporto dell'implementatore include una mappa compatta dei file
  e dei simboli toccati. Se la sessione riparte da zero, il runtime la allega al brief
  successivo.
- **I messaggi diretti** (`@impl`) usano la sessione del filone corrente.

### Persistenza (implementata)

- **Per ogni chat, nello storage del workspace dell'estensione:** un file JSON scritto in modo
  atomico (file temporaneo, poi rename). Contiene:
  - gli aggiornamenti del thread, per ridisegnarlo. I frammenti di un turno concluso si
    scartano, perché il testo finale li contiene;
  - gli id delle sessioni native del leader e dell'implementatore.
- **Limiti:** al massimo 50 chat e 3000 aggiornamenti per chat.
- **Alla riapertura del pannello** torna la chat più recente. Quelle precedenti si scelgono
  nell'intestazione, e "Nuova chat" ne apre una vuota. Quello che era in corso o in attesa si
  ridisegna come interrotto.
- **Ripresa delle sessioni native:**
  - Claude: `--resume`.
  - Codex: `thread/resume`, con le stesse regole dell'avvio (cartella, sandbox, policy,
    istruzioni) e `excludeTurns`. Per questo l'estensione apre thread non `ephemeral`, che
    Codex conserva nel suo storico come fa la sua estensione. Il benchmark resta effimero.
  - Se il thread non c'è più, ne parte uno nuovo.
- **Il primo turno dopo una ripresa non riporta il suo consumo.** I CLI riportano i totali della
  sessione, compresi i turni dei processi precedenti, e senza il totale di partenza non si
  ricava quello del singolo turno. I turni successivi sì.
- **Da fare:** i rapporti in coda per il leader non si salvano ancora. Alla riapertura il
  leader non riceve quelli rimasti in sospeso.

### Esito: chi fa le modifiche piccole

Dati in [calc-small](../../sandbox/results/calc-small-2026-10-27-confronto.md): un run per
variante, a effort low.

- **Il leader che fa da sé è la via più cara.** Sol ha letto 180k di contesto per una riga:
  ogni chiamata di strumento rimanda tutta la sua sessione. Delegare gli costa 48k.
- **La stessa sessione dell'implementatore** dimezza il costo di un seguito (−55% su Claude).
- **Il messaggio diretto** è la via più economica e rapida, ma il leader non lo vede.

Decisioni:

- **Il leader delega ogni modifica, anche piccola.** Per un seguito basta un messaggio mirato.
  Fa da sé solo con `/fai`, o se l'implementatore non è disponibile.
- **La sessione dell'implementatore continua per tutta la chat.** Il passaggio fra filoni è da
  ragionare: soglia di contesto, oppure handoff con la mappa del lavoro e le istruzioni di
  ruolo.
- **`@impl`** scrive direttamente all'implementatore.
- **I rapporti che il leader non ha visto** (un messaggio diretto, una revisione rinviata)
  arrivano in coda al messaggio successivo dell'utente, come dati. Costano il loro testo, non un
  turno.
- **La revisione dopo una delega** è un'impostazione (`onlyOneChat.leaderReview`):
  - `always` (predefinita): il leader rivede subito;
  - `deferred`: rivede con il messaggio successivo, con un turno del leader in meno.

### Esperimento: chi fa le modifiche piccole

**Svolgimento:**

1. Il leader delega a Claude un lavoro piccolo e riceve il rapporto.
2. Si chiede una modifica piccola collegata a quel lavoro.

**Cinque varianti per la seconda richiesta,** tutte a reasoning low:

| Variante | Chi riceve la richiesta                   | Chi la esegue | Sessione dell'implementatore |
| -------- | ----------------------------------------- | ------------- | ---------------------------- |
| V1       | il leader                                 | il leader     | —                            |
| V2       | il leader, che scrive un messaggio mirato | Claude        | nuova                        |
| V3       | il leader, che scrive un messaggio mirato | Claude        | la stessa del primo lavoro   |
| V4       | Claude, messaggio diretto                 | Claude        | nuova                        |
| V5       | Claude, messaggio diretto                 | Claude        | la stessa                    |

**Misure:** test nascosti; token e costo per subscription della sola seconda richiesta;
tempo; quanto cresce il contesto del leader.

## Conseguenze

- **Il runtime:**
  - accetta una sessione dell'implementatore esistente, come già quella del leader;
  - ha i messaggi diretti;
  - la delega ha il filone.
- **L'adapter Codex** ha l'effort per singolo turno e i thread persistenti.
- **Il modo sandbox** (ADR 0008) resta il livello "automatico nella cartella", finché le
  approvazioni non sono nel pannello.
