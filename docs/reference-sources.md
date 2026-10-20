# Sorgenti di riferimento

I repository in `references/` servono **solo da studio**. Non sono codice del progetto,
non vengono installati né eseguiti e sono esclusi da git e dal VSIX.
Politica di riuso: [decisions/0002](decisions/0002-reuse-policy.md), cioè sola
reimplementazione: si riprendono idee e pattern, mai codice copiato o tradotto riga per riga.

Recupero: `scripts/fetch-references.ps1` (pin per SHA, nessun aggiornamento automatico).
Data del pin: 2026-10-18.

| Nome                      | URL                                                   | Commit                                     | Licenza                            | Checkout           |
| ------------------------- | ----------------------------------------------------- | ------------------------------------------ | ---------------------------------- | ------------------ |
| usturlab                  | https://github.com/mdenesfe/usturlab                  | `2607aa8d1b0724a9083fc66b7d087522fe468ddf` | MIT, © 2026 Enes Demir             | completa, 175 file |
| augani-agent-orchestrator | https://github.com/Augani/agent-orchestrator          | `8d9b897c49500e8e1b54ec8028352544db95618d` | MIT, © 2026 Augustus Otu           | completa, 24 file  |
| codex-source              | https://github.com/openai/codex                       | `8d9f6466ff0294785d56f55b1fe363d132fe4133` | Apache-2.0 + NOTICE, © 2025 OpenAI | sparse, 1806 file  |
| vscode-extension-samples  | https://github.com/microsoft/vscode-extension-samples | `65c1c44800eeac6fb065a54823ee5ae62c79540a` | MIT, © Microsoft Corporation       | sparse, 73 file    |

## usturlab

Estensione VS Code multi-provider (TypeScript, pnpm, Preact, esbuild).

**Da studiare**

- Struttura dell'estensione: `packages/vscode/src/extension.ts`, `commands.ts`, `esbuild.mjs`.
- Webview e UI: `packages/vscode/src/panel/chatViewProvider.ts`, `panel/protocol.ts`,
  `panel/transcript.ts`, `packages/vscode/webview/` (Preact).
- Adapter Codex e Claude: `packages/core/src/adapters/codex.ts` (JSON-RPC verso
  app-server), `claude.ts` (stream NDJSON), `jsonRpc.ts`, `ndjson.ts`, `spawn.ts`, `acp.ts`.
- Sessioni e streaming: `packages/core/src/session/sessionStore.ts`.
- Autenticazione e profili: `packages/core/src/accounts/`, `packages/vscode/src/onboarding/`.
- Quote: `packages/core/src/quota/` (`codexUsageReader.ts` legge i rollout di Codex,
  `claudeUsagePoller.ts`), `adapters/limits.ts` (rilevamento di `rate_limit_event`).
- Failover: `packages/core/src/orchestrator/orchestrator.ts`.
- Permessi: `packages/core/src/adapters/permission.ts`, `packages/vscode/src/permission/`.
- Fixture di test realistiche: `packages/core/test/fixtures/*.ndjson`.

**Rischi verificati**

- Permessi persistenti troppo generici: `PermissionMemory` usa come chiave il primo token
  del comando oppure solo il tipo di richiesta (`adapters/permission.ts:59-73`).
- Gestione automatica del workspace trust: `GEMINI_CLI_TRUST_WORKSPACE=true`
  (`adapters/gemini.ts:63`).
- Scrittura nel profilo del CLI (`settings.json` di Gemini) in `adapters/gemini.ts:32-52`.
- Modalità "full" che passa `--dangerously-skip-permissions` (`adapters/claude.ts:21`).
- Failover non transazionale: si passa al target successivo con l'output parziale in
  memoria, senza checkpoint persistito (`orchestrator/orchestrator.ts:300-320`).
- Router generalista (`src/router/`) e supporto a OpenRouter (API a pagamento): fuori
  dallo scope di questo prodotto.

## augani-agent-orchestrator

Plugin di orchestrazione per Codex (Python + skill + dashboard web).

**Da studiare**

- Task contract: `skills/orchestrate-cli-agents/references/task-contract.md` (sezioni
  obbligatorie: Objective, Why, Scope, Files to inspect, Implementation guidance,
  Constraints, Acceptance criteria, Validation, Final report).
- Pianificazione e delega: `skills/orchestrate-cli-agents/SKILL.md`,
  `references/routing-and-plans.md`.
- Ciclo di vita dei worker, heartbeat, log, domande: `scripts/cli_agent_job.py`, con i
  sottocomandi `launch`, `status`, `wait`, `logs`, `event`, `ask`, `questions`,
  `answer` e `cancel` (`:3868-4240`).
- Stato persistente e scritture atomiche: `write_json` (`cli_agent_job.py:540-551`).
- Worktree e isolamento: `workspace_mode` (`worktree` di default, `:512-520`).
- Review gate: `review_notes` (`:3433`).
- Dashboard locale: `scripts/dashboard_server.py`, che ascolta su `127.0.0.1` con token
  casuale.

**Rischi e limiti**

- Codex è cablato come coordinatore: lo stato vive in `~/.codex/agent-orchestrator`
  (`:491-499`). Noi studiamo il comportamento senza introdurre questa dipendenza.
- Script Python monolitico (163 KB): va estratto il modello, non il codice.
- Contiene `cursor-guard`, con hook che negano i subagent: è specifico di Cursor.

## codex-source

Sorgenti pubblici del CLI Codex (Rust). Sparse checkout di: `codex-rs/app-server`,
`codex-rs/app-server-protocol`, `codex-rs/docs`, `codex-rs/exec`, `codex-rs/protocol`,
`docs`, `sdk` (più i file di root, inclusi LICENSE e NOTICE).

**Da studiare**

- `codex-rs/app-server/README.md`: protocollo JSON-RPC dell'app-server (thread, turni,
  approvazioni, MCP, project trust, rollback).
- `codex-rs/app-server-protocol/`: tipi del protocollo, la fonte autorevole per l'adapter.
- `codex-rs/protocol/`: eventi core, tool call, approvazioni.
- `codex-rs/exec/`: modalità non interattiva. `codex exec --json` è definito in
  `codex-rs/exec/src/cli.rs:65`. `docs/exec.md` contiene solo un link alla
  documentazione online.
- `sdk/typescript/`: SDK ufficiale che pilota il CLI, con pattern di spawn e parsing.
- `docs/authentication.md`, `docs/sandbox.md`, `docs/execpolicy.md`, `docs/config.md`.

**Rischi**

- Il protocollo dell'app-server è in evoluzione e contiene molte sezioni "experimental":
  serve un controllo di versione all'handshake.
- Apache-2.0: se mai si riusasse del codice, servirebbero NOTICE e l'indicazione delle
  modifiche. La politica 0002 lo esclude.
- Il sorgente dell'estensione VS Code ufficiale di Codex **non** è pubblico e non va
  estratto né decompilato. È solo un riferimento di UX.

## vscode-extension-samples

Sparse checkout di: `helloworld-sample`, `helloworld-test-sample`,
`helloworld-test-cli-sample`, `webview-sample`, `webview-view-sample`.

**Da studiare**

- `webview-sample/`: WebviewPanel, CSP con nonce, `localResourceRoots`, serializer.
- `webview-view-sample/`: WebviewView nella sidebar (un'alternativa al pannello editor).
- `helloworld-test-cli-sample/`: integration test con `@vscode/test-cli`, l'approccio
  adottato qui.
- `helloworld-test-sample/`: runner `@vscode/test-electron` di più basso livello.

**Licenza**: MIT a livello di repository. `webview-sample` e `webview-view-sample`
dichiarano MIT anche nel proprio `package.json`; i tre esempi `helloworld-*` non
dichiarano una licenza propria e ricadono sotto la licenza MIT del repository.
Nessun esempio include un file LICENSE proprio.

## Altri sample potenzialmente utili (non scaricati)

Nel repository dei sample esistono anche `chat-sample`, `chat-tutorial`,
`custom-editor-sample`, `tree-view-sample` e `webview-codicons-sample`. Si aggiungono
alla lista sparse in `fetch-references.ps1` quando servono.
