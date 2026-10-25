// Locates the Claude Code CLI to launch; rules in src/executable.ts (native
// claude.exe only, never npm shims or binaries bundled in other products).

import { resolveNativeExecutable, type ResolveExecutableOptions } from '../executable.js';

export function resolveClaudeExecutable(options: ResolveExecutableOptions = {}): Promise<string> {
  return resolveNativeExecutable('claude', 'Claude Code', options);
}
