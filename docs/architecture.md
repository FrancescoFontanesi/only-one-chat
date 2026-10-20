# Architettura prevista

Stato: confini e responsabilità previsti. Le API interne **non sono ancora definite**. Le
fisseremo soltanto dopo aver verificato i protocolli reali dei CLI (vedi
[requirements.md](requirements.md), "Questioni aperte").

## Componenti e confini

```text
┌──────────────────────── VS Code ────────────────────────┐
│                                                         │
│  Webview (browser sandbox, Preact)                      │
│    rendering del thread, input, approvazioni            │
│        ▲  postMessage (protocollo tipizzato e validato) │
│        ▼                                                │
│  Extension host (apps/vscode)                           │
│    comandi, pannello, diff, workspace trust,            │
│    storage, UI delle approvazioni                       │
│        │  API TypeScript in-process                     │
│        ▼                                                │
│  Orchestration runtime (packages/runtime)   [no vscode] │
│    thread, leader, task, deleghe, scheduling,           │
│    quote, failover, stato persistente                   │
│        │                                                │
│        ▼                                                │
│  Provider adapters (packages/adapters)      [no vscode] │
│    processi figli dei CLI ufficiali, stdio              │
└────────┬────────────────────────────────────────────────┘
         ▼
   codex / claude / agy  (CLI ufficiali, auth dell'utente)
         │
         ▼
   strumenti esterni opzionali (MCP, Graft, Basic Memory, ...)
```

### Webview

- Codice in `apps/vscode/webview/`, bundle in `dist/webview/main.js`.
- Non ha accesso a Node, al filesystem, alla rete né ai CLI. Comunica soltanto via
  `postMessage`.
- CSP restrittiva con nonce. Nessuna risorsa remota. `localResourceRoots` limitati a
  `dist/webview` e `media`.
- È considerata **non fidata** dall'host: ogni messaggio in arrivo viene validato
  (`parseWebviewMessage`) e i campi sconosciuti vengono scartati.

### Extension host

- Codice in `apps/vscode/src/`. È l'unico componente che importa `vscode`.
- Fa da adattatore fra VS Code e il runtime: registra i comandi, gestisce il pannello,
  apre i diff, legge il Workspace Trust, persiste lo stato dove previsto e presenta le
  richieste di approvazione.
- Non contiene logica di orchestrazione.

### Orchestration runtime

- `packages/runtime`, Node puro e senza `vscode` (vincolo verificato da
  `tests/boundaries.test.ts` e da ESLint).
- Responsabilità previste: modello del thread, ruoli (leader, backup, worker), task
  contract, ciclo di vita dei task, domande dei worker, scheduling parallelo, stato delle
  quote, failover transazionale, checkpoint e ripresa.
- Stato attuale: espone solo `getRuntimeInfo()`.

### Provider adapters

- `packages/adapters`, Node puro e senza `vscode`.
- Ogni adapter avvia il **CLI ufficiale** come processo figlio e ne traduce il protocollo
  (stdio, JSON-RPC o NDJSON) in eventi del runtime.
- Non legge e non scrive le credenziali dei provider: l'autenticazione resta interamente
  nel CLI.
- Stato attuale: c'è solo il client di connessione a Codex App Server (avvio, handshake,
  richieste, notifiche, errori, arresto). Vedi [codex-app-server.md](codex-app-server.md).
  Il contratto generale dell'adapter non è ancora definito.

### Stato operativo persistente

- Task, eventi, domande, checkpoint e mappatura delle sessioni CLI.
- Requisiti: scritture atomiche (file temporaneo seguito da rename), schema versionato e
  ripresa idempotente.
- Posizione da decidere: `ExtensionContext.storageUri` (per workspace) oppure una
  directory locale dedicata. Non nel repository dell'utente, salvo opt-in.

### Permessi

- Un unico punto di decisione nel runtime, la cui UI vive nell'host.
- Le richieste dei CLI (approval request) passano dall'adapter al runtime, poi all'host e
  alla Webview, e tornano indietro per lo stesso percorso.
- Le policy sono descritte in [security.md](security.md).

### Strumenti esterni

- MCP server, Graft, Basic Memory e skill sono configurati dall'utente e consumati dai
  CLI dei provider o dal runtime **solo se presenti**.
- Il core non dipende da nessuno di essi.

## Struttura del repository

| Percorso                  | Contenuto                                                          |
| ------------------------- | ------------------------------------------------------------------ |
| `apps/vscode/src/`        | extension host (`extension.ts`, `commands/`, `webview/` lato host) |
| `apps/vscode/webview/`    | codice browser della Webview (tsconfig DOM e JSX separato)         |
| `apps/vscode/media/`      | CSS e asset statici serviti alla Webview                           |
| `apps/vscode/test/unit/`  | unit test Vitest (senza Extension Host)                            |
| `apps/vscode/test/suite/` | integration test nell'Extension Host                               |
| `packages/runtime/`       | runtime di orchestrazione                                          |
| `packages/adapters/`      | adapter dei CLI                                                    |
| `tests/`                  | test architetturali trasversali                                    |
| `references/`             | sorgenti di riferimento in sola lettura (fuori dal versionamento)  |

I package interni espongono direttamente i sorgenti TypeScript e vengono inclusi
nel bundle dell'estensione da esbuild. Vedi
[decisions/0003](decisions/0003-monorepo-layout.md).

## Decisioni rinviate

- Formato del protocollo host ↔ Webview oltre a quello del bootstrap (`ready`, `status`,
  `ping`, `pong`).
- Interfaccia degli adapter e modello degli eventi.
- Motore di persistenza: file JSON e JSONL oppure SQLite. Oggi niente database (vincolo
  della sessione di bootstrap).
- Supporto ai worktree Git per i worker.
