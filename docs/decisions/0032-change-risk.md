# 0032. La stima del rischio di una modifica

Stato: Accettata in parte, sostituita da 0033: il revisore interviene sempre; il rischio resta un
fatto per revisore e leader, il punto 4 (`onlyOneChat.reviewer.trigger`) è caduto.

## Contesto

- **Una revisione costa quanto il lavoro dell'implementatore:** 60-90 secondi e 30-100k token.
  Nelle valutazioni 7 revisioni su lavori veri non hanno trovato nulla.
- **Saltarla senza criterio non va:** in un compito piccolo (`round`) c'era comunque un difetto
  minore vero.
- **La stima deve essere deterministica:** nessun modello, ripetibile, spiegabile.
- **Fonti:**
  - la previsione dei difetti "just-in-time" (Kamei et al.): la dimensione della modifica è il
    segnale più forte, poi la sua dispersione fra file e cartelle;
  - gli strumenti di stima del rischio: punti di decisione aggiunti (complessità ciclomatica),
    file che dipendono da quelli cambiati, parti sensibili, valori limitati a 0..1 e sommati con
    pesi fissi.

## Decisione

1. **`apps/vscode/src/session/risk.ts` stima il livello basso, medio o alto** dal testo dei file
   cambiati, prima e dopo, che il checkpoint del messaggio già registra:
   - **dimensione** (peso 0,30): righe cambiate nei file di codice, in scala logaritmica, piena a
     400;
   - **dispersione** (0,20): il maggiore fra file di codice cambiati (pieno a 10) e cartelle
     (piena a 5);
   - **complessità aggiunta** (0,20): punti di decisione aggiunti (`if`, cicli, `case`, `catch`,
     `&&`, `||`, ternari), pieni a 25;
   - **dipendenti** (0,15): quanti file di codice importano il file cambiato più usato, in scala
     logaritmica, pieni a 20;
   - **senza test** (0,15): più di 20 righe di codice cambiate e nessun test cambiato.

   Sotto 0,25 è basso, da 0,55 è alto.

2. **Due segnali alzano il livello qualunque sia la somma:**
   - codice aggiunto che tocca ciò che un attaccante controlla (file e percorsi, comandi, rete,
     codice o dati non fidati, query composte, credenziali): alto;
   - una segnalazione dei controlli sul diff (ADR 0030): almeno medio.
3. **Il livello è un fatto del runtime**, con i motivi, insieme ai controlli sul diff.
4. **`onlyOneChat.reviewer.trigger`:**
   - `risk`, il default: il revisore interviene solo da medio in su;
   - `always`: interviene sempre.

   Una revisione saltata è detta nei fatti che il leader legge e nel thread. Una modifica che non
   si può stimare (senza checkpoint) si rivede.

## Conseguenze

- **Sui 10 lavori veri delle valutazioni** i cinque di `round` risultano bassi (0,20-0,24) e i
  cinque di `include` alti, perché toccano file e percorsi.
- **Pesi e soglie sono scelte da tarare** su altri progetti: un livello è un motivo per rivedere,
  non un verdetto. Il difetto minore di `round` non sarebbe stato rivisto.
- **Le espressioni lavorano sul testo, non sulla sintassi:** una parola in un commento conta.
- **Da fare:** chiedere la revisione su una singola delega anche quando il rischio è basso.
