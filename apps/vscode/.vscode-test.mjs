import { defineConfig } from '@vscode/test-cli';

// Downloads an isolated VS Code build into .vscode-test/ (user data and
// extensions included), so the developer's own installation and profile are
// never touched. The version is the minimum declared in engines.vscode.
export default defineConfig({
  files: 'out/test/**/*.test.js',
  version: '1.140.0',
  launchArgs: ['--disable-extensions'],
  mocha: {
    ui: 'bdd',
    timeout: 60_000,
  },
});
