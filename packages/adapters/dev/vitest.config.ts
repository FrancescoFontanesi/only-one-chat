import { defineConfig } from 'vitest/config';

// Runs the dev tools (transcript recorder, diagnosis), never part of `pnpm test`.
// The script picks one with a file filter, e.g. `vitest run --config … record-codex`.
export default defineConfig({
  root: import.meta.dirname,
  test: {
    include: ['record-codex.ts', 'record-claude.ts', 'diagnose.ts'],
    environment: 'node',
  },
});
