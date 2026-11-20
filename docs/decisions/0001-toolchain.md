# 0001. Bootstrap toolchain and versions

- Status: Accepted (2026-10-18)

## Context

The bootstrap needs a reproducible Windows toolchain that requires no administrator privileges or upgrades to existing tools. Pin exact versions and select the latest stable release published **at least two weeks before** the bootstrap (2026-10-04 cutoff), subject to compatibility.

## Decision

| Tool                             | Version                                                | Rationale                                                 |
| -------------------------------- | ------------------------------------------------------ | --------------------------------------------------------- |
| Node.js                          | 24.11.1 (already installed)                            | 24 LTS, no installation required                          |
| pnpm                             | 10.34.6                                                | See below                                                 |
| TypeScript                       | 6.0.3                                                  | See below                                                 |
| esbuild                          | 0.28.2                                                 | Bundles the host (CJS, node22) and webview (IIFE, es2022) |
| Vitest                           | 5.0.3                                                  | Unit tests                                                |
| ESLint                           | 10.12.0 + @eslint/js 10.0.1 + typescript-eslint 8.71.0 | Type-aware linting with `strictTypeChecked`               |
| Prettier                         | 3.9.9                                                  | Formatting                                                |
| Preact                           | 10.29.8                                                | Webview, see below                                        |
| @types/vscode                    | 1.140.0                                                | Matches `engines.vscode` (`^1.140.0`)                     |
| @types/node                      | 24.19.1                                                | Matches the Node 24 runtime                               |
| @vscode/vsce                     | 4.0.0                                                  | VSIX packaging                                            |
| @vscode/test-cli / test-electron | 0.0.15 / 3.1.0                                         | Integration tests (test-cli includes Mocha 11)            |
| @types/mocha                     | 10.0.10                                                | Types for Extension Host tests                            |

**pnpm 10.** pnpm 11 and 12 changed their package layout to use an `.mjs` entry point and a native executable. Corepack 0.34.2, bundled with Node 24.11.1, looks for `bin/pnpm.cjs` and fails. Upgrading Corepack would require a global npm installation, which was outside the scope of the bootstrap. The 10.x line is still maintained (`latest-10`). Revisit the choice when Node bundles a compatible Corepack version.

**TypeScript 6.0.** The native port in TypeScript 7 exposes only `unstable/*` APIs, and typescript-eslint 8.71 declares `typescript >=4.8.4 <6.1.0`. Version 6.0 is the latest release in the JavaScript line and works with the entire stack.

**Preact 10.** Preact 11.0.0, the first `.0` release of the major version, shipped on September 30. An empty webview offers little reason to take on the migration risk. Revisit the choice when UI development starts.

**Installation scripts.** Dependency build scripts are blocked. The optional dependency supplies the binary `esbuild` needs, and `@vscode/vsce-sign` is required only for signing or verification.

**pnpm installation.** Use `corepack enable pnpm --install-directory %APPDATA%\npm`. The Node directory (`F:\NodeJs`) requires elevated privileges to write.

## Consequences

- `pnpm install --frozen-lockfile` is reproducible, and CI uses the same versions.
- Upgrades are explicit. `savePrefix: ''` pins exact versions.
- Revisit pnpm 10 and TypeScript 6 when their ecosystem constraints change.
