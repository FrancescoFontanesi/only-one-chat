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
   risposta è una conclusione e il ciclo termina.

3. Il blocco viene **intercettato**: l'utente lo approva, lo modifica o lo annulla. Nessun
   messaggio arriva a un agente senza approvazione.
4. Il **worker** (iterazione 1: Claude) riceve il testo approvato; la risposta arriva in
   streaming. I turni successivi riprendono la stessa sessione Claude (`--resume`).
5. Il runtime prepara il **messaggio di review** (risultato del worker e richiesta di
   valutazione), anch'esso intercettato.
6. L'orchestratore valuta: una nuova delega riparte dal punto 3, altrimenti la risposta è
   la conclusione. Al massimo **3 scambi**; al terzo la review chiede di non delegare più e
   un'ulteriore delega chiude con `limit_reached`.

Esiti: `completed`, `limit_reached`, `cancelled` (con il punto: `delegation`, `review`,
`malformed`), `stopped`, `failed`.

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

- I turni Codex del fake seguono le forme dei sorgenti (`thread.rs`, `turn.rs`,
  `item.rs`, tag `rust-v0.164.0`): nessun turno reale è ancora registrato come fixture.
- La risposta finale di un turno Codex è la concatenazione dei messaggi `agentMessage`
  completati nel turno.
- Le approvazioni non sono ancora mediate: arriveranno con le prossime iterazioni.
