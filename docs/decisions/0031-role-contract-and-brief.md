# 0031. Il contratto fra i ruoli e la struttura del brief

Stato: Accettata. Precisa l'ADR 0020 (brief e rapporto) e l'ADR 0029 (revisore).

## Contesto

Dalle tre valutazioni dei ruoli (`docs/role-evaluation.md`):

- **I guasti peggiori sono silenziosi:**
  - una revisione vuota è arrivata al leader come se fosse un rapporto;
  - un verdetto "approvato" poteva convivere con criteri non verificati;
  - un rapporto poteva tacere un file cambiato.
- **Il brief è l'artefatto con più leva, e nessuno lo controllava:**
  - un brief del leader conteneva due criteri contraddittori (C6 contro C7), che l'implementatore
    ha risolto in silenzio;
  - lo stesso input ha prodotto in tre esecuzioni tre scelte diverse su un comportamento visibile
    ("n float intero"), dichiarate come scelte minori.
- **Un ingresso ostile è sfuggito a test e revisione:** in T3 un byte nullo nel percorso fa
  cadere il programma con un traceback, e i 46 test nascosti di allora passavano.
- **Una revisione del brief come turno a parte è stata valutata e scartata:** aggiunge turni e
  astrazione. Il concetto resta solo per la valutazione dei modelli.

## Decisione

1. **Il runtime controlla il contratto fra i ruoli, senza modelli**
   (`packages/runtime/src/contract.ts`), e non chiede di nuovo: dice al leader ciò che non torna,
   come fatti del runtime, e lo mostra nel thread.
   - **Rapporto:**
     - ogni criterio `C1…Cn` del brief ha uno stato nella Verifica, intervalli come `C1–C10`
       compresi;
     - l'esito "completato" non convive con un criterio non verificato né con "Bloccato su" pieno;
     - Modifiche nomina tutti i file che il runtime ha visto cambiare;
     - un testo senza rapporto è detto come tale.
   - **Revisione:**
     - copre ogni criterio;
     - un "approvato" con un criterio non verificato, un asse del Giudizio non pulito o un rilievo
       aperto viene tenuto dal runtime come "con riserve", o "respinto" con un asse negativo o un
       bloccante aperto, e il leader legge perché.
   - **Fuori formato:** un testo fuori formato non blocca: ciò che non si legge non si contesta.
2. **Il brief non passa da una revisione a parte.** Lo controllano le due estremità, senza turni
   in più:
   - **il leader**, prima di consegnare, rilegge i criteri insieme e non lascia due criteri
     incompatibili, anche sull'ordine dei controlli; dice quale richiesta prevale quando due
     possono scontrarsi; mette almeno un ingresso ostile fra i casi quando il lavoro riceve
     ingressi dall'esterno; e chiede all'utente, invece di dichiararla minore, ogni scelta che
     cambia il risultato per un ingresso valido o un messaggio che l'utente vedrà;
   - **l'implementatore**, prima di scrivere, confronta i criteri fra loro e con il codice, con
     un ordine fisso quando si scontrano:
     1. Vincoli e istruzioni del repository;
     2. sicurezza;
     3. casi concreti;
     4. prosa;
     5. le sue preferenze.

     Un conflitto che cambia ciò che l'utente vede lo ferma ("bloccato"); gli altri li scioglie
     con quell'ordine e li scrive in Decisioni come "Conflitto nel brief". Prova gli ingressi
     ostili (vuoto, enorme, `..`, percorsi assoluti, separatori dell'altro sistema, byte nullo,
     codifica, collegamenti simbolici), che danno un errore chiaro e mai un'eccezione non gestita,
     e controlla le versioni che il progetto usa prima di usare un'API.
3. **Il rapporto dice due cose in più nella Verifica:** gli ingressi ostili provati e le
   versioni controllate.

## Conseguenze

- **Il leader non deve più fidarsi della forma:** un rapporto o una revisione incompleti arrivano
  con l'elenco di ciò che manca.
- **I conflitti del brief diventano visibili** senza un turno di revisione: o fermano il lavoro,
  o compaiono nelle Decisioni.
- **Il parser legge i formati dei prompt:** un modello che li cambia molto produce segnalazioni
  in più, non blocchi.
- **I test nascosti di `calc-include` hanno gli ingressi ostili:** byte nullo, `..\` con
  backslash, `C:file`, UNC, nomi vuoti; nessuno può finire in un traceback. Sulle cinque
  implementazioni salvate, le due di Sonnet cadono sul byte nullo: sono i casi reali per provare
  il revisore.
