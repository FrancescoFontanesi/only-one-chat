import { defineConfig } from 'vitest/config';

// Unit tests only. They run in plain Node: no extension host, no network,
// no AI accounts. Extension host tests live in apps/vscode/test/suite.
export default defineConfig({
  // The runtime's role prompts are Markdown files, imported as their text (ADR 0020).
  plugins: [
    {
      name: 'markdown-as-text',
      enforce: 'pre',
      transform(code, id) {
        return id.endsWith('.md') ? `export default ${JSON.stringify(code)};` : undefined;
      },
    },
  ],
  test: {
    include: [
      'packages/*/test/**/*.test.ts',
      'apps/*/test/unit/**/*.test.ts',
      'tests/**/*.test.ts',
    ],
    environment: 'node',
  },
});
