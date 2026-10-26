# Sotto-agenti

Stato: iterazione 1, decisione D13 ([ADR 0007](decisions/0007-subagents-visible-not-intercepted.md)).
Codice: `packages/runtime/src/loop.ts` (policy, etichette, controlli), adapter
`packages/adapters/src/codex/agent.ts` e `src/claude/agent.ts`, `src/claude/turn.ts`.

## Il modello

- **Agenti esterni** (Codex, Claude): parlano fra loro solo con il blocco di delega, che il
  runtime intercetta e l'utente approva, modifica o annulla.
- **Sotto-agenti**: istanze interne dello stesso CLI, create solo su richiesta esplicita.
  Non si approvano, come nell'estensione di Codex, ma sono **sempre visibili** e **vincolati**
  per modello, effort, numero e nome. Codex usa Luna, Claude usa Haiku 5.5, entrambi con effort
  `low` e al massimo 2 contemporanei (configurazione della demo:
  `OOC_CODEX_SUBAGENT_*`, `OOC_CLAUDE_SUBAGENT_*`, `OOC_MAX_SUBAGENTS`).
- Un sotto-agente non deve chiamarsi come un agente esterno o un suo modello, né
  presentarsi come tale. Lo dicono le istruzioni di ruolo e il runtime lo controlla, su
  parole intere e relativamente al provider: per Codex sono vietati `claude`, `haiku`,
  `opus`, `sonnet` e `gemini` (`CODEX_SUBAGENT_FORBIDDEN_NAMES`), per Claude `codex`, `luna`,
  `sol`, `gpt` e `gemini` (`CLAUDE_SUBAGENT_FORBIDDEN_NAMES`). I nomi del proprio provider
  restano validi: `haiku-file-reader` sotto Claude è ammesso, `solution-finder` non contiene
  la parola `sol`.

La policy è configurazione per ruolo (`LoopOptions.subagents`: `model`, `effort`,
`maxConcurrent`, `forbiddenNames`). Il runtime scrive il testo delle regole
(`subagentRules`) e lo passa con la policy alla factory dell'agente; l'adapter la applica con
i meccanismi del suo CLI, senza toccare la configurazione dell'utente.

## Vincoli imposti

**Codex** (override per thread di `thread/start` `config`; chiavi da
`codex-rs/core/config.schema.json` a `rust-v0.164.0`, backend multi-agente v2):

| Chiave                                                        | Valore                                  |
| ------------------------------------------------------------- | --------------------------------------- |
| `agents.default_subagent_model`                               | modello della policy (`gpt-6-luna`)     |
| `agents.default_subagent_reasoning_effort`                    | effort della policy (`low`)             |
| `agents.max_concurrent_threads_per_session` e la stessa in v2 | `maxConcurrent` (2)                     |
| `features.multi_agent_v2.expose_spawn_agent_model_overrides`  | `false`: lo spawn non sceglie modello   |
| `features.multi_agent_v2.multi_agent_mode_hint_text`          | solo su richiesta esplicita             |
| `features.multi_agent_v2.root_agent_usage_hint_text`          | strumenti, `fork_turns: "none"`, regole |
| `features.multi_agent_v2.subagent_usage_hint_text`            | identità interna, regole                |

I due testi di ruolo sostituiscono per intero quelli di Codex (`core/src/session/multi_agents.rs`),
quindi descrivono anche gli strumenti. `MultiAgentV2ConfigToml` rifiuta le chiavi sconosciute:
verificato su un `thread/start` reale, senza turni.

**Claude** (ambiente del solo processo figlio; nomi dalla documentazione e presenti nel
binario 2.1.308): `CLAUDE_CODE_SUBAGENT_MODEL` con `_FORCE=1`, `CLAUDE_CODE_EFFORT_LEVEL`,
`CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH=1`, strumento `Agent` aggiunto a `Read,Grep,Glob` e
`--forward-subagent-text`. I sotto-agenti ereditano gli strumenti del padre e restano in
sola lettura. `CLAUDE_CODE_EFFORT_LEVEL` vale anche per la sessione principale, quindi
l'effort della policy deve coincidere con il suo.

## Monitoraggio

|                    | Codex                                                                        | Claude                                                                                                        |
| ------------------ | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Inizio             | `subAgentActivity` `started` sul thread padre, con modello ed effort risolti | `tool_use` `Agent` (nome da `subagent_type`); il modello arriva con il primo messaggio (`parent_tool_use_id`) |
| Messaggi e comandi | notifiche del thread del sotto-agente sulla stessa connessione               | messaggi con `parent_tool_use_id`                                                                             |
| Fine               | `subAgentActivity` `completed`/`interrupted`, `turn/completed` del figlio    | `tool_result` della chiamata `Agent`                                                                          |
| Stop               | `turn/interrupt` a ogni turno di sotto-agente ancora attivo e al padre       | fine dell'albero di processi                                                                                  |

Ogni sotto-agente diventa un evento del thread (`subagent`), figlio del turno che l'ha
creato, con un'etichetta scritta dal runtime: agente padre, nome, modello, effort e stato.
I suoi testi e comandi arrivano in streaming (`subagent_text`, `subagent_activity`).

**Controllo a posteriori** (`checkSubagent`): modello o effort diversi da quelli imposti,
nome di un agente esterno (parola intera, per esempio `/root/claude_review`) o più
sotto-agenti del massimo: il turno si interrompe con `subagent_violation` e l'esito è
`failed`, con un errore chiaro. Un valore non riportato dal CLI non è una violazione: si
vede come "non riportato" nell'etichetta.

**Attribuzione**: se la conclusione dell'orchestratore nomina un agente esterno (il worker
o un nome vietato) e nel ciclo nessun turno del worker è stato eseguito, il runtime emette
`attribution_warning`, visibile. È un avviso e non blocca: una semplice menzione basta a
farlo scattare.

## Verifica reale (`dev/subagent-check.ts`, un turno per CLI)

- **Claude Code 2.1.308, Haiku, low**: un sotto-agente `haiku-file-reader` (agente
  personalizzato del profilo dell'utente), eseguito su `claude-haiku-5-5`, profondità 1,
  solo `Grep` e `Read`, nessuna violazione. L'effort non compare da nessuna parte nello
  stream né in `result` (`modelUsage`, `subagent_stats`): è imposto, non osservabile. Nello
  stream reale ci sono anche gli eventi `system` `task_started`, `task_progress`,
  `task_updated` e `task_notification`, e `init` elenca lo strumento come `Task`.
  Registrato come `turn-subagent.jsonl`, che il fake riproduce.
- **Codex 0.164.0, Luna, low**, primo turno: creazione fallita con `no rollout found`,
  nessun sotto-agente avviato. `spawn_agent` eredita per default tutta la cronologia del
  padre (`fork_turns: "all"`), che un thread `ephemeral` non conserva su disco. Da allora
  l'istruzione di ruolo chiede `fork_turns: "none"` con il contesto nel compito.
- **Codex, secondo turno** (`subagent-turn.jsonl`): il sotto-agente `/root/env_read` parte,
  con il proprio thread, un comando di lettura e stato `completed`. `subAgentActivity`
  riporta `gpt-6-luna` ed effort `low`, mentre il thread padre ha effort `high` (il
  predefinito del profilo): l'override `default_subagent_reasoning_effort` si applica (nel
  run 2, senza override, l'effort era `medium`). Nessuna violazione.
  `multiAgentMode` nella risposta di `thread/start` resta `explicitRequestOnly` anche con il
  testo guida per thread: il campo non lo riflette. Il comportamento (un sotto-agente, solo
  perché richiesto) è coerente con il testo, ma anche con la modalità predefinita, quindi
  questo turno non dimostra che il testo guida venga applicato.

## Limiti

- Codex: nessuna approvazione prima della partenza, perché il protocollo non ha una
  richiesta per lo spawn. Il controllo arriva quando il sotto-agente è già partito (28 ms
  prima del suo turno nel run 2) e consuma un po' di quota.
- Codex: un ruolo dell'utente (`agents.<nome>.config_file`) potrebbe fissare un altro
  modello; il controllo a posteriori lo intercetta.
- Claude: l'effort dei sotto-agenti non è osservabile.
- Il nome di un agente personalizzato dell'utente diventa il nome del sotto-agente: se
  contenesse come parola intera un nome esterno al suo provider (per esempio un agente
  Claude chiamato `gpt-helper`), il turno verrebbe interrotto.
