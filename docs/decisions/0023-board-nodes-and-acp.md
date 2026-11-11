# 0023. Nodi sulla lavagna di Squad e Antigravity tramite ACP

Stato: Accettata (iterazione 3). Estende l'ADR 0022 (qualsiasi provider in qualsiasi ruolo) e
l'ADR 0016 (Squad).

## Contesto

- **Only One Chat riunisce più agenti in una chat.** Oggi la lavagna di Squad ha solo il leader
  e l'implementatore.
- **L'utente vuole aggiungere altri agenti**, per esempio Gemini, e parlarci selezionandoli. La
  delega verso questi agenti verrà dopo.
- **Antigravity (`agy`, 1.5.5) ha un server ACP** (Agent Client Protocol): `agy acp`, JSON-RPC
  2.0 su stdio, un oggetto per riga. Verificato dal vivo:
  - `initialize`, `session/new`, `session/load`, `session/set_model`, `session/set_mode` e
    `session/prompt` funzionano;
  - gli aggiornamenti arrivano come `session/update`: testo, pensiero, chiamate agli strumenti,
    piano;
  - i token del turno sono nel risultato di `session/prompt`;
  - le modalità sono `default` (chiede prima di modifiche e comandi), `accept-edits`, `auto` e
    `plan`;
  - in `default` ogni comando, anche `dir`, arriva come `session/request_permission`, con le
    opzioni `allow_once` e `reject_once`. La lettura con `read_file` non chiede;
  - i modelli si leggono senza turni con `agy models` (`id<TAB>nome`), e l'id contiene già il
    livello (`gemini-3.8-flash-low`, "Gemini 3.8 Flash (Low)");
  - il server ACP non riporta la quota. La riporta `agy -p /quota --output-format json`, che
    dalla 1.1.11 risponde da sé: nessun turno (`num_turns: 0`), nessuna quota, nessuna
    conversazione. Il token del login resta dentro `agy`. I modelli sono divisi in gruppi che
    condividono i limiti ("Gemini Models", "Claude and GPT models"), ognuno con una finestra di
    5 ore e una settimanale (`remaining_fraction`, `reset_time`). Lanciato da Git Bash,
    `/quota` diventa un percorso e `agy` lo prende per un prompt: un turno vero. L'estensione
    lo lancia senza shell.
- **ACP è un protocollo aperto**, parlato anche da altri agenti (Gemini CLI, Zed, adapter per
  modelli locali). Un adapter ACP serve quindi per Antigravity e per i provider futuri.

## Decisione

1. **Adapter ACP generico** (`packages/adapters/src/acp/`):
   - un processo per sessione; la sessione continua fra un turno e l'altro e si riapre con
     `session/load`;
   - il client non offre file system né terminale: l'agente usa i propri strumenti;
   - le istruzioni del ruolo aprono il primo prompt di una sessione nuova, perché ACP non ha un
     prompt di sistema;
   - il trasporto è quello del client di Codex, separato dal suo handshake (`startJsonRpc`).
2. **Antigravity è un provider** della tabella dell'ADR 0022. I permessi seguono la ghiera:
   - **sola lettura:** ogni richiesta di permesso è negata, senza chiedere all'utente. Le
     istruzioni dicono all'agente di leggere con i propri strumenti e di non usare comandi. Senza
     questa frase, dal vivo l'agente ha chiuso il turno senza risposta dopo il primo comando
     negato;
   - **chiede:** modalità `default`; ogni richiesta va all'utente;
   - **auto:** modalità `auto` di Antigravity. Ciò che chiede ancora va all'utente.

   L'ambiente perde le API key (ADR 0006), così l'account resta quello del login. Mai
   `--dangerously-skip-permissions`.

   I livelli di un modello diventano il suo reasoning: `gemini-3.8-flash` con low, medium e
   high, rimessi insieme nell'id che `agy` prende. Un nodo salvato con l'id completo viene
   letto come modello più livello.

3. **Nodi:** agenti in più sulla lavagna, isolati.
   - **Configurazione:** stanno nelle impostazioni del workspace, `onlyOneChat.nodes`, ognuno
     con id, nome, CLI, modello, reasoning e permesso. Il permesso predefinito è sola lettura.
   - **Provider:** qualunque provider della tabella.
   - **Sessione e thread:** ogni nodo ha la sua sessione e il suo thread. Selezionato in Squad
     o sulla ghiera di chi parla, il thread del nodo prende il posto della chat e il composer
     scrive a lui. Sulla ghiera il nodo ha solo modello e reasoning: consegna, permessi e
     handoff sono dei ruoli, e i permessi del nodo si cambiano in Squad.
   - **Isolamento:** il nodo non vede il thread del leader e il leader non vede il suo. Non c'è
     delega, né revisione, né checkpoint dei file. Le modifiche di un nodo che scrive sono
     mostrate come "File cambiati".
   - **Ruoli:** Antigravity per ora è solo un nodo. Come leader o implementatore servirebbero le
     domande e la revisione, che ACP non definisce.
4. **Il thread di un nodo si salva con la chat**, insieme all'id della sua sessione ACP, e si
   riapre con la chat.
5. **L'utilizzo di Antigravity** si legge come quello di Codex: con il comando del CLI, mai da
   file o token.
   - **Quando:** all'apertura della chat, ogni 2 minuti mentre è in vista e dopo ogni turno di
     un nodo su Antigravity; solo se almeno un nodo lo usa.
   - **Versione:** prima si chiede `agy --version`. Sotto la 1.1.11 `/quota` sarebbe un prompt,
     quindi non viene inviato.
   - **Turni:** una risposta con turni non viene presa per l'utilizzo.
   - **Gruppi:** la ghiera mostra il primo gruppo (Gemini); la nota, nel tooltip, li riporta
     tutti.

## Conseguenze

- **Un provider ACP nuovo** è una voce della tabella con l'eseguibile e gli argomenti del suo
  server.
- **Non ancora:**
  - la ghiera dell'utilizzo per il gruppo del modello del nodo (oggi sempre Gemini);
  - le domande dei nodi;
  - la delega dal leader a un nodo (collegamenti sulla lavagna, brief indirizzato al nodo);
  - i checkpoint dei nodi che scrivono.
- **Variabili non rimosse:** `GOOGLE_GENAI_USE_VERTEXAI` e `GOOGLE_APPLICATION_CREDENTIALS`
  restano nell'ambiente. Con il login Google non contano; un utente che le ha impostate per
  altri strumenti potrebbe però far scegliere ad `agy` un'altra autenticazione.
