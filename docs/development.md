# Development

## Prerequisites (Windows)

| Tool              | Version             | Notes                                                |
| ----------------- | ------------------- | ---------------------------------------------------- |
| Windows 10/11 x64 | —                   | Primary platform                                     |
| VS Code           | ≥ 1.140             | `engines.vscode` is `^1.140.0`                       |
| Git               | ≥ 2.27              | Cone-mode sparse checkout for reference repositories |
| Node.js           | ≥ 24.11 (24 LTS)    | `engines.node`                                       |
| pnpm              | Exactly **10.34.6** | Pinned in `packageManager` and supplied by Corepack  |
| PowerShell        | 5.1 or 7            | Scripts support both versions                        |

To check the environment in read-only mode, run:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/check-environment.ps1
```

### Install pnpm with Corepack

Node includes Corepack. If the Node installation directory requires administrator
privileges for writes (as it did on the development machine), create the shims in a user
directory already on the PATH:

```powershell
corepack enable pnpm --install-directory "$env:APPDATA\npm"
corepack prepare pnpm@10.34.6 --activate
pnpm --version   # 10.34.6
```

Corepack 0.34, bundled with Node 24.11, supports pnpm 10. pnpm 11 and 12 use a newer
package layout. See [ADR 0001](decisions/0001-toolchain.md).

## Installation

```powershell
pnpm install --frozen-lockfile
```

pnpm 10 blocks dependency install scripts by default. `pnpm-workspace.yaml` documents
the exceptions.

## Commands

Run all commands from the repository root.

| Command          | Purpose                                                          |
| ---------------- | ---------------------------------------------------------------- |
| `pnpm build`     | Development bundle (extension host and Webview) with source maps |
| `pnpm typecheck` | Strict `tsc --noEmit` across all projects                        |
| `pnpm lint`      | Type-aware ESLint with `--max-warnings 0` and `prettier --check` |
| `pnpm format`    | Format with Prettier                                             |
| `pnpm test`      | Vitest unit tests in Node                                        |
| `pnpm test:e2e`  | Smoke test in an isolated Extension Host                         |
| `pnpm package`   | Production bundle and `apps/vscode/only-one-chat-<version>.vsix` |
| `pnpm check`     | Build, type checking, lint, and tests                            |

For watch mode, run `pnpm --filter only-one-chat run watch`.

## Run with F5

1. Open the repository folder in VS Code.
2. Press **F5** and choose "Run Extension". The `build` task runs automatically.
3. In the Extension Development Host, open the Command Palette and run
   **Only One Chat: Open Panel**.
4. The panel shows versions and Workspace Trust status. The **Ping extension host**
   button verifies the message round trip.

The Extension Development Host starts with `--disable-extensions`, which keeps other
installed extensions such as Codex, Claude Code, and Antigravity from loading.

### Local experiments

Git ignores `sandbox/`. To run the benchmarks, provide a local scenario in
`sandbox/scenarios/<name>/` with `systems.json` and the scenario's required input
files. `pnpm bench --fake --system <system> --scenario <name>` uses fake CLIs. Live runs
consume quota and require authorization. Results are written to `sandbox/results/`.

`pnpm playground` and the "Run Extension (playground)" launch configuration use a
separate working copy. To create or reset it, provide the local reference project in
`sandbox/scenarios/calc/reference/`. The "Run Extension" configuration works from a
clone of this repository.

## Testing

- **Unit tests** (`pnpm test`) run from `packages/*/test`, `apps/vscode/test/unit`, and
  `tests/` without VS Code, network access, or an account.
- **Architecture tests** (`tests/boundaries.test.ts`) verify that runtime and adapters
  avoid imports from `vscode` and that source files avoid imports from `references/`.
- **Integration tests** (`pnpm test:e2e`) use `@vscode/test-cli` to download VS Code
  1.140.0 into `.vscode-test/` (about 200 MB on first run) with an isolated profile and
  extensions. The tests verify activation, command registration, and the Webview
  handshake.

## Packaging

```powershell
pnpm package
```

The VSIX allow-list in `apps/vscode/.vscodeignore` includes `dist/extension.js`,
`dist/handoff-server.js`, `dist/hooks/permission-request.mjs`,
`dist/webview/main.js`, `media/`, `package.json`, and `README.md`. Third-party font
notices ship with the fonts in `media/fonts/`. Install the package locally with
`code --install-extension apps/vscode/only-one-chat-0.0.1.vsix`.

## Reference repositories

```powershell
powershell -ExecutionPolicy Bypass -File scripts/fetch-references.ps1
```

The script fetches pinned commits into `references/` using partial clones and sparse
checkouts for large repositories. It leaves existing checkouts alone. To change a pin,
update the SHA in the script and [reference-sources.md](reference-sources.md), then run it
with `-Force -Only <name>`. The project builds without `references/`.

## Graft (optional)

Graft is an optional personal tool. To build the free local index without an LLM, run:

```powershell
$env:DO_NOT_TRACK = '1'   # Disable telemetry for this shell only
graft build
```

Graft writes the index to `graft/` and creates `.ignore` so ripgrep can search it.
Git, ESLint, Prettier, and the VSIX exclude both paths. Use `--deep` only if you intend
to configure an LLM provider and API key.

## Troubleshooting

| Symptom                                                      | Cause and remedy                                                                                                                                                                                                    |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `corepack enable` → `EPERM ... F:\NodeJs\pnpm`               | The Node directory is read-only for the current user. Use `--install-directory` as shown above.                                                                                                                     |
| `Cannot find module ...\pnpm\12.x\bin\pnpm.cjs`              | Corepack 0.34 is incompatible with pnpm ≥ 11. Use the version pinned in `packageManager`.                                                                                                                           |
| `pnpm test:e2e` fails to launch VS Code when run by an agent | The process inherited `ELECTRON_RUN_AS_NODE=1`, `VSCODE_IPC_HOOK`, or both from the extension host. Run it from the integrated terminal, or remove the `ELECTRON_*` and `VSCODE_*` variables for that process only. |
| `[AgentHost] No signed-in session` in the e2e log            | VS Code's built-in features emit this message in the isolated profile because it has no account. Test results are unaffected.                                                                                       |
| `Ignored build scripts: @vscode/vsce-sign`                   | The script is needed only for `vsce sign`. `vsce package` works without it.                                                                                                                                         |
| Execution policy blocks `.ps1` scripts                       | Run `powershell -ExecutionPolicy Bypass -File ...`.                                                                                                                                                                 |
