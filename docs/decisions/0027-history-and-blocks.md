# 0027. Lo storico per chat e la ghiera per blocchi

Stato: Accettata (iterazione 3). Precisa R5 (riprendere una chat), l'ADR 0011 (sessioni dei
ruoli) e l'ADR 0023 (nodi).

## Contesto

- **STORICO non apriva le chat:** il clic arrivava all'host, ma chiudere la chat corrente
  aspettava l'uscita dei suoi CLI, e un errore nella gestione di un messaggio della webview non
  si vedeva.
- **Diviso o unificato?** Con i nodi, la chat ha più conversazioni: quella del leader con
  l'implementatore, e quella di ogni nodo. Bisognava decidere se lo storico va diviso per agente.
- **La ghiera di chi parla elencava ruoli e nodi alla pari**, anche se l'implementatore lavora
  sotto il leader.

## Decisione

1. **Storico unificato:** una voce è una chat intera, con il thread del leader e
   dell'implementatore, i thread dei nodi, gli id delle sessioni dei CLI, i provider, il brief in
   attesa, i rapporti non letti e i checkpoint. Non è diviso per agente: i nodi lavorano accanto
   a un lavoro, non da soli.
2. **Ogni voce dice chi ha lavorato:** il modello del leader (LDR) e quello dell'implementatore
   (IMP), attenuato se non ha mai lavorato, e i nodi a cui si è scritto, con il nome che avevano.
3. **Aprire una chat** la mostra subito, e i CLI della chat lasciata si chiudono in background
   (la chat è già salvata).
   - Le sessioni riprendono solo quando servono: il leader al primo messaggio, l'implementatore
     al primo lavoro, un nodo quando gli si scrive.
   - Una sessione che non si riapre più (cancellata o scaduta nel suo CLI) lascia il posto a una
     nuova, e l'utente viene avvisato che non ricorda la conversazione.
   - Un errore nella gestione di un messaggio della webview diventa un avviso nella chat.
4. **Nodi rimossi dalla lavagna:** il loro thread, in una chat che li aveva, resta leggibile in
   sola lettura; il nodo compare sulla ghiera dopo gli altri e il composer è disattivato.
5. **La ghiera di chi parla è per blocchi.** Sostituita dall'ADR 0028: il gruppo si sceglie con
   un'etichetta, i ruoli sull'anello.

## Conseguenze

- **Rimandato:** raggruppare lo storico per giorno, la ricerca nel titolo, e portare il thread
  di un nodo da una chat vecchia nella chat corrente.
- **Claude:** la sessione si riapre solo al momento del turno (`--resume`), quindi il ripiego su
  una sessione nuova, che scatta alla creazione della sessione, vale per Codex e per i nodi ACP
  ma non ancora per Claude.
