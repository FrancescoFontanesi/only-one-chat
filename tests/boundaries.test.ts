// Architectural guards that must hold for every change:
//  - runtime and adapters never depend on the VS Code API;
//  - no project source imports from references/ (the folder may be deleted);
//  - no cycle of value imports, session and shared code never import the webview layer, and
//    no source file grows past the line ceiling (ADR 0047).

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
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

const sources = sourceRoots.flatMap(sourceFiles).filter((file) => !file.endsWith('.d.ts'));
const lineCount = (file: string) => readFileSync(file, 'utf8').split(/\r?\n/).length;
const rel = (file: string) => relative(root, file).split(sep).join('/');

/** Relative imports of a file by their written path; `values` leaves out the type-only ones. */
function relativeImports(file: string, values: boolean): string[] {
  // A leading BOM would hide a first-line import from the `^` anchor.
  const text = readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  const named =
    /^[ \t]*(?:import|export)\s+(type\s+)?(\{[^}]*\}|\*(?:\s+as\s+\w+)?|\w+(?:\s*,\s*(?:\{[^}]*\}|\*\s+as\s+\w+))?)\s*from\s*['"]([^'"]+)['"]/gm;
  const bare = /^[ \t]*import\s*['"]([^'"]+)['"]/gm;
  const found: string[] = [];
  for (const [, type, clause = '', spec = ''] of text.matchAll(named)) {
    const members = clause.startsWith('{') ? clause.slice(1, -1).split(',') : [];
    const onlyTypes =
      members.length > 0 && members.every((m) => !m.trim() || /^type\s/.test(m.trim()));
    if (!values || (!type && !onlyTypes)) found.push(spec);
  }
  for (const [, spec = ''] of text.matchAll(bare)) found.push(spec);
  return found.filter((spec) => spec.startsWith('.'));
}

/** The source file an import names: `.js` stands for `.ts`/`.tsx`, a folder for its index. */
function target(from: string, spec: string, known: ReadonlySet<string>): string | undefined {
  const base = resolve(dirname(from), spec);
  const stem = base.replace(/\.[cm]?js$/, '');
  return [
    base,
    `${stem}.ts`,
    `${stem}.tsx`,
    `${stem}.mts`,
    `${stem}.cts`,
    join(base, 'index.ts'),
  ].find((candidate) => known.has(candidate));
}

describe('structure (ADR 0047)', () => {
  it('has no cycle of value imports', () => {
    const known = new Set(sources.map((file) => resolve(file)));
    const edges = new Map(
      sources.map((file) => [
        resolve(file),
        relativeImports(file, true).flatMap((spec) => target(resolve(file), spec, known) ?? []),
      ]),
    );
    const cycles: string[] = [];
    const state = new Map<string, 'open' | 'done'>();
    const visit = (file: string, path: string[]): void => {
      if (state.get(file) === 'done') return;
      if (state.get(file) === 'open') {
        cycles.push([...path.slice(path.indexOf(file)), file].map((f) => rel(f)).join(' -> '));
        return;
      }
      state.set(file, 'open');
      for (const next of edges.get(file) ?? []) visit(next, [...path, file]);
      state.set(file, 'done');
    };
    for (const file of edges.keys()) visit(file, []);
    expect(cycles).toEqual([]);
  });

  it.each(['session', 'shared'])(
    'keeps apps/vscode/src/%s/ from importing the webview layer or Preact, types included',
    (folder) => {
      const layers = ['apps/vscode/src/webview', 'apps/vscode/webview'].map((p) => join(root, p));
      const offenders = sources
        .filter((file) => rel(file).startsWith(`apps/vscode/src/${folder}/`))
        .filter(
          (file) =>
            importsOf(file).some((spec) => spec === 'preact' || spec.startsWith('preact/')) ||
            relativeImports(file, false).some((spec) => {
              const path = resolve(dirname(file), spec);
              return layers.some((layer) => path === layer || path.startsWith(layer + sep));
            }),
        );
      expect(offenders.map(rel)).toEqual([]);
    },
  );

  // Entries only go down: lower one when its file shrinks, delete it under the default.
  // Never add one: split the file instead.
  const LINE_CEILING = 800;
  const LEGACY_CEILING: Readonly<Record<string, number>> = {
    'packages/runtime/src/loop.ts': 1414,
    'packages/adapters/src/claude/turn.ts': 855,
    'packages/adapters/src/codex/agent.ts': 956,
    'apps/vscode/src/session/chat.ts': 2126,
    'apps/vscode/src/shared/protocol.ts': 946,
    'apps/vscode/src/webview/panel.ts': 1381,
    'apps/vscode/webview/Thread.tsx': 919,
  };

  it('keeps every source file under its line ceiling', () => {
    const over = sources.flatMap((file) => {
      const lines = lineCount(file);
      const ceiling = LEGACY_CEILING[rel(file)] ?? LINE_CEILING;
      return lines > ceiling ? [`${rel(file)}: ${String(lines)} > ${String(ceiling)}`] : [];
    });
    expect(over).toEqual([]);
  });

  it('lists only files that still exist above the default ceiling', () => {
    const stale = Object.keys(LEGACY_CEILING).filter((path) => {
      const file = sources.find((candidate) => rel(candidate) === path);
      return !file || lineCount(file) <= LINE_CEILING;
    });
    expect(stale).toEqual([]);
  });
});
