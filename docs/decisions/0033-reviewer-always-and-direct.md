# 0033. Il revisore sempre, anche sul lavoro diretto, e dall'interfaccia

Stato: Accettata. Sostituisce la scelta del momento della revisione dell'ADR 0032 (il rischio
resta un fatto); estende l'ADR 0029.

## Contesto

- **La quarta valutazione** (`docs/role-evaluation.md`, 2026-11-18): da un solo messaggio
  comune, Sol leader, Sonnet implementatore e Haiku (high) revisore hanno superato tutti i test
  nascosti. Haiku ha trovato e fatto correggere due difetti veri che né i test né Hydrogen (high,
  sullo stesso input) hanno visto, per circa l'8% del costo del lavoro.
- **I ruoli servono a dividere il carico:** chi ragiona, chi scrive, chi prova e riferisce. Se un
  modello economico rivede bene e scrive il rapporto per il leader, la revisione può esserci
  sempre e un salto per rischio non serve.
- **Il lavoro che l'utente manda direttamente all'implementatore** arrivava al leader senza
  revisione; e l'utente non poteva chiedere una revisione da sé.

## Decisione

1. **Il revisore rivede ogni lavoro dell'implementatore:** le deleghe del leader e i messaggi
   diretti dell'utente. Il leader legge la revisione al posto del rapporto. Cadono
   `onlyOneChat.reviewer.trigger` e il salto per rischio; la stima del rischio (ADR 0032) resta
   fra i fatti che revisore e leader leggono.
2. **Il runtime ha una modalità `review`:** rivede un lavoro che il leader non ha delegato, con il
   ciclo dei rilievi dell'ADR 0029, senza un turno del leader, e finisce `delegated`. Riceve:
   - il messaggio dell'utente all'implementatore (`direct`), senza controlli del contratto, che
     valgono per un brief;
   - oppure la richiesta dell'utente al revisore (`asked`), sull'ultimo lavoro della chat, con il
     suo brief e il suo rapporto, o su ciò che l'utente indica se non c'è ancora lavoro.
3. **Tutto torna al leader:** la revisione aspetta il prossimo messaggio dell'utente al leader,
   come un rapporto diretto, con la sua origine detta ("una revisione che l'utente ha chiesto
   direttamente al revisore").
4. **Nell'interfaccia:**
   - il revisore è un destinatario del composer, come leader e implementatore (`/rev`);
   - è il terzo ruolo della ghiera, con provider, modello, reasoning e un interruttore
     Acceso/Spento;
   - è il nodo C sulla lavagna di Squad, sotto leader e implementatore: Lavoro e Rilievi con
     l'implementatore, Revisione verso il leader; spento, resta visibile e il rapporto torna a
     legare implementatore e leader;
   - l'interruttore scrive `onlyOneChat.reviewer.enabled` e vale subito, anche nella chat aperta
     (la sessione del revisore dura una revisione).
5. **Default:** revisore acceso, Claude Haiku a reasoning high.

## Conseguenze

- **Più turni per ogni lavoro,** su un modello economico; il tempo cresce (U3: 553 s contro 301 s
  di Sol da solo).
- **Il CLI del revisore si avvia con la chat anche se è spento,** per poterlo accendere dopo; se
  non si trova, la chat parte e il revisore resta spento con un avviso.
- **Il leader non vede subito una revisione chiesta a mano:** la legge con il messaggio
  successivo, senza un turno in più.
- **Da fare:** il revisore nel pannello Attività (monitor) come terzo agente con il suo contesto;
  una prova dal vivo della revisione di un messaggio diretto.
