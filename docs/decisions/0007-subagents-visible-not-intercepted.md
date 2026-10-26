# 0007. D13: sotto-agenti visibili e vincolati, non intercettati

Stato: Accettata (iterazione 1)

## Contesto

Nel secondo run della demo Codex ha creato un proprio sotto-agente, `/root/claude_review`,
con effort `medium` invece di `low`, e ne ha presentato la risposta come "la verifica di
Claude", senza che Claude venisse eseguito. Spegnere i sotto-agenti nativi evita il caso,
ma toglie ai due CLI uno strumento utile. Inoltre Codex non permette di approvarli prima
che partano: il protocollo app-server non ha una richiesta per lo spawn
([subagents.md](../subagents.md)).

## Decisione

- I messaggi **tra agenti** (Codex e Claude) passano solo dal blocco di delega e restano
  **intercettati e modificabili** dall'utente.
- I messaggi **interni** fra un agente e i suoi sotto-agenti non sono intercettati, ma sono
  **sempre visibili** nel thread, sotto il turno che li ha creati, e **vincolati** per
  modello, effort, numero e nome da una policy per ruolo, che è configurazione.
- I vincoli si applicano senza toccare la configurazione dell'utente: override per thread
  per Codex, ambiente del processo figlio per Claude. Il runtime li controlla a posteriori e
  interrompe il turno a ogni violazione.
- L'identità di chi ha risposto la scrive il runtime (etichette), non il modello; un testo
  che attribuisce lavoro a un agente esterno non eseguito produce un avviso visibile.

## Conseguenze

- Un sotto-agente non conforme può partire e consumare un po' di quota prima di essere
  fermato: il controllo è a posteriori.
- Gli adapter devono riportare i sotto-agenti come eventi (`onSubagent`) e lo stop deve
  raggiungerli; il runtime resta indipendente dai provider.
- I limiti noti e la verifica reale sono in [subagents.md](../subagents.md). Sui thread
  `ephemeral` un sotto-agente di Codex può partire solo senza ereditare la cronologia
  (`fork_turns: "none"`), verificato su un turno reale.
