import { defineConfig } from 'vitest/config';

// Runs the transcript recorder (record-codex.ts), never part of `pnpm test`.
export default defineConfig({
  root: import.meta.dirname,
  test: {
    include: ['record-codex.ts'],
    environment: 'node',
  },
});
