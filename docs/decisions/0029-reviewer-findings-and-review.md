# 0029. Il revisore: rilievi e rapporto di revisione

Stato: Accettata. Prompt, runtime ed estensione (impostazioni e thread) sono fatti; il revisore
non sta ancora sulla lavagna di Squad. Precisa l'ADR 0020 (brief e rapporto) ed estende l'ADR
0018 (ciclo della delega).

## Contesto

- **Chi scrive il codice scrive anche la prova che funziona.** Il rapporto dell'implementatore è
  una dichiarazione: il leader lo confronta con i fatti del runtime, ma senza un comando di
  verifica configurato i fatti sono solo l'elenco dei file cambiati.
- **Il leader non deve rileggere il codice.** Il suo contesto è fatto di ragionamento e decisioni
  (ADR 0018): gli servono un giudizio già provato e i riferimenti ai file cambiati, non il diff.
- **Un giudizio imparziale chiede un terzo modello,** su un provider scelto dall'utente, che non
  ha scritto né il brief né il codice.
- **Nella prima valutazione dei ruoli** una coppia ha omesso "Bloccato su": la sezione era
  descritta come facoltativa ("solo se l'esito non è completato").

## Decisione

1. **Un terzo prompt di ruolo,** `packages/runtime/prompts/reviewer.md`, caricato come gli altri
   due (`REVIEWER_ROLE_INSTRUCTIONS`). Il revisore:
   - riceve dal runtime il brief così come l'ha ricevuto l'implementatore, il rapporto, i fatti
     verificati e i giri di correzione rimasti; non vede la conversazione fra utente e leader;
   - esegue comandi e scrive test, ma non modifica mai il codice che verifica: le correzioni
     restano all'implementatore, il revisore le suggerisce (vedi "Il revisore scrive test");
   - parte dal brief prima di aprire le modifiche, poi legge le modifiche, riesegue le verifiche e
     prova i casi che i test non coprono.
2. **Un rilievo vale solo con la sua prova:** un comando o un test con atteso e ottenuto, oppure
   il punto esatto e l'ingresso che lo rompe. Cita ciò che viola (un criterio, un vincolo, una
   regola del repository), ha un numero stabile (R1, R2…) ed è `bloccante` o `minore`. Un sospetto
   senza prova va in "Non verificato"; un brief che ammette due letture è un'ambiguità per il
   leader, non un rilievo.
3. **Due blocchi, uno per turno,** che il runtime riconosce dalle righe di apertura e chiusura
   (`packages/runtime/src/review.ts`) e instrada senza interpretarne il contenuto:
   - `<<<RILIEVI` … `RILIEVI>>>` va all'implementatore, il blocco soltanto. Il revisore lo scrive
     solo se c'è almeno un bloccante e restano giri.
   - `<<<REVISIONE` … `REVISIONE>>>` va al leader e chiude la revisione, con le sezioni Verdetto
     (`approvato`, `con riserve`, `respinto`), Criteri, Modifiche, Rilievi, Decisioni, Sul brief,
     Non verificato.
   - Una risposta senza un blocco completo, o dei rilievi scritti quando i giri sono finiti,
     chiude la revisione e arriva al leader così com'è: ciò che il revisore ha trovato non si
     perde. Se scrive entrambi i blocchi vale il rapporto.
4. **Il ciclo nel runtime** (modalità `leader`, opzione `reviewer` di `runLoop`):
   - dopo il rapporto dell'implementatore il runtime apre una sessione del revisore per quella
     delega e la chiude a fine ciclo: il suo contesto contiene solo quel brief;
   - un rapporto con esito `bloccato` non si rivede e va al leader come prima; `completato`,
     `parziale` o senza esito leggibile si rivedono;
   - i giri di correzione sono 2 per default e 3 al massimo (`reviewRounds`). A ogni giro
     l'implementatore riceve i rilievi come dato, risponde con il rapporto aggiornato, il runtime
     ricalcola i fatti e il revisore riguarda;
   - i messaggi fra revisore e implementatore passano senza fermarsi dall'utente, come i rapporti
     (ADR 0018), mostrati e registrati uno per uno;
   - alla fine il runtime registra l'evento `reviewed` (revisore, implementatore, verdetto, giri)
     e il leader riceve il rapporto di revisione al posto di quello dell'implementatore, con i
     fatti. Con la revisione differita (`review: 'deferred'`) lo riceve con il messaggio
     successivo dell'utente.
5. **Lo scambio non diventa una discussione.** L'implementatore riproduce la prova prima di
   correggere, e risponde a ogni rilievo: corretto, contestato con il brief, non corretto. Il
   revisore ricontrolla solo i rilievi aperti e ciò che la correzione ha toccato, e non ripropone
   lo stesso rilievo: un disaccordo resta aperto e sale al leader con le due posizioni.
6. **Il rapporto dell'implementatore (ADR 0020) cambia così:**
   - tutte le sezioni ci sono sempre, e quella vuota dice "nessuno";
   - l'Esito ha una definizione: `completato` solo se ogni criterio è verificato da un comando
     eseguito nel turno;
   - Modifiche lega ogni file al suo criterio ed elenca anche i test;
   - Verifica dà uno stato per criterio e dichiara i test nuovi visti fallire prima della
     modifica e i test esistenti modificati, saltati o rimossi;
   - dopo dei rilievi il rapporto si riscrive per intero, perché vale l'ultimo, con una sezione
     "Rilievi" dopo l'Esito.
7. **Il brief (ADR 0020) cambia così:**
   - ogni criterio è un comportamento osservabile, con i casi concreti "ingresso → risultato
     atteso" dove conta un valore; ciò che non si sa verificare torna all'utente come decisione;
   - un brief chiede un solo risultato; un'interfaccia concordata si scrive per esteso; i comandi
     di verifica sono quelli del repository;
   - lo legge anche il revisore, quindi ciò che non dice non si può pretendere dopo.
8. **L'implementatore esegue i test nuovi prima del codice** e li vede fallire: un test nuovo che
   passa già non prova la modifica.

## Conseguenze

- **Il leader riceve riferimenti e prove, non codice:** i file cambiati con il loro criterio e,
  per ogni criterio, il comando eseguito dal revisore.
- **Costa un secondo modello per ogni brief rivisto,** più un turno dell'implementatore per ogni
  giro di rilievi. Il revisore è facoltativo: senza l'opzione il ciclo è quello di prima.
- **Un brief sbagliato inganna implementatore e revisore insieme:** il revisore prova che il
  lavoro rispetta il brief, non che il brief sia giusto.
- **L'evento `reviewed` è il primo dato dello storico per ruolo e modello** (verdetto e giri per
  ogni lavoro): vedi [la direzione](../roadmap.md).
- **Nell'estensione** il revisore si sceglie nella pagina delle impostazioni:
  - fra i ruoli, come terza voce, provider, modello e reasoning: Codex, Claude o Antigravity,
    perché al revisore non servono le domande all'utente;
  - nella sezione "Revisore" si accende (`onlyOneChat.reviewer.enabled`, spento per default) e
    si fissano i giri (`reviewer.rounds`); le sue istruzioni stanno con quelle degli altri ruoli;
  - vale dalla chat successiva. Un modello che il suo CLI non offre lascia la chat senza
    revisore, con un avviso.
- **Il revisore scrive test, il codice no** (decisione dell'utente dopo la terza valutazione,
  che aveva perso un difetto vero perché il revisore in sola lettura non poteva provarlo):
  - lavora nella cartella del progetto con i permessi nativi del suo CLI, come l'implementatore;
  - prima di ogni suo turno il runtime registra la cartella con un checkpoint, e dopo rimette
    com'era ogni file che non è un test (`apps/vscode/src/session/guard.ts`); lo dice al leader e
    all'implementatore;
  - i test che scrive restano: sono la prova dei suoi rilievi, e l'implementatore li deve far
    passare correggendo il codice, non togliendoli;
  - se la cartella non si può registrare (troppi file), il revisore torna in sola lettura e lo
    sa dal primo prompt;
  - le scritture sul codice si annullano dopo il turno, non si bloccano durante: un blocco
    varrebbe solo per gli strumenti di modifica di Claude (un comando di shell scrive comunque),
    e sarebbe un livello di permessi in più. Scelta confermata dall'utente.
- **Nel thread** i suoi turni hanno il nome REVISORE; i rilievi e il rapporto di revisione sono
  schede come quella del rapporto, la seconda con il verdetto. A revisione finita un avviso dice
  verdetto e giri. Della sua sessione non si tiene nulla da riprendere: dura una delega.

- **Il revisore giudica tre assi oltre ai criteri** (terza valutazione in
  `docs/role-evaluation.md`): onestà (non bara), sicurezza (vince sulla funzionalità),
  aggiornamento (le versioni che il progetto usa davvero). Il rapporto ha una sezione "Giudizio"
  con una riga per asse, e un asse dubbio impedisce l'approvazione. Per questo conviene un modello
  capace, non il più economico: con questo prompt Haiku, Terra e Hydrogen trovano un difetto
  inserito, mentre Luna in una prova precedente non lo trovava.
- **Un revisore Antigravity in sola lettura non può eseguire comandi:** la sessione rifiuta ogni
  permesso e, dopo un rifiuto, chiude il turno senza testo. Quando il revisore resta in sola
  lettura il runtime glielo dice nel primo prompt (`NO_COMMANDS_NOTE`); una revisione vuota non
  vale come approvazione (`EMPTY_REVIEW`) e l'adapter ACP trasforma un turno vuoto con un motivo
  di fine anomalo in errore.
- **Quando interviene:** secondo il rischio stimato dal runtime (ADR 0032).

Da fare. TODO(reviewer):

- il revisore sulla lavagna di Squad e nel monitor degli agenti, che oggi mostrano i due ruoli
  della ghiera;
- provare con i CLI veri il revisore che scrive test, su ciascun provider, e il ciclo dei
  rilievi su un difetto vero (il byte nullo di `calc-include`);
- la qualificazione dei revisori su difetti inseriti (una prova per difetto, quattro modelli).
