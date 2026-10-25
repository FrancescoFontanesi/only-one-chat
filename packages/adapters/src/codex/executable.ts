// Locates the Codex CLI to launch; rules in src/executable.ts.

import { AppServerError } from './app-server.js';
import { resolveNativeExecutable, type ResolveExecutableOptions } from '../executable.js';

export type ResolveCodexOptions = ResolveExecutableOptions;

export async function resolveCodexExecutable(options: ResolveCodexOptions = {}): Promise<string> {
  try {
    return await resolveNativeExecutable('codex', 'Codex', options);
  } catch (error) {
    throw new AppServerError('not-found', error instanceof Error ? error.message : String(error));
  }
}
