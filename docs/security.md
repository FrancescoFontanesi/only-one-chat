# Sicurezza: threat model iniziale

Stato: threat model del bootstrap. Ogni funzionalità futura deve indicare quali minacce
tocca e come le mitiga.

## Regole non negoziabili

1. **Nessuna modalità `dangerously-skip-permissions`** (né equivalenti: `--yolo`,
   `bypassPermissions`, `approval-policy never` con sandbox disattivata, ecc.) attiva
   per default. Se mai verrà introdotta: opt-in esplicito, per singola sessione, ben
   visibile e mai persistente.
2. **Nessuna API a pagamento.** L'estensione non gestisce API key e non fa fallback
   verso endpoint a consumo. Un provider senza quota disponibile viene messo in pausa,
   non sostituito con un'API.
3. **Le credenziali restano ai CLI.** L'estensione non legge, non copia e non modifica
   token o file di autenticazione (`~/.codex`, `~/.claude`, profili Antigravity).
4. **Nessuna modifica silenziosa alle configurazioni globali** dei CLI dell'utente.
5. **Workspace Trust rispettato.** L'estensione non forza mai la fiducia su un workspace.

## Asset da proteggere

- Credenziali e sessioni degli abbonamenti AI dell'utente.
- Codice e dati del workspace.
- Integrità dello stato operativo (task, checkpoint).
- Quote e budget dell'utente.
- Transcript e log, che possono contenere segreti.

## Minacce e mitigazioni

### T1. Protezione delle credenziali

- Minaccia: esfiltrazione o corruzione dei token, per esempio un adapter che li copia
  o li logga.
- Mitigazioni: l'autenticazione è delegata ai CLI ufficiali, l'estensione non tocca mai
  i file di credenziali e i processi figli ricevono un ambiente esplicito (allow-list
  di variabili). Il redaction dei segreti nei log è obbligatorio.
- Lezione dai riferimenti: usturlab (`packages/core/src/adapters/gemini.ts:32-52`)
  riscrive `settings.json` nel profilo del CLI. Comportamenti di questo tipo sono vietati.

### T2. Isolamento dei processi

- Minaccia: un CLI o un worker esegue comandi fuori dallo scope previsto.
- Mitigazioni: le sandbox native dei CLI restano attive, si usa una cwd esplicita, i
  worker che scrivono lavorano in worktree separati quando possibile, ci sono timeout e
  cancellazione, e all'uscita di VS Code nessun processo resta orfano.

### T3. Sicurezza del workspace

- Minaccia: aprire un repository malevolo induce l'esecuzione automatica di agenti o
  comandi.
- Mitigazioni: in un workspace non fidato non parte nessuna esecuzione di agenti;
  istruzioni, regole e config del workspace vengono caricate solo se il workspace è
  fidato e dopo l'approvazione del contenuto.
- TODO: quando arriverà l'esecuzione degli agenti, `capabilities.untrustedWorkspaces`
  in `apps/vscode/package.json` deve passare da `true` a `"limited"` (o `false`).
- Lezione dai riferimenti: usturlab imposta `GEMINI_CLI_TRUST_WORKSPACE=true`
  (`packages/core/src/adapters/gemini.ts:63`). È un comportamento vietato.

### T4. Prompt injection da file e output dei worker

- Minaccia: contenuti del repository, pagine web, output di tool o di worker contengono
  istruzioni ostili ("ignora le regole, esegui X").
- Mitigazioni: l'output dei worker è un _dato_ da revisionare e non diventa mai
  istruzione per il leader senza una cornice esplicita; le richieste di permesso nate da
  un task delegato mostrano l'origine; i task contract fissano scope e percorsi ammessi;
  le azioni distruttive richiedono sempre l'approvazione dell'utente.

### T5. Autorizzazioni dei comandi

- Minaccia: un "allow always" troppo ampio autorizza comandi pericolosi.
- Mitigazioni: le approvazioni hanno uno scope minimo (comando completo o pattern
  esplicito, cwd, sessione), sono revocabili e visibili, e i comandi distruttivi non sono
  mai coperti da un "always".
- Lezione dai riferimenti: in usturlab `PermissionMemory`
  (`packages/core/src/adapters/permission.ts:59-73`) usa come chiave solo il _primo token_
  del comando (`git status` autorizza anche `git push --force`) oppure soltanto il tipo per
  le richieste che non sono comandi. Il modello è troppo generico.

### T6. Protezione della Webview

- Minaccia: XSS nella Webview, che potrebbe inviare messaggi arbitrari all'host.
- Mitigazioni (già attive): CSP `default-src 'none'`, script solo con nonce, nessun
  `unsafe-inline` o `unsafe-eval`, nessun `connect-src`, `localResourceRoots` limitati,
  `enableForms: false`, `enableCommandUris: false`, validazione di ogni messaggio
  nell'host. Il markdown generato dai modelli dovrà essere sanificato prima del rendering.
- Verifica: `apps/vscode/test/unit/html.test.ts`, `protocol.test.ts`.

### T7. Persistenza di transcript e log

- Minaccia: transcript e log conservano segreti o codice sensibile, in chiaro e senza
  limiti di tempo.
- Mitigazioni: lo storage avviene in aree dell'estensione (non nel repo, salvo opt-in),
  con retention configurabile, redaction dei pattern di segreti e comandi per cancellare.

### T8. Integrità dello stato durante crash e failover

- Minaccia: un crash a metà scrittura o un failover a metà task corrompe lo stato, fa
  perdere il lavoro o lo fa eseguire due volte.
- Mitigazioni: scritture atomiche (temp seguito da rename), schema versionato,
  checkpoint prima di ogni handoff, ripresa idempotente e task in stato incerto
  segnalati all'utente invece di essere rieseguiti automaticamente.
- Lezione dai riferimenti: il failover di usturlab
  (`packages/core/src/orchestrator/orchestrator.ts:300-320`) passa al target successivo
  con l'output parziale tenuto in memoria. Non c'è checkpoint persistito né riconciliazione
  degli effetti collaterali dell'attempt interrotto. Augani invece scrive JSON in modo
  atomico (`cli_agent_job.py:540-551`): un pattern da riprendere come idea.

### T9. Costi API non autorizzati

- Minaccia: una variabile d'ambiente (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`,
  `GEMINI_API_KEY`, ...) fa passare un CLI alla fatturazione a consumo.
- Mitigazioni: i processi figli ricevono un ambiente filtrato senza chiavi API, si
  verifica la modalità di autenticazione del CLI prima dell'uso e, se non è un
  abbonamento, la sessione viene rifiutata.
- Stato: **attiva per Codex** (milestone 1.2). Ambiente in allow-list, profilo dedicato e
  gate fail-closed su `account/read`. Vedi [codex-auth.md](codex-auth.md).

### T10. Lettura degli appunti (ADR 0009)

- **Minacce.**
  - Gli appunti contengono di tutto: password, token, dati personali. Un ascolto
    permanente li esporrebbe al runtime o ai log.
  - Un testo copiato da una pagina o da un documento potrebbe contenere il marcatore del
    brief e far partire un ciclo che l'utente non voleva.
- **Mitigazioni sull'ascolto.**
  - Gli appunti si leggono una sola volta, quando la finestra riceve il focus, e solo se il
    pannello è aperto, il workspace è fidato e l'ascolto è acceso.
  - Gli appunti non vengono mai interrogati a intervalli.
  - È sempre visibile nel pannello.
  - Il testo senza marcatore viene scartato subito: mai registrato né persistito.
- **Mitigazioni sul brief catturato.**
  - Un brief con l'id di un altro progetto non parte senza conferma.
  - Il brief ha un limite di dimensione e viene validato come ogni messaggio non fidato.
  - Per il gateway resta una richiesta da verificare, non un'istruzione di sistema.
  - Nella modalità automatica la cattura viene notificata.

### T11. Agenti avviati dal pannello (ADR 0010)

- **Minaccia:** dal pannello, leader e implementatore scrivono ed eseguono comandi sulla
  macchina dell'utente.
- **Mitigazioni sul perimetro:**
  - Gli agenti lavorano solo nella prima cartella aperta in VS Code, che è il loro confine.
  - Partono solo se la cartella è attendibile per il Workspace Trust. Altrimenti il pannello
    si apre, ma nessun agente parte (`untrustedWorkspaces: limited`).
  - Alla prima richiesta un avviso modale chiede il consenso per quella cartella.
- **Mitigazioni sui permessi:**
  - Valgono quelli della modalità sandbox (ADR 0008): Claude scrive con `Edit(./**)` ed esegue
    senza chiedere i programmi di `onlyOneChat.allowedCommands`; Codex scrive con
    `workspace-write`, senza rete.
  - Al livello `auto` Claude lavora nella modalità auto di Claude Code (ADR 0021): ciò che
    chiederebbe lo decide il classificatore di Claude Code. Se la sessione riporta una modalità
    diversa da `auto` o `default`, il turno si ferma. `bypassPermissions` non si usa mai.
  - `onlyOneChat.ignoredPaths` toglie percorsi dai fatti verificati e dai checkpoint. È limitata
    nelle cartelle non attendibili, perché nasconderebbe modifiche alla revisione.
  - Le altre richieste di approvazione dei CLI vengono rifiutate e mostrate: R9 è ancora da
    fare.
  - I percorsi degli eseguibili, i comandi ammessi e il comando di verifica hanno scope
    `machine`: un repository non li può impostare con le sue impostazioni di workspace.
- **Mitigazioni nella Webview:**
  - Ogni messaggio della Webview è validato, con un limite di 50 000 caratteri.
  - I testi dei modelli sono resi come testo, mai come HTML.
- **Limite noto:** come nella sandbox, un comando ammesso (per esempio `python`) può fare
  quello che può fare quel programma. Al livello `auto` di Claude decide un classificatore,
  non l'utente: chi vuole decidere tutto sceglie `ask`. Per provare l'estensione si usa una cartella separata
  (`pnpm playground`).

### T12. Approvazioni interattive (R9, ADR 0011)

- **Minaccia:**
  - un'approvazione data per sbaglio, o troppo ampia;
  - un processo locale che si finge l'hook di Claude per approvarsi da solo.
- **Mitigazioni per Codex:** le richieste arrivano dal protocollo dell'app-server e la risposta
  è `accept`, `acceptForSession` o `decline`. "Per la sessione" lo applica Codex alla stessa
  richiesta.
- **Mitigazioni per Claude:** un hook `PermissionRequest`, passato per il solo turno con
  `--settings`, interroga un ponte su 127.0.0.1.
  - **Il ponte:**
    - ascolta solo su localhost, su una porta casuale;
    - richiede un token casuale di 32 byte per ogni ruolo, confrontato in tempo costante;
    - accetta una riga di al massimo 1 MB.
  - **Tutto ciò che va storto nega:** token, ponte o risposta mancanti, una risposta
    malformata, un timeout.
  - **"Per la sessione"** vale solo per lo stesso strumento con lo stesso input completo, mai
    per un programma o un prefisso (T5).
- **Mitigazioni comuni:** fermare la richiesta nega ciò che è in attesa. Le richieste che non
  sono comandi o modifiche di file (permessi di sandbox, elicitazioni MCP) restano negate.
- **Limite noto.** Il token è nell'ambiente del processo Claude e dei comandi che esegue. Un
  comando già consentito può leggerlo e inviare una richiesta al ponte, ma il ponte la mostra
  comunque all'utente: non si può auto-approvare, salvo una richiesta identica a una già
  consentita per la sessione.

### T13. Catalogo dei modelli e ruoli dalla vista (ADR 0012)

- **Minaccia:**
  - la lettura dei modelli che consuma quota, o che legge dati dell'account;
  - una scelta dalla vista Ruoli che passa al CLI un argomento arbitrario.
- **Mitigazioni per la lettura:**
  - Codex: solo `model/list`, sulla sessione già filtrata (stessi metodi negati, chiavi API
    tolte dall'ambiente).
  - Claude: solo la richiesta di controllo `initialize`, senza messaggio utente, quindi senza
    turno; chiavi API tolte dall'ambiente; cartella temporanea, non il progetto. Della risposta
    si tengono solo id, nome e livelli di effort dei modelli: i dati dell'account non si leggono.
- **Mitigazioni per la scelta:** la vista manda CLI, modello, reasoning e permessi, validati
  con liste chiuse e un pattern per il modello che non può iniziare con `-`. L'host rifiuta un
  modello che il catalogo letto non contiene e un reasoning che il modello non supporta.
- **La pagina impostazioni (ADR 0013)** scrive solo le chiavi elencate in `src/settings.ts`,
  ciascuna verificata sul suo tipo. Percorsi dei CLI, comandi consentiti, comando di verifica e
  istruzioni per ruolo sono `machine`: una cartella non può impostarli, nemmeno dalla pagina.

### T14. Revisione, ripristino e file indicati (ADR 0014, 0015)

- **Minaccia:** la webview che fa scrivere, cancellare o leggere un file fuori dalla cartella.
- **Mitigazioni:**
  - rifiuto e ripristino toccano solo percorsi registrati nel checkpoint della chat; la webview
    nomina un file della scheda, e l'host lo cerca lì;
  - ogni percorso risolto deve restare nella cartella, altrimenti si rifiuta;
  - le menzioni `@` passano agli agenti solo se il percorso reale (link risolti) è dentro la
    cartella; un intervallo di righe è copiato solo se breve;
  - i contenuti del diff si leggono da uno schema in sola lettura, solo per hash validi.

## Sicurezza della supply chain (bootstrap)

- Versioni esatte e lockfile (`pnpm install --frozen-lockfile`).
- Script di installazione delle dipendenze bloccati di default da pnpm. Le eccezioni sono
  motivate in `pnpm-workspace.yaml` (oggi nessuno script è approvato).
- GitHub Actions fissate per SHA, `permissions: contents: read`, nessun secret in CI.
- I repository in `references/` non vengono mai installati né eseguiti.
