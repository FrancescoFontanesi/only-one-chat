// Bundles the extension host (Node, CommonJS) and the webview (browser, IIFE).
//
//   node esbuild.mjs               development build with source maps
//   node esbuild.mjs --watch       rebuild on change
//   node esbuild.mjs --production  minified, no source maps (used by `package`)
//   node esbuild.mjs --tests       also bundle the integration tests into out/test

import { rm } from 'node:fs/promises';
import { context, build } from 'esbuild';

const args = new Set(process.argv.slice(2));
const production = args.has('--production');
const watch = args.has('--watch');
const tests = args.has('--tests');

/** @type {import('esbuild').BuildOptions} */
const common = {
  bundle: true,
  minify: production,
  sourcemap: !production,
  legalComments: 'none',
  logLevel: 'info',
};

/** @type {import('esbuild').BuildOptions[]} */
const targets = [
  {
    ...common,
    entryPoints: ['src/extension.ts'],
    outfile: 'dist/extension.js',
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['vscode'],
  },
  {
    ...common,
    entryPoints: ['webview/main.tsx'],
    outfile: 'dist/webview/main.js',
    platform: 'browser',
    format: 'iife',
    target: 'es2022',
    jsx: 'automatic',
    jsxImportSource: 'preact',
  },
];

if (tests) {
  targets.push({
    ...common,
    entryPoints: ['test/suite/*.test.ts'],
    outdir: 'out/test',
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['vscode', 'mocha'],
  });
}

await rm('dist', { recursive: true, force: true });
if (tests) await rm('out', { recursive: true, force: true });

if (watch) {
  const contexts = await Promise.all(targets.map((options) => context(options)));
  await Promise.all(contexts.map((ctx) => ctx.watch()));
} else {
  await Promise.all(targets.map((options) => build(options)));
}
