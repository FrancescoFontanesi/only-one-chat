# 0001. Toolchain e versioni del bootstrap

- Stato: Accettata (2026-10-18)

## Contesto

Serve una toolchain riproducibile su Windows, senza privilegi di amministratore e senza
aggiornare gli strumenti già presenti. Regola adottata: versioni esatte, scegliendo
l'ultima release stabile pubblicata **almeno due settimane prima** del bootstrap (cutoff
2026-10-04), salvo incompatibilità.

## Decisione

| Strumento                        | Versione                                               | Motivo                                               |
| -------------------------------- | ------------------------------------------------------ | ---------------------------------------------------- |
| Node.js                          | 24.11.1 (già installato)                               | 24 LTS, nessuna installazione necessaria             |
| pnpm                             | 10.34.6                                                | vedi sotto                                           |
| TypeScript                       | 6.0.3                                                  | vedi sotto                                           |
| esbuild                          | 0.28.2                                                 | bundling host (CJS, node22) e Webview (IIFE, es2022) |
| Vitest                           | 5.0.3                                                  | unit test                                            |
| ESLint                           | 10.12.0 + @eslint/js 10.0.1 + typescript-eslint 8.71.0 | lint type-aware `strictTypeChecked`                  |
| Prettier                         | 3.9.9                                                  | formattazione                                        |
| Preact                           | 10.29.8                                                | Webview, vedi sotto                                  |
| @types/vscode                    | 1.140.0                                                | uguale a `engines.vscode` (`^1.140.0`)               |
| @types/node                      | 24.19.1                                                | allineato al runtime Node 24                         |
| @vscode/vsce                     | 4.0.0                                                  | packaging VSIX                                       |
| @vscode/test-cli / test-electron | 0.0.15 / 3.1.0                                         | integration test (test-cli include mocha 11)         |
| @types/mocha                     | 10.0.10                                                | tipi per i test nell'Extension Host                  |

**pnpm 10 invece di 12.** pnpm 11 e 12 hanno cambiato la struttura del pacchetto (entry
`.mjs` e binario nativo). Il corepack 0.34.2 incluso in Node 24.11.1 cerca
`bin/pnpm.cjs` e fallisce. Per aggiornare corepack servirebbe un'installazione globale
via npm, che non era autorizzata. La linea 10 è ancora mantenuta (`latest-10`).
Rivalutare quando Node includerà un corepack compatibile.

**TypeScript 6.0 invece di 7.0.** TypeScript 7 (port nativo) espone solo API `unstable/*`
e typescript-eslint 8.71 dichiara `typescript >=4.8.4 <6.1.0`. La 6.0 è l'ultima della
linea JS ed è compatibile con tutto lo stack.

**Preact 10 invece di 11.** La 11.0.0 è uscita il 30/09 come prima `.0` della major. Per
una Webview ancora vuota il vantaggio è nullo e il rischio non è giustificato. La
migrazione si valuterà quando inizierà lo sviluppo della UI.

**Script di installazione bloccati.** Non approviamo nessun build script delle
dipendenze: `esbuild` funziona grazie al binario fornito come optional dependency,
mentre `@vscode/vsce-sign` serve solo a firmare o verificare e non al packaging.

**Installazione di pnpm.** `corepack enable pnpm --install-directory %APPDATA%\npm`,
perché la cartella di Node (`F:\NodeJs`) non è scrivibile senza privilegi.

## Conseguenze

- `pnpm install --frozen-lockfile` è riproducibile e la CI usa le stesse versioni.
- Gli upgrade sono espliciti (`savePrefix: ''`, cioè versioni esatte).
- Due scelte (pnpm 10, TS 6) dipendono da limiti dell'ecosistema e vanno riesaminate.
