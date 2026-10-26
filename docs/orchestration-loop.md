# Ciclo di orchestrazione minimo (D6)

Stato: iterazione 1. Codice: `packages/runtime/src/` (`loop.ts`, `delegation.ts`,
`agent.ts`, `event-log.ts`); agenti: `packages/adapters/src/codex/agent.ts` e
`src/claude/agent.ts`. Test con agenti finti deterministici:
`packages/runtime/test/loop.test.ts`.

## Flusso

1. La richiesta dell'utente va all'**orchestratore** (iterazione 1: Codex), in un thread
   in sola lettura (`sandbox: "read-only"`) nel workspace.
2. L'orchestratore scrive un piano e un **blocco di delega** nel formato fisso imposto
   dalle istruzioni di ruolo del runtime (`ORCHESTRATOR_INSTRUCTIONS`), mai lette da file
   del repository:

   ```text
   <<<DELEGA
   ## Obiettivo
   ## Contesto
   ## Vincoli
   ## Assunzioni
   ## Domande aperte
   ## Output atteso
   DELEGA>>>
   ```

   Le sei sezioni sono obbligatorie, in quest'ordine e non vuote. Senza marcatori la
   risposta è una conclusione e il ciclo termina. La riga di apertura può nominare il
   destinatario, `<<<DELEGA @claude`: un destinatario diverso dal worker rende il blocco
   malformato.

3. Il blocco viene **intercettato**: l'utente lo approva, lo modifica o lo annulla. Nessun
   messaggio arriva a un agente senza approvazione.
4. Il **worker** (iterazione 1: Claude) riceve il testo approvato; la risposta arriva in
   streaming. I turni successivi riprendono la stessa sessione Claude (`--resume`).
5. Il runtime prepara il **messaggio di review** (risultato del worker e richiesta di
   valutazione), anch'esso intercettato. La risposta del worker sta fra le righe
   `<<<RISPOSTA DEL WORKER` e `RISPOSTA DEL WORKER>>>`, con una frase che la indica come
   dato da valutare e non come istruzioni (minaccia T4 in [security.md](security.md)); una
   riga della risposta identica a un delimitatore viene sostituita, così la risposta non
   può chiudere la cornice in anticipo.
6. L'orchestratore valuta: una nuova delega riparte dal punto 3, altrimenti la risposta è
   la conclusione. Al massimo **3 scambi**; al terzo la review chiede di non delegare più e
   un'ulteriore delega chiude con `limit_reached`.

Esiti: `completed`, `limit_reached`, `answered` (modalità domanda), `cancelled` (con il
punto: `delegation`, `review`, `malformed`), `stopped`, `failed`.

## Modalità domanda

`runLoop({ mode: 'question' })`: l'orchestratore riceve istruzioni dedicate
(`questionInstructions`) per formulare **una** domanda al worker, con il destinatario
obbligatorio (`<<<DELEGA @<id>`), senza rispondere da solo. Il blocco è intercettato come
sempre; dopo la risposta del worker il ciclo termina con `answered` (domanda approvata,
risposta, etichetta), senza review. Una sola correzione di un blocco malformato è
ammessa (`canAskOrchestrator` diventa falso); se l'orchestratore risponde senza
delegare, l'esito è `failed`. Nella demo: `pnpm demo --question`.

## Modalità pipeline (benchmark)

`runLoop({ mode: 'pipeline', autoApprove: true })`, per le prove della cartella `sandbox/`
([ADR 0008](decisions/0008-sandbox-mode.md)). Tre turni:

1. il **pianificatore** (`plannerInstructions`) ragiona e scrive una sola specifica completa
   nel blocco di delega, con destinatario obbligatorio, senza codice completo;
2. l'**esecutore** (`EXECUTOR_INSTRUCTIONS`) la segue alla lettera, senza analisi estese,
   scrive i file, esegue i test e risponde con un rapporto fisso (File, Test, Problemi);
3. il pianificatore riceve il rapporto nella cornice da dato (`verdictPrompt`) e risponde solo
   `SUCCESS` o `FAIL`; l'esito è `verdict`, con il verdetto letto da `parseVerdict` (null se
   ambiguo).

Con `autoApprove` i messaggi fra agenti non aspettano l'utente, ma sono intercettati,
registrati e mostrati come decisione `auto_approve`; un blocco malformato riceve una sola
correzione automatica (`auto_fix`), poi il run fallisce. Mai per default.

## Etichette

Ogni risposta nel thread (`message`) porta un'etichetta scritta dal **runtime** da
`AgentTurnResult.identity`, cioè da ciò che l'adapter ha osservato sul protocollo:
provider (con il proxy, per esempio "Codex via Headroom persistent proxy"), modello,
effort e id di sessione o di thread. Il testo dell'agente non può attribuirsi un'altra
identità.

## Regole

- **Delega malformata**: non viene inoltrata. L'errore va nel thread
  (`delegation_invalid`) e l'utente sceglie: chiedere all'orchestratore di correggerla,
  scriverla a mano (poi intercettata come le altre) o annullare.
- **Approvazioni** chieste da un agente (comandi, scritture, rete): rifiutate in
  automatico; nel thread compare "approvazione rifiutata: non supportata in questa
  versione". Per Codex la risposta di protocollo è `decline` (comandi, file),
  nessun permesso concesso (`item/permissions/requestApproval`) o `decline`
  (elicitation MCP); le richieste sconosciute ricevono un errore. Il thread Codex usa
  `approvalsReviewer: "user"`, così le richieste non vanno al revisore automatico di Codex.
- **Stop** in qualsiasi momento: interrompe il turno di Codex (`turn/interrupt`) o termina
  l'albero di processi di Claude, chiude un'attesa dell'utente anche se la sua callback
  ignora il segnale, e chiude le sessioni.
- **Log**: ogni evento (messaggi, intercettazioni, decisioni e modifiche dell'utente,
  approvazioni rifiutate, errori, esito) viene aggiunto a un file JSONL **fuori dal
  workspace**: `openEventLog` rifiuta un percorso relativo o interno al workspace. I delta
  di streaming vanno solo all'interfaccia.

## Indipendenza dai provider

Il runtime conosce solo `AgentFactory`/`AgentSession`/`AgentTurn` (`agent.ts`); gli
adapter ne replicano la forma senza importare il runtime. Quale CLI fa da orchestratore o
da worker, con quale modello e sforzo, è configurazione di chi crea le factory (la demo,
poi l'estensione).

## Limiti

- I turni Codex del fake seguono un turno reale (`question-turn.jsonl`, registrato dalla
  demo con `OOC_CODEX_TRACE` e redatto), confrontato sui campi che il client legge. Il fake
  non emette hook, stati di avvio MCP, uso dei token e rate limit.
- **Sotto-agenti** di ciascun CLI (D13, [subagents.md](subagents.md)): visibili nel thread
  sotto il turno che li crea, con etichetta del runtime, vincolati dalla policy del ruolo
  (`LoopOptions.subagents`) e controllati a posteriori; non sono intercettati.
- La risposta finale di un turno Codex è la concatenazione dei messaggi `agentMessage`
  completati nel turno.
- Le approvazioni non sono ancora mediate: arriveranno con le prossime iterazioni.
