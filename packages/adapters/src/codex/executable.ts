// Locates the Codex CLI to launch. Only real executables qualify: the client
// never uses a shell, so Windows script launchers (npm's codex.cmd) are refused
// with an explanation. The private binaries bundled with VS Code extensions are
// deliberately not searched.

import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { delimiter, extname, isAbsolute, join } from 'node:path';
import { AppServerError } from './app-server.js';

export interface ResolveCodexOptions {
  /** Path chosen by the user; when set, PATH is not searched. */
  readonly configuredPath?: string;
  /** Environment whose PATH is searched; defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
}

const windows = process.platform === 'win32';
const SHELL_LAUNCHERS = ['.cmd', '.bat', '.ps1'];

function notFound(message: string): AppServerError {
  return new AppServerError('not-found', message);
}

function shimMessage(path: string): string {
  return (
    `${path} is a script launcher that only runs through a shell, which this client ` +
    'never uses. Configure the absolute path of the native codex executable instead.'
  );
}

async function isExecutableFile(path: string): Promise<boolean> {
  try {
    if (!(await stat(path)).isFile()) return false;
    if (!windows) await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function resolveCodexExecutable(options: ResolveCodexOptions = {}): Promise<string> {
  const { configuredPath, env = process.env } = options;

  if (configuredPath) {
    if (!isAbsolute(configuredPath)) {
      throw notFound(`The configured Codex path must be absolute: ${configuredPath}`);
    }
    if (windows && SHELL_LAUNCHERS.includes(extname(configuredPath).toLowerCase())) {
      throw notFound(shimMessage(configuredPath));
    }
    if (!(await isExecutableFile(configuredPath))) {
      throw notFound(`No executable Codex binary at ${configuredPath}`);
    }
    return configuredPath;
  }

  // Windows environment blocks are case-insensitive, plain copies of them are not.
  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === 'PATH');
  const dirs = (pathKey ? (env[pathKey] ?? '') : '')
    .split(delimiter)
    .map((dir) => dir.replace(/^"(.*)"$/, '$1'))
    .filter(Boolean);

  let shim: string | undefined;
  for (const dir of dirs) {
    const candidate = join(dir, windows ? 'codex.exe' : 'codex');
    if (await isExecutableFile(candidate)) return candidate;
    if (windows && !shim) {
      for (const ext of SHELL_LAUNCHERS) {
        if (await isExecutableFile(join(dir, `codex${ext}`))) {
          shim = join(dir, `codex${ext}`);
          break;
        }
      }
    }
  }
  throw notFound(
    shim
      ? shimMessage(shim)
      : 'Codex CLI not found on PATH. Install it or configure the path of the codex executable.',
  );
}
