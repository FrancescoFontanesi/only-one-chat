import { defineConfig } from 'vitest/config';

// Unit tests only. They run in plain Node: no extension host, no network,
// no AI accounts. Extension host tests live in apps/vscode/test/suite.
export default defineConfig({
  test: {
    include: [
      'packages/*/test/**/*.test.ts',
      'apps/*/test/unit/**/*.test.ts',
      'tests/**/*.test.ts',
    ],
    environment: 'node',
  },
});
