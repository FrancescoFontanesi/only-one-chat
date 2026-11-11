# Primitive dell'interfaccia: cosa serve e da dove prendere spunto

Stato: ricognizione del 2026-10-27, prima dell'ADR sulla struttura dei pannelli. Le fonti sono
le funzioni pubbliche delle estensioni di Codex e di Claude Code, e il codice di usturlab
(`references/usturlab`, MIT), letto in sola lettura: si riprendono idee, non codice
([ADR 0002](decisions/0002-reuse-policy.md)).

## Primitive per Only One Chat

| Primitiva                    | Come la fanno gli altri                                                                                                                                                                                                                                                    | Proposta per noi                                                                                                                                                    |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Viste                        | usturlab: un contenitore nella barra laterale con l'elenco delle sessioni, e ogni chat in una scheda dell'editor (`vscode/package.json:34-62`, `chatViewProvider.ts:100-104`)                                                                                              | barra laterale con Chat, Flusso, Ruoli e Quote; la chat può restare anche una scheda                                                                                |
| Allegati                     | usturlab passa i **percorsi** dei file ("Attached files: …"), mentre una selezione piccola (sotto i 4000 caratteri) va inclusa nel testo (`chatViewProvider.ts:830-835`, `workspaceContext.ts:61-91`)                                                                      | percorsi, che il leader fa leggere ai sotto-agenti; la selezione inclusa solo se piccola                                                                            |
| Modello e reasoning          | estensioni ufficiali: selettori nel composer; usturlab: menzioni `@provider/model` ed effort scelto da un router                                                                                                                                                           | selettori per ruolo, modificabili durante la chat. L'effort lo sceglie l'utente (ADR 0010)                                                                          |
| Livelli di autorizzazione    | usturlab: Plan / Edit / Full, più "chiedi prima di ogni passo" (`Composer.tsx:86-202`)                                                                                                                                                                                     | per ruolo, mappati sulle modalità native. Mai una modalità che salti i controlli: il "Full" di usturlab usa `--dangerously-skip-permissions`, che per noi è vietato |
| Approvazioni                 | una scheda bloccante nel thread (Consenti / Sempre / Nega), più un avviso se la scheda non è in primo piano (`Transcript.tsx:170-225`)                                                                                                                                     | uguale. "Sempre" va limitato al comando completo, non al primo token come fa usturlab (`permission.ts:63-83`, threat T5)                                            |
| Messaggi a turno in corso    | Claude li riceve sullo stdin in `stream-json`, Codex con `turn/steer` (`claude.ts:178-189`, `codex.ts:317-330`)                                                                                                                                                            | utile per correggere il leader mentre lavora; da valutare                                                                                                           |
| Indicatore di contesto       | usturlab non ne ha; le estensioni ufficiali sì                                                                                                                                                                                                                             | Claude: l'uso dell'ultimo messaggio dell'assistente rispetto alla finestra del modello; Codex: le notifiche sui token del thread                                    |
| Visualizzazione degli agenti | usturlab, `AgentLanes.tsx`: una corsia per sotto-agente, con stato, attività, durata e il riepilogo "N in parallelo"                                                                                                                                                       | pannello Flusso: Tu → Leader → Implementatore, con i sotto-agenti annidati e chi lavora evidenziato                                                                 |
| Persistenza                  | usturlab: le chat in `globalState` (al massimo 50, con il log degli eventi dell'interfaccia) e una mappa delle sessioni native; ripresa con `--resume` per Claude e `thread/resume` per Codex, che ripiega su `thread/start` (`sessionStore.ts:48-58`, `codex.ts:289-302`) | lo stesso schema, ma nello storage del workspace. Per Codex servono thread non `ephemeral`                                                                          |
| Altro                        | una riga che dice quale provider ha risposto e perché, il riepilogo degli strumenti in una riga, "riprova l'ultimo", lo stato "in corso" nell'elenco delle sessioni                                                                                                        | la riga "Via:" del leader svolge già il primo ruolo                                                                                                                 |

## Le approvazioni di Claude in modalità headless

usturlab usa `--permission-prompt-tool` con un piccolo server MCP su stdio, scritto da loro. Il
server inoltra la richiesta all'estensione attraverso un socket su 127.0.0.1 protetto da un
token casuale, nega se l'estensione non risponde e scade dopo 10 minuti
(`permission/bridge.ts:91-118`, `permission/mcpServer.ts`). Secondo il loro commento, in
`stream-json` la modalità di permesso manuale non chiede niente e degrada senza avvisare
(`mcpServer.ts:4-7`).

Per noi vuol dire due cose:

- **Le approvazioni interattive di Claude richiedono uno strumento MCP di permesso.**
- **Si può fare senza l'SDK MCP.** Basta un server stdio minimo, JSON-RPC, scritto nel
  progetto, così non entra una dipendenza nuova.

La scelta va nell'ADR.

## Cosa non riprendere

| Pratica di usturlab                                                                                                                                           | Perché no                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| Quote di Claude lette dal token OAuth in `.credentials.json`, con una chiamata a un endpoint non documentato (`claudeCredentials.ts`, `claudeUsagePoller.ts`) | per noi è vietato (regola 2) |
| Quote di Codex lette dai file di rollout sotto `$CODEX_HOME/sessions` (`codexUsageReader.ts`)                                                                 | per noi è vietato            |
| "Sempre" con chiave il primo token del comando                                                                                                                | troppo ampio (threat T5)     |

Le nostre fonti delle quote sono tre, e nessuna consuma quota:

- **Codex:** `account/rateLimits/read`.
- **Claude:** il `rate_limit_event` di ogni turno.
- **Antigravity:** `agy -p /quota --output-format json`, a cui `agy` risponde senza turno
  (ADR 0023).
