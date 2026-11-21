import {
  constants,
  existsSync,
  lstatSync,
  realpathSync,
  unlinkSync,
  statSync,
  symlinkSync,
} from 'node:fs';
import { cp } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { Checkpoint } from './checkpoints.js';

/** Copy the installed Node toolchain, remapping workspace links into the snapshot. */
export async function copyVerificationDependencies(
  cwd: string,
  destination: string,
  snapshot: Checkpoint,
  signal: AbortSignal,
): Promise<void> {
  const folders = new Set(['node_modules']);
  for (const file of Object.keys(snapshot.files)) {
    if (file === 'package.json' || file.endsWith('/package.json'))
      folders.add(join(dirname(file), 'node_modules'));
  }
  const links: { source: string; target: string }[] = [];
  let count = 0;
  let bytes = 0;
  const deadline = Date.now() + 30000;
  for (const folder of folders) {
    const source = join(cwd, folder);
    if (!existsSync(source)) continue;
    await cp(source, join(destination, folder), {
      recursive: true,
      verbatimSymlinks: true,
      mode: constants.COPYFILE_FICLONE,
      filter(from, to) {
        signal.throwIfAborted();
        const stat = lstatSync(from);
        count++;
        bytes += stat.isFile() ? stat.size : 0;
        if (count > 100000 || bytes > 512 * 1024 * 1024 || Date.now() > deadline) {
          throw new Error('Installed dependency copy exceeds verification setup limits');
        }
        if (stat.isSymbolicLink()) links.push({ source: from, target: to });
        return true;
      },
    });
  }
  for (const link of links) {
    signal.throwIfAborted();
    const sourceTarget = realpathSync(link.source);
    const rel = relative(cwd, sourceTarget);
    if (rel.startsWith('..') || isAbsolute(rel))
      throw new Error('Dependency link points outside the captured workspace');
    const target = resolve(destination, rel);
    if (!existsSync(target))
      throw new Error('Dependency link target missing from verification snapshot');
    unlinkSync(link.target);
    symlinkSync(target, link.target, statSync(sourceTarget).isDirectory() ? 'junction' : 'file');
  }
}
