# 0035. Le consegne fra i ruoli come strumenti, e il sistema in inglese

Stato: Accettata (2026-11-18), dopo la prova di fattibilità (in fondo). Sostituirà i marcatori
di testo degli ADR 0018, 0029 e 0031 fra agenti dell'estensione.

## Contesto

- **Le consegne fra i ruoli sono blocchi di testo:** `<<<DELEGA`, `<<<RAPPORTO`, `<<<RILIEVI`,
  `<<<REVISIONE`, e dentro parole che il runtime cerca con regex (`completato`, `bloccato`,
  `approvato`, `con riserve`, `verificato`, `parziale`).
- **Si rompono:** in una prova un modello ha scritto i marcatori nella lingua sbagliata; altre
  volte un plurale o un sinonimo ("verificati", "parziale") ha ingannato il contratto. Ogni
  correzione allarga le regex, e tradurre il sistema in inglese le romperebbe tutte insieme.
- **I tre CLI hanno già un canale strutturato:** gli strumenti MCP, con argomenti validati da uno
  schema JSON. E il punto dove agganciarlo c'è già: Claude Code parte con `--strict-mcp-config`,
  Codex accetta la `config` per thread in `thread/start`, ACP ha `mcpServers` in `session/new`.
- **I loro flussi riportano già le chiamate con gli argomenti** (Codex `mcpToolCall`, Claude
  `tool_use`, ACP `tool_call`): il runtime può leggerle dall'adapter, senza un canale fra il
  server e l'estensione.

## Decisione

1. **Ogni consegna è la chiamata di uno strumento** del server MCP `ooc` dell'estensione:
   - il leader: `delegate` (il brief all'implementatore);
   - l'implementatore: `report` (il rapporto, con l'esito e lo stato di ogni criterio);
   - il revisore: `findings` (i rilievi all'implementatore) e `review` (la revisione al leader,
     con il verdetto).

   Ciascun ruolo vede solo i propri strumenti.

2. **Gli schemi tipano ciò che il runtime legge,** il resto resta testo libero:
   - **Valori fissi in inglese:** l'esito (`done`, `partial`, `blocked`), lo stato di un criterio
     (`verified`, `not_verified`, `not_met`), il verdetto (`approved`, `with_reservations`,
     `rejected`) e la gravità di un rilievo.
   - **Elenchi strutturati:** i criteri del brief e i rilievi sono array con un id, non sezioni
     da riconoscere nel testo. I controlli del contratto (ADR 0031) diventano confronti fra campi.
   - **Testo libero, in qualsiasi lingua:** il brief, il rapporto e il testo dei rilievi.

   Gli schemi stanno nel runtime, che è la fonte di verità del protocollo fra i ruoli.

3. **Il server è senza stato e senza effetti:**
   - valida gli argomenti con lo schema; se non sono validi risponde con l'errore, e il modello
     corregge nello stesso turno;
   - se sono validi risponde "ricevuto";
   - non scrive file, non apre connessioni e non parla con l'estensione.

   Il runtime prende la consegna dall'evento della chiamata nel flusso dell'adapter e ne valida
   di nuovo gli argomenti con lo stesso schema, ignorando i campi in più: non tutti i CLI
   riportano l'esito del server (ACP no) e alcuni aggiungono campi propri (Antigravity
   `toolSummary`). Il server è un file autonomo del runtime
   (`packages/runtime/src/handoff-server.ts`, solo moduli di Node), che l'estensione impacchetta
   in `dist/handoff-server.js` e lancia con il Node di VS Code (`ELECTRON_RUN_AS_NODE`):
   nessuna dipendenza nuova. Legge i messaggi spezzando solo su `\n`, non con `readline`, che
   spezza anche su U+2028 e U+2029, lasciati senza escape da JSON (vedi la prova del runtime).

4. **Una consegna per turno:** vale l'ultima chiamata con argomenti validi.
   - **Il leader senza chiamata** ha risposto da sé, come oggi senza blocco. Un turno vuoto e
     senza chiamata non è una risposta (succede quando un comando rifiutato chiude il turno):
     riceve un turno in più, e vale quello che arriva.
   - **L'implementatore o il revisore senza chiamata** ricevono un turno breve che chiede di
     chiamare lo strumento. Se manca ancora, l'implementatore ha il problema di contratto
     `no-report` e il revisore consegna il suo testo come revisione senza verdetto: il leader lo
     valuta come gli altri.
5. **I permessi:**
   - **Strumenti ammessi in automatico:** i quattro strumenti di `ooc` sono gli unici strumenti
     MCP ammessi, e senza chiedere, perché non hanno effetti:
     - in Claude Code con `--mcp-config` (solo `ooc`), insieme a `--strict-mcp-config` e
       `--allowedTools`;
     - in Codex con il server nella `config` del thread e l'approvazione accettata solo per `ooc`;
     - in ACP con la richiesta di permesso accettata solo per `ooc`.
   - **Il resto non cambia:** in Claude Code i connettori claude.ai e gli altri server MCP
     restano esclusi; in Codex i server MCP dell'utente si caricano come oggi (la `config` del
     thread si aggiunge a `~/.codex/config.toml`, non lo sostituisce), e le loro chiamate restano
     rifiutate. Nessuna configurazione globale dei CLI cambia.
6. **I marcatori di testo restano solo verso l'esterno.** Il brief incollato dalla web app di
   ChatGPT (`<<<OOC-BRIEF`) e il risultato che le torna (`<<<OOC-RESULT`) viaggiano per copia e
   incolla, dove uno strumento non arriva. Il leader riceve il brief come testo e lo consegna con
   `delegate`.
7. **Il sistema passa all'inglese,** con la stessa modifica:
   - **Il protocollo:** prompt dei ruoli, nomi e valori degli strumenti, messaggi del runtime.
   - **Quello che l'utente legge:** interfaccia della webview, messaggi dell'estensione e
     impostazioni di `package.json`.
   - **I documenti:** README, docs, ADR e AGENTS.md.
   - **I test** che leggono quei testi.

   L'italiano non resta come seconda lingua: una localizzazione (`vscode.l10n`) si aggiunge
   dopo, se serve. I risultati in `sandbox/results/` restano come sono, come evidenza storica.

8. **Il bench** misura le consegne mancate o invalide per ruolo e modello, al posto dei blocchi
   malformati.
9. **L'ordine:**
   1. una prova di fattibilità: il server, uno strumento, i tre adapter con i CLI finti, poi un
      turno dal vivo per CLI (il turno dal vivo consuma quota: va approvato);
   2. il passaggio del runtime agli strumenti, con i test;
   3. la traduzione, delegata per aree: i prompt prima, perché cambiano con il protocollo.

## Conseguenze

- **Le consegne non dipendono più dalla lingua né dalla forma del testo;** i controlli del
  contratto diventano confronti fra campi, senza regex.
- **Un processo in più per sessione** (il server `ooc`), leggero e senza stato.
- **Un modello che non sa chiamare strumenti MCP** non può avere un ruolo dell'estensione: da
  misurare con il bench sui modelli piccoli (Haiku, Luna, Flash).
- **I risultati del bench con i marcatori** non sono confrontabili per i blocchi malformati con
  quelli nuovi.

## Prova di fattibilità (2026-11-18)

Uno strumento `report` (esito `done`/`partial`/`blocked` e testo), il server `ooc` e un turno
dal vivo per CLI, in sola lettura, con un modello piccolo a reasoning low. Il prompt chiedeva di
chiamarlo prima con `outcome: "completato"`, cioè nella lingua sbagliata.

- **Claude Code (Haiku):** `--mcp-config` con solo `ooc`, `--strict-mcp-config`,
  `--allowedTools mcp__ooc__report`, `--permission-prompts none`. Il server si connette; la
  prima chiamata torna con l'errore dello schema, la seconda (`done`) riesce, nello stesso
  turno. Costo 0,002 $.
- **Codex (Luna):** il server nella `config` del thread (`mcp_servers.ooc.command` e
  `.args`, chiavi puntate) funziona anche in sandbox read-only. Ogni chiamata chiede
  approvazione con `mcpServer/elicitation/request` (`_meta.codex_approval_kind:
"mcp_tool_call"`); si accetta con `{action: "accept", content: {}}` solo se `serverName` è
  `ooc`. L'item `mcpToolCall` porta `arguments` e `result`; con l'errore dello schema finisce
  `failed`, e Luna corregge nello stesso turno.
- **Antigravity (Gemini 3.8 Flash):** il server in `session/new` (`mcpServers`) funziona. La
  chiamata chiede `session/request_permission` (titolo "Run mcp_ooc_report"), da accettare solo
  per `ooc` anche in sola lettura. Il flusso ACP riporta `rawInput` con un campo
  `toolSummary` in più, che il server non riceve, e non riporta il risultato.
- **Alternativa per Codex, non scelta:** i "dynamic tools" di app-server (`thread/start.
dynamicTools`, richiesta `item/tool/call`) funzionano senza processo e senza approvazione, ma
  sono un'API sperimentale (`experimentalApi`). Si tiene MCP per avere un solo meccanismo nei
  tre CLI; i dynamic tools restano la via di riserva se MCP in Codex cambia.

## Prova del runtime (2026-11-18)

Scenario `calc-include` dal vivo, con la richiesta e poi "Procedi.", su tre sistemi:

| Sistema | Leader            | Implementatore | Revisore     | Test nascosti | Consegne                                                            |
| ------- | ----------------- | -------------- | ------------ | ------------- | ------------------------------------------------------------------- |
| V1      | Codex gpt-6.1-sol | Claude Sonnet  | Claude Haiku | 51/51         | `delegate` 1, `report` 2, `findings` 1, `review` 1; nessuna mancata |
| V2      | Claude Sonnet     | Codex sol      | Gemini Flash | 51/51         | `delegate` 2, `report` 2, `review` 2; 2 mancate, recuperate         |
| V3      | Gemini 4 Hydrogen | Claude Haiku   | Codex terra  | 33/51         | nessun `delegate`: il lavoro non parte                              |

Che cosa è emerso, e che cosa è stato corretto:

- **U+2028 e U+2029.** `readline` di Node spezza anche su questi caratteri, che JSON lascia
  senza escape: una `review` di Haiku arrivava al server in pezzi, senza risposta, e Claude
  ripeteva la chiamata ogni 30 minuti. Il server e i lettori JSONL degli adapter
  (`onJsonLines`) ora spezzano solo su `\n`.
- **Antigravity, comando rifiutato.** In sola lettura un comando rifiutato chiude il turno
  senza testo: era la consegna mancata del revisore Flash e il turno vuoto del leader
  Hydrogen. L'adapter ACP ora continua il turno con un avviso fisso (al massimo due volte),
  e il modello passa agli strumenti di lettura.
- **Antigravity, lavoro in background (aperto).** Un sotto-agente (`invoke_subagent`) o un
  timer (`schedule`) chiudono il turno, e l'agente si risveglia da solo più tardi: la
  chiamata a `delegate` arriva dopo la fine del turno e l'adapter la perde. ACP non segnala
  la fine del lavoro risvegliato.
- **Il leader non delega senza il via** (V1 e V3): segue la regola del prompt, come con i
  marcatori. Il copione del bench aggiunge "Procedi.".

## Stato del lavoro e ripresa (2026-11-19)

Questa sezione serve a riprendere il lavoro con un altro agente o provider. Va tolta quando
il punto 9 è chiuso.

### Dove siamo

- **Passo 1 (pulizia, ADR 0034):** fatto, commit `4cc3684`.
- **Passo 2 (runtime sugli strumenti, prompt in inglese):** fatto e verificato, **non ancora
  committato**. È tutto nel working tree: `git status` elenca i file. `pnpm check` passa
  (574 test, 3 saltati) e `pnpm test:e2e` passa (7). Il commit va fatto solo su richiesta
  dell'utente, senza righe `Co-Authored-By` né altre attribuzioni AI.
- **Passo 3 (traduzione in inglese di UI, docs, ADR, AGENTS.md e test):** da fare, dopo il
  commit del passo 2. Va delegato per aree, come dice il punto 9.

### Dove sta il codice del passo 2

- **Runtime:**
  - `packages/runtime/src/handoff-server.ts` (il server) e `handoff-main.ts` (l'entry);
  - `handoff.ts`: schemi, `handoffTools`, `readHandoff` e il rendering in Markdown;
  - `loop.ts`: turni di correzione, compreso il turno vuoto del leader
    (`EMPTY_LEADER_TURN_PROMPT` in `prompts.ts`);
  - `contract.ts`: confronti fra campi.
  - `delegation.ts` e `review.ts` sono stati rimossi.
- **Adapter:**
  - `claude/turn.ts`: `--mcp-config` in linea, `--strict-mcp-config`, `--allowedTools`;
  - `codex/agent.ts`: config del thread e approvazione solo per `ooc`;
  - `acp/agent.ts`: `mcpServers`, permesso solo per `ooc`, continuazione dopo un comando
    rifiutato (`REFUSED_NOTICE`, al massimo 2 volte);
  - `lines.ts`: `onJsonLines`, che spezza le righe solo su `\n`.
- **Fake:** `fake-claude.mjs`, `fake-app-server.mjs` e `fake-agy.mjs` accettano
  `[handoff <tool> <json>]`. In `fake-agy` la parola `MUTO` riproduce il turno vuoto di
  Antigravity dopo un rifiuto.
- **Estensione:** il target esbuild `dist/handoff-server.js`, lanciato con
  `ELECTRON_RUN_AS_NODE`; le schede REPORT, REVIEW e FINDINGS nella webview.
- **Bench:**
  - `sandbox/scenarios/calc-include/systems.json` (V1, V2, V3);
  - `message-and-go.json` (la richiesta, poi "Procedi.");
  - la metrica `handoffs` nel report.

### Risultati in `sandbox/results/` (2026-11-18)

| File (`calc-include-…`)                  | Esito                                                                         |
| ---------------------------------------- | ----------------------------------------------------------------------------- |
| `V1-…T21-02`, `V1-…T21-15`               | 33/51, copione a un messaggio: il leader propone e aspetta il via             |
| `V1-…T21-17`                             | 51/51, ma il revisore bloccato da U+2028 (prima della correzione), interrotto |
| `V1-…T22-51`                             | 51/51, catena completa con un giro di `findings`: il riferimento per V1       |
| `V2-…T21-04`, `V2-…T23-06`               | 51/51: Flash manca la prima consegna, il turno di correzione la recupera      |
| `V3-…T21-11`, `V3-…T21-14`, `V3-…T23-05` | 33/51: Hydrogen non chiama mai `delegate` dentro un turno                     |

La correzione per il comando rifiutato in ACP è arrivata dopo queste corse: è verificata con
`fake-agy` e con una sonda dal vivo, non con una corsa completa del bench.

### Problema aperto: il lavoro in background di Antigravity

**Cosa fa Antigravity.** Verificato con sonde ACP dirette su `agy acp`, modello
`gemini-4-hydrogen-medium`, sessione in sola lettura:

1. La chiamata `invoke_subagent` arriva come `tool_call` e passa subito a `completed`: il
   lancio è asincrono. Il modello spesso chiude il turno subito dopo, con `end_turn` e un
   testo del tipo "Sto esplorando…".
2. Quando il sotto-agente finisce, l'agente si risveglia da solo, senza un nuovo
   `session/prompt`. Arrivano come semplici notifiche `session/update` e
   `session/request_permission`:
   - le sue letture;
   - la chiamata `mcp_ooc_delegate`;
   - il messaggio finale.

   Il changelog di `agy` lo descrive come comportamento voluto.

3. Nessun messaggio segnala la fine del lavoro risvegliato. L'ultima notifica è un
   `usage_update`, che però arriva anche a metà turno.
4. Un prompt che chiede di aspettare i sotto-agenti non basta. Il modello imposta un timer
   (strumento `schedule`, `DurationSeconds: 15`), chiude di nuovo il turno e si risveglia
   allo scadere.
5. A volte il modello non aspetta: chiude i sotto-agenti (`manage_subagents` con
   `kill_all`), legge da sé e chiama `delegate` dentro il turno. Il comportamento non è
   costante: su quattro sonde, tre volte `delegate` è arrivato dopo `end_turn`.
6. `agy acp` non ha opzioni per disattivare i sotto-agenti o il background, e nemmeno
   `--settings`, che esiste solo nella modalità `-p`.

**L'effetto.** `createAcpAgentFactory` chiude il turno quando `session/prompt` risponde.
Gli aggiornamenti che arrivano dopo, senza un turno in corso, sono ignorati
(`onUpdate`: `if (!turn) return`), e un permesso senza turno è annullato
(`permission`: `picked(null)`). La consegna va persa.

**Le opzioni discusse.**

- **A. Turno aperto finché c'è lavoro in background.**
  - Cosa fa: dopo `end_turn`, se nel turno sono partiti `invoke_subagent` o `schedule` non
    chiusi da `manage_subagents` `kill`/`kill_all`, l'adapter resta in ascolto e raccoglie il
    lavoro risvegliato nello stesso turno. Lo chiude dopo un periodo di silenzio, con un
    tetto di circa 10 minuti.
  - Limite: è una stima, non un segnale del CLI. Va scritta nell'ADR e coperta da un
    test con `fake-agy`, che dovrà simulare il risveglio.
- **B. Antigravity escluso dal ruolo di leader per ora,** con un avviso nelle impostazioni.
  Come revisore ha funzionato grazie al turno di correzione; come implementatore non è
  stato provato dal vivo.
- **C. Commit del passo 2 adesso,** e il problema come passo separato.

Raccomandazione: C, poi A. Il problema è un limite dell'adapter Antigravity, non degli
strumenti: con i marcatori il blocco andava perso nello stesso modo. **La scelta spetta
all'utente,** che non l'ha ancora fatta.

### Come verificare e riprodurre

- **Controlli:** `pnpm check` e `pnpm test:e2e`. Prima di `pnpm check`, i nuovi file di
  `sandbox/results/` vanno formattati con `npx prettier --write`: il bench non lo fa e il
  lint fallisce.
- **Una corsa dal vivo:** `pnpm bench --system V1 --scenario calc-include` (oppure V2, V3).
  Consuma quota e va approvata dall'utente.
  - Il riepilogo è nel `.md` del risultato: righe "Test nascosti" e "Consegne (strumenti
    ooc)".
  - Il log completo è in `%LOCALAPPDATA%/only-one-chat/logs/bench-<runId>.jsonl`: eventi
    `activity` di tipo `mcp_tool`/`tool` per le chiamate, `message` per i testi.
- **Una sonda ACP:** uno script Node che avvia `agy acp` e manda `initialize`,
  `session/new` con `mcpServers: [{ name: 'ooc', … }]`, `session/set_model` e
  `session/prompt`. Accetta solo i permessi con titolo `Run mcp_ooc_*` e registra ogni
  notifica con un orario, anche dopo la risposta a `session/prompt`, per uno o due minuti.
  Gli script usati il 2026-11-18 stavano in una cartella temporanea e non vanno cercati.
- **Server di handoff da sorgente:** `node --import <URL file:// di dev/ts-resolve.mjs>
packages/runtime/src/handoff-main.ts`, con gli strumenti in `OOC_HANDOFF_TOOLS` (JSON).
  Su Windows gli import ESM vanno scritti come URL (`file:///F:/Only%20One%20Chat/...`).
