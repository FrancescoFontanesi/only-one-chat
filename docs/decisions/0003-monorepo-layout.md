# 0003. Layout del monorepo e package interni

- Stato: Accettata (2026-10-18)

## Contesto

Runtime e adapter devono essere testabili senza Extension Host e indipendenti da
`vscode`. Al momento c'è un solo consumatore (l'estensione), e la toolchain deve
restare minima.

## Decisione

- Workspace pnpm con `apps/vscode` (l'estensione) e `packages/runtime` e
  `packages/adapters`.
- I package interni sono **sorgenti TypeScript** (`exports: "./src/index.ts"`) senza build
  separata: esbuild li include nel bundle dell'estensione, mentre Vitest e `tsc` li
  leggono direttamente.
- Il codice della Webview vive in `apps/vscode/webview/` e non in `src/webview/`: usa le
  lib DOM e JSX di Preact, incompatibili con il tsconfig Node dell'host. In
  `src/webview/` resta il lato host del pannello (`panel.ts`, `html.ts`, `protocol.ts`).
  `protocol.ts` è condiviso e non deve importare né `vscode` né API DOM.
- Il vincolo "niente `vscode` in `packages/*`" è imposto due volte: con
  `no-restricted-imports` in ESLint e con `tests/boundaries.test.ts`.
- L'extension host è bundle CommonJS (target node22), la Webview è bundle IIFE (es2022).

## Conseguenze

- Nessun passaggio di build o pubblicazione per i package. Se un giorno andranno
  pubblicati su npm, bisognerà aggiungere una build `tsc` o tsup.
- Tre tsconfig nell'app (host, webview, test): `pnpm typecheck` li verifica tutti.
