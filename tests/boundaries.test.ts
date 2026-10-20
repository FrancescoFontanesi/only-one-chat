// Architectural guards that must hold for every change:
//  - runtime and adapters never depend on the VS Code API;
//  - no project source imports from references/ (the folder may be deleted).

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const vscodeFreePackages = ['packages/runtime', 'packages/adapters'];
const sourceRoots = [
  'apps/vscode/src',
  'apps/vscode/webview',
  ...vscodeFreePackages.map((p) => `${p}/src`),
];

function sourceFiles(dir: string): string[] {
  return readdirSync(join(root, dir), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(entry.name))
    .map((entry) => join(entry.parentPath, entry.name));
}

const importSpecifier = /(?:from\s+|import\s*\(\s*|require\s*\(\s*|import\s+)['"]([^'"]+)['"]/g;

function importsOf(file: string): string[] {
  return [...readFileSync(file, 'utf8').matchAll(importSpecifier)].map((match) => match[1] ?? '');
}

describe.each(vscodeFreePackages)('%s', (pkg) => {
  it('does not import the vscode API', () => {
    const offenders = sourceFiles(`${pkg}/src`).filter((file) =>
      importsOf(file).some((spec) => spec === 'vscode' || spec.startsWith('vscode/')),
    );
    expect(offenders.map((file) => relative(root, file))).toEqual([]);
  });

  it('does not declare vscode dependencies', () => {
    const manifest = JSON.parse(readFileSync(join(root, pkg, 'package.json'), 'utf8')) as Record<
      string,
      Record<string, string> | undefined
    >;
    const declared = ['dependencies', 'devDependencies', 'peerDependencies'].flatMap((field) =>
      Object.keys(manifest[field] ?? {}),
    );
    expect(
      declared.filter((name) => name === 'vscode' || name.startsWith('@types/vscode')),
    ).toEqual([]);
  });
});

describe('project sources', () => {
  it('never import from references/', () => {
    const offenders = sourceRoots
      .flatMap(sourceFiles)
      .filter((file) => importsOf(file).some((spec) => /(^|\/)references\//.test(spec)));
    expect(offenders.map((file) => relative(root, file))).toEqual([]);
  });
});
