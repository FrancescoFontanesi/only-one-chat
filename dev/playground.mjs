// Prepares the playground for trying the extension by hand: a folder outside
// the repository, holding a copy of the calc reference project, where the
// agents may write (ADR 0010: the open folder is their scope). An existing
// playground is kept as it is; `--reset` replaces it with a fresh copy.
//
//   pnpm playground [--reset]
//
// The "Run Extension (playground)" launch configuration opens this folder.

import { cpSync, existsSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const base =
  process.platform === 'win32'
    ? join(process.env['LOCALAPPDATA'] ?? join(homedir(), 'AppData', 'Local'), 'only-one-chat')
    : join(homedir(), '.local', 'state', 'only-one-chat');
const target = join(base, 'playground', 'calc');
const source = join(import.meta.dirname, '..', 'sandbox', 'scenarios', 'calc', 'reference');

if (process.argv.includes('--reset')) rmSync(target, { recursive: true, force: true });
if (existsSync(target)) {
  process.stdout.write(`Playground: ${target} (kept; --reset for a fresh copy)\n`);
} else {
  cpSync(source, target, {
    recursive: true,
    filter: (path) => !path.split(/[\\/]/).includes('__pycache__'),
  });
  process.stdout.write(`Playground: ${target} (fresh copy of the calc reference)\n`);
}
