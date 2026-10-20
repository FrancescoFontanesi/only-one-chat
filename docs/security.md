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

## Sicurezza della supply chain (bootstrap)

- Versioni esatte e lockfile (`pnpm install --frozen-lockfile`).
- Script di installazione delle dipendenze bloccati di default da pnpm. Le eccezioni sono
  motivate in `pnpm-workspace.yaml` (oggi nessuno script è approvato).
- GitHub Actions fissate per SHA, `permissions: contents: read`, nessun secret in CI.
- I repository in `references/` non vengono mai installati né eseguiti.
