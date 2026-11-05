# 0018. Ciclo della delega

Stato: Accettata (iterazione 3). Sostituisce in parte l'[ADR 0010](0010-leader-chat-adaptive-delegation.md)
(il leader non scrive più codice) e l'[ADR 0011](0011-panels-roles-approvals-continuity.md)
(i rapporti non si approvano più).

## Contesto

- **La chat del leader serve a ragionare e pianificare.** Il leader produce prompt per
  l'implementatore, che è l'unico a scrivere codice. Se il leader scrive codice, il suo
  contesto si riempie di file e di diff, e non resta solo ragionamento.
- **Le modifiche piccole non hanno bisogno del leader.** L'utente scrive direttamente
  all'implementatore.
- **Le vie del riquadro erano ambigue** ("Decide lui", "Delega", "Fai tu", "Chiedi"). L'utente
  vuole chiedere il prompt a parole, quando la discussione è matura, per esempio "genera il
  prompt per la feature X".
- **Approvare un rapporto non ha senso.** È un fatto da leggere, non un messaggio da
  correggere: modificarlo falserebbe la valutazione del leader.
- **Una sola sintassi per i file.** Nel riquadro `@` indica un file (ADR 0015), mentre il
  marcatore della delega usava `@` per il destinatario.

## Decisione

1. **Il leader non scrive codice.** Il permesso del leader è fisso in sola lettura e non è più
   un'impostazione.
   - **Può eseguire comandi** per cercare e controllare.
     - Con Codex: sandbox `read-only`, e i comandi che chiederebbero di uscirne vengono
       rifiutati senza chiedere (`approvalPolicy: never`).
     - Con Claude: gli strumenti di lettura più Bash. Senza regole che li consentano e con
       `--permission-prompts none`, girano solo i comandi che Claude Code considera di sola
       lettura; tutto il resto è negato.
   - **Per le modifiche piccole** il leader suggerisce di scrivere direttamente
     all'implementatore.
   - **La via "Fai tu" e il comando `/fai` spariscono.**
2. **Niente vie.** Spariscono il rullo delle vie e i comandi `/delega` e `/chiedi`, e con loro
   la riga "Via: …" all'inizio delle risposte del leader. Il leader scrive il blocco di delega
   solo quando l'utente chiede il prompt o il lavoro.
3. **La consegna** (impostazione `approvalMode`, nella ghiera del leader e, quando le ghiere
   non si vedono, nel riquadro) decide cosa succede al blocco.
   - **Automatica:** il brief parte subito. Nel thread resta una scheda "→ Dnn · INVIATA" con
     il brief.
   - **Manuale:** il brief si ferma in una scheda modificabile come testo libero, con Invia e
     Annulla.
     - **La scheda blocca la chat** finché non decidi: è la pausa che la modalità manuale serve
       a introdurre.
     - **La bozza si salva con la chat.** Una chat riaperta la mostra di nuovo, e Invia la manda
       all'implementatore senza un altro turno del leader.
4. **Il brief dalla web app** (`<<<OOC-BRIEF`) parte sempre in automatico, anche con la consegna
   manuale, perché l'utente l'ha già rivisto in ChatGPT.
   - Il leader non lo riscrive. Lo aggiorna al contesto attuale con le sue note, che
     l'implementatore riceve dopo il brief.
5. **Il rapporto non si modifica.** Il rapporto dell'implementatore e i fatti verificati dal
   runtime tornano al leader così come sono.
   - **Dopo una delega** il leader ha un turno di valutazione (impostazione `leaderReview`,
     predefinita `always`). In quel turno non delega di nuovo da solo: propone all'utente il
     passaggio successivo. Il limite di scambi del runtime (3) resta come tetto.
   - **Dopo un messaggio diretto all'implementatore** non c'è un turno del leader: il rapporto
     resta in coda e il leader lo legge con il messaggio successivo dell'utente, come prima.
6. **Il marcatore della delega diventa `<<<DELEGA #implementatore`.** Il runtime accetta ancora
   la forma con `@`, per le sessioni riprese con le istruzioni precedenti.
7. **`@percorso` vale per tutti**: per l'utente, per il leader e per l'implementatore.
   - **Nel thread** un `@percorso` o `@percorso#L10-20` che esiste nella cartella diventa un link
     che apre il file. Fuori dai blocchi di codice, e solo per i percorsi che esistono, così
     `@scope/pacchetto`, `@param` e gli indirizzi email restano testo.
   - **Fra gli agenti** il runtime lo trasforma in un percorso semplice
     (`percorso`, `percorso (righe 10-20)`), perché Codex e Claude lo leggano allo stesso modo.
   - **Un percorso che non esiste** resta testo. La scheda della delega lo segnala, ma l'invio
     non si blocca: un file da creare non esiste ancora.
   - Per i messaggi dell'utente restano gli estratti dell'ADR 0015.
8. **Gli standard sono una guida, non un formato controllato.**
   - **Il brief** è testo libero, con una guida nelle istruzioni del leader: obiettivo, contesto
     con i percorsi in `@`, decisioni con il perché, vincoli e cose da non toccare, passi se
     servono, criteri di accettazione numerati (C1, C2…), comandi di verifica, quando
     fermarsi, margine dell'implementatore.
     - Lo stesso modello va nelle istruzioni del progetto ChatGPT.
   - **Il rapporto** si apre con una sezione `## Status` (`done`, `partial` o `blocked`) e lega
     ogni criterio al test che lo verifica e al suo esito.
   - **L'implementatore ha un manuale nelle sue istruzioni**, uguale per Codex e Claude:
     - riusare prima di scrivere;
     - la modifica più piccola che soddisfa i criteri;
     - prima i test dei criteri;
     - nessuna astrazione per casi che il brief non chiede;
     - niente dipendenze nuove senza che il brief lo dica.
   - **Le skill esterne** (per esempio ponytail, solo per Claude Code) non sono una dipendenza
     del prodotto. L'utente può installarle da sé (regola 7 di AGENTS.md).

## Conseguenze

- **Il leader in sola lettura consuma meno contesto**, ma ogni modifica, anche minima, passa
  dall'implementatore o dall'utente.
- **Con Claude come leader il divieto di scrivere dipende dalla classificazione dei comandi di
  Claude Code.** Con Codex lo garantisce la sandbox del CLI.
  - Su Windows un thread Codex in sola lettura non chiede la sandbox `unelevated` (ADR 0008).
    TODO(security): verificare con il CLI reale che anche lì i comandi restino confinati.
- **La consegna manuale non chiede più di approvare i rapporti.** Chi la usava per leggerli
  prima del leader li trova comunque nel thread.
- **Ogni delega costa anche il turno di valutazione del leader**, salvo `leaderReview: deferred`.
- **I link ai file si calcolano nell'host,** quando un turno si chiude: mentre il testo scorre
  non ci sono link.
- **Nelle chat salvate prima** i prefissi `/fai`, `/delega`, `/chiedi` e le righe "Via:" del
  leader non si mostrano più: restano nel testo salvato, senza effetto.
