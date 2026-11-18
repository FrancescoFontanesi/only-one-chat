# Ciclo di orchestrazione minimo (D6)

Stato: iterazione 1. Il runtime ha due modalità, `leader` e `review` ([ADR 0034](decisions/0034-remove-experimental-modes.md)).
Codice: `packages/runtime/src/` (`loop.ts`, `delegation.ts`, `brief.ts`, `agent.ts`,
`event-log.ts`); agenti: `packages/adapters/src/codex/agent.ts` e `src/claude/agent.ts`.
Test con agenti finti deterministici: `packages/runtime/test/loop.test.ts`.

## Le due modalità

`runLoop` richiede l'opzione `mode`, senza default:

- **`leader`**: la richiesta dell'utente va al **leader** (`leaderSession`), che risponde da
  solo oppure delega all'implementatore con un blocco di delega. È il percorso dell'estensione.
- **`review`** (ADR 0033): lavoro che il leader non ha delegato (un messaggio che l'utente ha
  mandato direttamente all'implementatore, o una revisione chiesta al revisore). Richiede
  `workerSession` e `reviewer` in `reviewOf`. Non c'è un turno del leader: il ciclo finisce
  `delegated`, e il leader legge il risultato con il messaggio successivo dell'utente.

Le modalità `loop`, `question`, `pipeline` e `gateway` (con la variante `light`) sono state
tolte dall'ADR 0034: ora non esistono nel runtime.

## Flusso in modalità `leader`

1. La richiesta dell'utente va al **leader**, in un thread in sola lettura
   (`sandbox: "read-only"`) nel workspace. La sessione del leader resta fra una richiesta e
   l'altra e il ciclo non la chiude.
2. Il leader risponde, oppure scrive un **blocco di delega** con marcatori fissi:

   ```text
   <<<DELEGA
   testo libero, non vuoto
   DELEGA>>>
   ```

   La riga di apertura può nominare il destinatario, `<<<DELEGA @claude`; un destinatario
   diverso dal worker rende il blocco malformato. Il corpo non ha più sezioni obbligatorie
   (`DELEGATION_SECTIONS` è stato tolto): è libero, ma non può essere vuoto. Senza marcatori la
   risposta è una conclusione e il ciclo termina.

3. Il blocco viene **intercettato**: l'utente lo approva, lo modifica o lo annulla. Nessun
   messaggio arriva a un agente senza approvazione.
4. L'**implementatore** (worker) riceve il testo approvato; la risposta arriva in streaming.
   I turni successivi riprendono la stessa sessione (`--resume` per Claude).
5. Il runtime prepara il **messaggio di review** (risultato dell'implementatore e richiesta di
   valutazione), anch'esso intercettato. Un revisore (ADR 0029) valuta il rapporto, a meno
   che la revisione sia rinviata. Il rapporto sta fra le righe `<<<RISPOSTA DEL WORKER` e
   `RISPOSTA DEL WORKER>>>`, con una frase che lo indica come dato da valutare e non come
   istruzioni (minaccia T4 in [security.md](security.md)); una riga della risposta identica a un
   delimitatore viene sostituita, così la risposta non può chiudere la cornice in anticipo.
6. Il leader legge il risultato: può delegare ancora (si riparte dal punto 3) oppure
   rispondere all'utente, e il ciclo termina.

**Brief dalla chat di ragionamento.** Un messaggio che è un brief `<<<OOC-BRIEF v1 ...`
(ADR 0018, 0020, [brief-format.md](brief-format.md)) non passa dal ciclo di delega normale:
va all'implementatore con solo le note del leader, e il ciclo finisce con il risultato per quella
chat. Il formato del brief è descritto in [brief-format.md](brief-format.md).

**Limite agli scambi.** Non c'è più l'opzione `maxExchanges` né l'esito `limit_reached`
(tolti dall'ADR 0034).

## Esiti

`completed` (risposta del leader senza delega), `delegated` (lavoro passato all'implementatore
o in attesa della review, in modalità `review`), `result` (rapporto dell'implementatore pronto per
il leader), `cancelled` (con il punto: `delegation`, `review`, `malformed`), `stopped`, `failed`.

## Etichette

Ogni risposta nel thread (`message`) porta un'etichetta scritta dal **runtime** da
`AgentTurnResult.identity`, cioè da ciò che l'adapter ha osservato sul protocollo:
provider (con il proxy, per esempio "Codex via Headroom persistent proxy"), modello,
effort e id di sessione o di thread. Il testo dell'agente non può attribuirsi un'altra
identità.

## Regole

- **Delega malformata**: non viene inoltrata. L'errore va nel thread
  (`delegation_invalid`) e l'utente sceglie: chiedere al leader di correggerla,
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
adapter ne replicano la forma senza importare il runtime. Quale CLI fa da leader, da
implementatore o da revisore, con quale modello e sforzo, è configurazione di chi crea le
factory (l'estensione).

## Limiti

- I turni Codex del fake seguono un turno reale (`question-turn.jsonl`, registrato con
  `OOC_CODEX_TRACE` e redatto, con la demo tolta dall'ADR 0034), confrontato sui campi che il
  client legge. Il fake non emette hook, stati di avvio MCP, uso dei token e rate
  limit.
- **Sotto-agenti** di ciascun CLI (D13, [subagents.md](subagents.md)): visibili nel thread
  sotto il turno che li crea, con etichetta del runtime, vincolati dalla policy del ruolo
  (`LoopOptions.subagents`) e controllati a posteriori; non sono intercettati.
- La risposta finale di un turno Codex è la concatenazione dei messaggi `agentMessage`
  completati nel turno.
- Le approvazioni non sono ancora mediate: arriveranno con le prossime iterazioni.
