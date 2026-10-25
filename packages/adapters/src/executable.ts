// Locates a native CLI executable to launch (codex, claude). Only real
// executables qualify: the adapters never use a shell, so Windows script
// launchers (npm's .cmd shims, .bat, .ps1) are refused with an explanation.
// The private binaries bundled with VS Code extensions or desktop apps are
// deliberately not searched.

import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { delimiter, extname, isAbsolute, join } from 'node:path';

export interface ResolveExecutableOptions {
  /** Path chosen by the user; when set, PATH is not searched. */
  readonly configuredPath?: string;
  /** Environment whose PATH is searched; defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
}

export class ExecutableNotFoundError extends Error {
  override readonly name = 'ExecutableNotFoundError';
}

const windows = process.platform === 'win32';
const SHELL_LAUNCHERS = ['.cmd', '.bat', '.ps1'];

function shimMessage(path: string, label: string): string {
  return (
    `${path} is a script launcher that only runs through a shell, which this client ` +
    `never uses. Configure the absolute path of the native ${label} executable instead.`
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

/**
 * Resolves `command` (`codex`, `claude`): the configured path if any, otherwise
 * `<command>.exe` (Windows) or `<command>` (POSIX) on PATH.
 */
export async function resolveNativeExecutable(
  command: string,
  label: string,
  options: ResolveExecutableOptions = {},
): Promise<string> {
  const { configuredPath, env = process.env } = options;
  const notFound = (message: string) => new ExecutableNotFoundError(message);

  if (configuredPath) {
    if (!isAbsolute(configuredPath)) {
      throw notFound(`The configured ${label} path must be absolute: ${configuredPath}`);
    }
    if (windows && SHELL_LAUNCHERS.includes(extname(configuredPath).toLowerCase())) {
      throw notFound(shimMessage(configuredPath, label));
    }
    if (!(await isExecutableFile(configuredPath))) {
      throw notFound(`No executable ${label} binary at ${configuredPath}`);
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
    const candidate = join(dir, windows ? `${command}.exe` : command);
    if (await isExecutableFile(candidate)) return candidate;
    if (windows && !shim) {
      for (const ext of SHELL_LAUNCHERS) {
        if (await isExecutableFile(join(dir, `${command}${ext}`))) {
          shim = join(dir, `${command}${ext}`);
          break;
        }
      }
    }
  }
  throw notFound(
    shim
      ? shimMessage(shim, label)
      : `${label} CLI not found on PATH. Install it or configure the path of the ${command} executable.`,
  );
}
