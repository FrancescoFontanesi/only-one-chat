# 0017. Handoff dell'implementatore

Stato: Accettata (iterazione 3).

## Contesto

- **La sessione dell'implementatore si riempie** con il lavoro di una chat lunga; aprire una
  chat nuova perde anche il leader e quello che sa.
- **L'utente vuole una sessione nuova che riparta dalla precedente,** con lo stesso modello,
  dalla ghiera accanto al riquadro (ADR 0016). I modelli Claude che usa hanno un loro comando di
  handoff, ma un comando di una configurazione personale non è un'interfaccia del prodotto, e il
  prodotto non dipende dal provider (regola 1).
- **Cambiare modello e reasoning dell'implementatore** a chat aperta si fa già nella stessa
  sessione (ADR 0012); il leader tiene il suo modello per tutta la chat.

## Decisione

- **HANDOFF** (`{ type: 'handoff' }` dalla webview; `ChatSession.handoff()`), solo per
  l'implementatore, solo dopo il suo primo turno e mai mentre un messaggio è in corso:
  1. la sessione attuale scrive un passaggio di consegne in un turno normale, visibile nel thread
     (obiettivo, stato, file toccati, decisioni, problemi aperti, prossimi passi, comandi per
     verificare; nessun file toccato, nessun comando);
  2. la sessione si chiude e si dimentica: la chat non la riprende più, nemmeno se riaperta
     (l'id salvato diventa vuoto); il contesto mostrato torna a zero;
  3. la sessione successiva, con lo stesso provider e modello, parte con il passaggio di consegne
     dopo le sue istruzioni.
- **Senza un passaggio di consegne** (testo vuoto) la sessione resta quella di prima, con un
  errore nel thread.
- Il testo della richiesta è del prodotto, uguale per Codex e Claude.

## Conseguenze

- Un handoff costa un turno dell'implementatore, sull'abbonamento dell'utente come gli altri.
- **Il passaggio di consegne vive in memoria** fino a quando la nuova sessione si apre (al
  messaggio successivo): se la chat si chiude prima, la nuova sessione parte da zero.
  TODO(continuity): salvarlo con la chat, quando la continuità fra sessioni avrà il suo layer
  (ADR 0011).
- L'handoff del leader resta da progettare: il suo modello non cambia nella chat.
