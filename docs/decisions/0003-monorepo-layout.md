# 0003. Monorepo layout and internal packages

- Status: Accepted (2026-10-18)

## Context

The runtime and adapters must be testable outside the Extension Host and independent of `vscode`. The extension is the only consumer at this point, so the toolchain should stay small.

## Decision

- Use a pnpm workspace with `apps/vscode` (the extension), `packages/runtime`, and `packages/adapters`.
- Internal packages expose **TypeScript sources** (`exports: "./src/index.ts"`) directly. esbuild includes them in the extension bundle. Vitest and `tsc` read them directly.
- Browser-side webview code lives in `apps/vscode/webview/` because it uses the DOM libraries and Preact JSX, which are incompatible with the host's Node tsconfig. The host side of the panel stays in `src/webview/` (`panel.ts`, `html.ts`, and `protocol.ts`). The shared `protocol.ts` is independent of both `vscode` and DOM APIs.
- ESLint's `no-restricted-imports` rule and `tests/boundaries.test.ts` both enforce the ban on `vscode` imports from `packages/*`.
- The Extension Host uses a CommonJS bundle targeting node22. The webview uses an IIFE bundle targeting es2022.

## Consequences

- Internal packages need no separate build or publication step. Publishing them to npm would require adding a build with `tsc` or tsup.
- `pnpm typecheck` checks all three app tsconfigs for the host, webview, and tests.
