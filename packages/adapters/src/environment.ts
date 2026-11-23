// Environment for the CLIs the adapters launch: the user's own, minus the
// variables that would make a CLI bill an API key instead of the user's
// subscription. Base URLs and proxies pass on purpose: the user's local tools
// (Headroom, for example) depend on them. See docs/decisions/0006.

import { realpathSync } from 'node:fs';

/** Removed from every child environment, whatever their case. */
export const API_KEY_VARIABLES: readonly string[] = [
  'OPENAI_API_KEY',
  'CODEX_API_KEY',
  'CODEX_ACCESS_TOKEN',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
];

const KEYS = new Set(API_KEY_VARIABLES);

export function withoutApiKeys(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && !KEYS.has(name.toUpperCase())) out[name] = value;
  }
  return out;
}

/** Looks a variable up the way Windows does, ignoring case. */
export function getEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const key = Object.keys(env).find((candidate) => candidate.toUpperCase() === name.toUpperCase());
  return key === undefined ? undefined : env[key];
}

/**
 * The long form of a folder, as the CLIs' own permission checks compare paths:
 * a Windows short (8.3) name is not recognized as inside the working directory
 * (ADR 0046). The path as given when it cannot be resolved.
 */
export function longPath(cwd: string): string {
  try {
    return realpathSync.native(cwd);
  } catch {
    return cwd;
  }
}
