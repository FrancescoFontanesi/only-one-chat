# Sviluppo

## Prerequisiti (Windows)

| Strumento         | Versione           | Note                                              |
| ----------------- | ------------------ | ------------------------------------------------- |
| Windows 10/11 x64 | —                  | piattaforma primaria                              |
| VS Code           | ≥ 1.140            | `engines.vscode` è `^1.140.0`                     |
| Git               | ≥ 2.27             | per la sparse checkout cone usata dai riferimenti |
| Node.js           | ≥ 24.11 (24 LTS)   | `engines.node`                                    |
| pnpm              | **10.34.6** esatta | fissata in `packageManager` e fornita da corepack |
| PowerShell        | 5.1 o 7            | gli script sono compatibili con entrambe          |

Per verificare l'ambiente (sola lettura):

```powershell
powershell -ExecutionPolicy Bypass -File scripts/check-environment.ps1
```

### Installare pnpm con corepack

Corepack è incluso in Node. Se la cartella di installazione di Node non è scrivibile
senza privilegi di amministratore (è il caso di questa macchina), crea gli shim in una
cartella utente già presente nel PATH:

```powershell
corepack enable pnpm --install-directory "$env:APPDATA\npm"
corepack prepare pnpm@10.34.6 --activate
pnpm --version   # 10.34.6
```

Perché pnpm 10 e non 12: il corepack 0.34 incluso in Node 24.11 non supporta la nuova
struttura dei pacchetti pnpm 11 e 12. Vedi [decisions/0001](decisions/0001-toolchain.md).

## Installazione

```powershell
pnpm install --frozen-lockfile
```

Gli script di installazione delle dipendenze restano bloccati (default di pnpm 10).
Le eccezioni sono documentate in `pnpm-workspace.yaml`.

## Comandi

Tutti i comandi si lanciano dalla root del repository.

| Comando          | Cosa fa                                                            |
| ---------------- | ------------------------------------------------------------------ |
| `pnpm build`     | bundle di sviluppo (extension host e Webview) con source map       |
| `pnpm typecheck` | `tsc --noEmit` strict su tutti i progetti                          |
| `pnpm lint`      | ESLint (type-aware, `--max-warnings 0`) + `prettier --check`       |
| `pnpm format`    | formatta con Prettier                                              |
| `pnpm test`      | unit test Vitest (Node puro)                                       |
| `pnpm test:e2e`  | smoke test nell'Extension Host isolato                             |
| `pnpm package`   | bundle di produzione + `apps/vscode/only-one-chat-<versione>.vsix` |
| `pnpm check`     | build + typecheck + lint + test                                    |

Watch: `pnpm --filter only-one-chat run watch`.

## Avvio con F5

1. Apri la cartella del repository in VS Code.
2. Premi **F5** e scegli "Run Extension". Il task `build` parte in automatico.
3. Nell'Extension Development Host apri la Command Palette e lancia
   **Only One Chat: Open Panel**.
4. Il pannello mostra le versioni e lo stato del workspace trust. Il pulsante
   **Ping extension host** verifica il round trip dei messaggi.

L'Extension Development Host parte con `--disable-extensions`: le altre estensioni
installate (Codex, Claude Code, Antigravity, ...) non vengono caricate.

## Testing

- **Unit** (`pnpm test`): `packages/*/test`, `apps/vscode/test/unit`, `tests/`. Non
  richiedono VS Code, rete o account.
- **Architetturali** (`tests/boundaries.test.ts`): verificano che runtime e adapter non
  importino `vscode` e che nessun sorgente importi da `references/`.
- **Integration** (`pnpm test:e2e`): `@vscode/test-cli` scarica VS Code 1.140.0 in
  `.vscode-test/` (circa 200 MB al primo avvio) con profilo ed estensioni isolati, poi
  verifica l'attivazione, la registrazione del comando e l'handshake con la Webview.

## Packaging

```powershell
pnpm package
```

Il VSIX contiene solo `dist/extension.js`, `dist/webview/main.js`, `media/`,
`package.json`, `README.md` e `LICENSE` (allow-list in `apps/vscode/.vscodeignore`).
Per installarlo in locale: `code --install-extension apps/vscode/only-one-chat-0.0.1.vsix`.

## Repository di riferimento

```powershell
powershell -ExecutionPolicy Bypass -File scripts/fetch-references.ps1
```

Scarica i riferimenti in `references/` ai commit fissati (partial clone, sparse checkout
per i repository grandi). Lo script non aggiorna mai una checkout esistente: per cambiare
un pin modifica lo SHA nello script e in [reference-sources.md](reference-sources.md),
poi lancia `-Force -Only <nome>`. Il progetto si compila anche senza `references/`.

## Graft (opzionale)

Graft è uno strumento personale e non è una dipendenza del progetto. Per l'indice locale
(gratuito, senza LLM):

```powershell
$env:DO_NOT_TRACK = '1'   # disattiva la telemetria solo per questa shell
graft build
```

L'indice finisce in `graft/`; graft scrive anche `.ignore` (per renderlo cercabile con
ripgrep). Entrambi sono esclusi da git, ESLint, Prettier e VSIX. Non usare
`--deep` senza aver deciso consapevolmente: richiede un provider LLM e una chiave.

## Troubleshooting

| Sintomo                                                    | Causa e soluzione                                                                                                                                                                                           |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `corepack enable` → `EPERM ... F:\NodeJs\pnpm`             | la cartella di Node non è scrivibile: usa `--install-directory` (vedi sopra)                                                                                                                                |
| `Cannot find module ...\pnpm\12.x\bin\pnpm.cjs`            | corepack 0.34 non supporta pnpm ≥ 11: usa la versione in `packageManager`                                                                                                                                   |
| `pnpm test:e2e` non avvia VS Code se lanciato da un agente | il processo ha ereditato `ELECTRON_RUN_AS_NODE=1` e/o `VSCODE_IPC_HOOK` dall'extension host. Lancialo dal terminale integrato, oppure rimuovi le variabili `ELECTRON_*` e `VSCODE_*` solo per quel processo |
| Log `[AgentHost] No signed-in session` durante l'e2e       | sono funzioni integrate di VS Code nel profilo isolato, che non ha account: è normale e non incide sul risultato                                                                                            |
| `Ignored build scripts: @vscode/vsce-sign`                 | voluto: serve solo a `vsce sign`, non a `vsce package`                                                                                                                                                      |
| Execution policy blocca gli script `.ps1`                  | lancia con `powershell -ExecutionPolicy Bypass -File ...`                                                                                                                                                   |
