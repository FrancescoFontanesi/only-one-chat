import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppServerError, resolveCodexExecutable } from '../src/index.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'codex resolve '));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function file(name: string, executable = true): string {
  const path = join(dir, name);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, '');
  if (executable && process.platform !== 'win32') chmodSync(path, 0o755);
  return path;
}

async function failure(promise: Promise<unknown>): Promise<AppServerError> {
  const error: unknown = await promise.then(
    () => {
      throw new Error('expected the promise to reject');
    },
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(AppServerError);
  return error as AppServerError;
}

const exe = process.platform === 'win32' ? 'codex.exe' : 'codex';

describe('configured path', () => {
  it('accepts an absolute path to an existing file, spaces included', async () => {
    const path = file(join('my tools', exe));
    expect(await resolveCodexExecutable({ configuredPath: path, env: {} })).toBe(path);
  });

  it('rejects a path that does not exist', async () => {
    const error = await failure(
      resolveCodexExecutable({ configuredPath: join(dir, exe), env: {} }),
    );
    expect(error.kind).toBe('not-found');
  });

  it('rejects a relative path, which would depend on the current directory', async () => {
    const error = await failure(resolveCodexExecutable({ configuredPath: exe, env: {} }));
    expect(error.kind).toBe('not-found');
  });

  it('rejects a directory', async () => {
    const error = await failure(resolveCodexExecutable({ configuredPath: dir, env: {} }));
    expect(error.kind).toBe('not-found');
  });

  it.runIf(process.platform === 'win32')(
    'rejects .cmd shims, which cannot be started without a shell',
    async () => {
      const error = await failure(
        resolveCodexExecutable({ configuredPath: file('codex.cmd'), env: {} }),
      );
      expect(error.kind).toBe('not-found');
      expect(error.message).toContain('shell');
    },
  );

  it.runIf(process.platform !== 'win32')('rejects a file without execute permission', async () => {
    const error = await failure(
      resolveCodexExecutable({ configuredPath: file('codex', false), env: {} }),
    );
    expect(error.kind).toBe('not-found');
  });
});

describe('PATH lookup', () => {
  // Windows environment blocks are case-insensitive; a copied env keeps the original `Path` key.
  const pathKey = process.platform === 'win32' ? 'Path' : 'PATH';

  it('finds codex in a PATH directory', async () => {
    const empty = join(dir, 'empty dir');
    mkdirSync(empty);
    const found = file(join('bin dir', exe));
    const env = {
      [pathKey]: [empty, join(dir, 'bin dir')].join(process.platform === 'win32' ? ';' : ':'),
    };
    expect(await resolveCodexExecutable({ env })).toBe(found);
  });

  it('reports not-found when codex is nowhere on PATH', async () => {
    const error = await failure(resolveCodexExecutable({ env: { [pathKey]: dir } }));
    expect(error.kind).toBe('not-found');
  });

  it.runIf(process.platform === 'win32')(
    'explains how to configure the native binary when only an npm shim is on PATH',
    async () => {
      const shim = file('codex.cmd');
      const error = await failure(resolveCodexExecutable({ env: { Path: dir } }));
      expect(error.kind).toBe('not-found');
      expect(error.message).toContain(shim);
    },
  );
});
