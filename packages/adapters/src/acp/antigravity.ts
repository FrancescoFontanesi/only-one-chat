// Antigravity's own CLI, for what its ACP server does not say (ADR 0023): the
// models (`agy models`) and the usage windows (`agy -p /quota`). Both are
// answered by agy itself, with no model turn and no quota; the login stays
// inside agy, as with Codex's account/rateLimits/read. Never a credential file.

import { spawn } from 'node:child_process';
import { withoutApiKeys } from '../environment.js';
import type { QuotaWindow } from '../usage.js';

export interface AgyOptions {
  readonly executable: string;
  /** Arguments before agy's own: the fake CLI's script in tests. */
  readonly launcherArgs?: readonly string[];
  readonly baseEnv?: NodeJS.ProcessEnv;
  readonly cwd?: string;
  readonly timeoutMs?: number;
}

/** Runs agy and returns what it printed; fails on a non-zero exit. */
export function runAgy(options: AgyOptions, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    // No shell: `/quota` reaches agy as written (Git Bash would turn it into a path).
    const child = spawn(options.executable, [...(options.launcherArgs ?? []), ...args], {
      ...(options.cwd ? { cwd: options.cwd } : {}),
      env: withoutApiKeys(options.baseEnv ?? process.env),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let out = '';
    let err = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (out += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (err += chunk));
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`agy ${args.join(' ')} timed out`));
    }, options.timeoutMs ?? 30_000);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else
        reject(
          new Error(`agy ${args[0] ?? ''} failed (${String(code)}): ${err.trim().slice(0, 300)}`),
        );
    });
  });
}

/** The first agy that answers `/quota` in print mode with no turn (its changelog, 1.1.11). */
const QUOTA_SINCE = [1, 1, 11] as const;

/** Whether `agy --version` names a version that answers `/quota` by itself. */
export function answersQuota(version: string): boolean {
  const parts = /(\d+)\.(\d+)\.(\d+)/.exec(version)?.slice(1).map(Number);
  if (!parts) return false;
  for (let i = 0; i < 3; i++) {
    const have = parts[i] ?? 0;
    const need = QUOTA_SINCE[i] ?? 0;
    if (have !== need) return have > need;
  }
  return true;
}

/** One group of models that share their limits, e.g. "Gemini Models". */
export interface AntigravityQuotaGroup {
  readonly name: string;
  readonly windows: readonly QuotaWindow[];
}

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The groups of `/quota`'s JSON payload (`command.data`), as usage windows. */
export function antigravityQuota(data: unknown): AntigravityQuotaGroup[] {
  if (!isRecord(data) || !Array.isArray(data['groups'])) return [];
  return data['groups'].filter(isRecord).map((group) => ({
    name: typeof group['name'] === 'string' ? group['name'] : '',
    windows: (Array.isArray(group['buckets']) ? group['buckets'] : [])
      .filter(isRecord)
      .flatMap((bucket): QuotaWindow[] => {
        const window = bucket['window'];
        const remaining = bucket['remaining_fraction'];
        if ((window !== '5h' && window !== 'weekly') || typeof remaining !== 'number') return [];
        const reset =
          typeof bucket['reset_time'] === 'string' ? Date.parse(bucket['reset_time']) : NaN;
        return [
          {
            name: window,
            usedPercent: Math.max(0, Math.min(100, (1 - remaining) * 100)),
            resetsAt: Number.isFinite(reset) ? Math.round(reset / 1000) : null,
          },
        ];
      }),
  }));
}

/**
 * Antigravity's usage windows, by group. Asked only of an agy that answers
 * `/quota` by itself, and checked: an answer that took a model turn is an
 * error, never taken for the usage.
 */
export async function readAntigravityQuota(options: AgyOptions): Promise<AntigravityQuotaGroup[]> {
  const version = await runAgy(options, ['--version']);
  if (!answersQuota(version)) {
    throw new Error(`agy ${version.trim()} non riporta la quota senza un turno (serve 1.1.11)`);
  }
  const out = await runAgy(options, ['-p', '/quota', '--output-format', 'json']);
  const payload = JSON.parse(out) as unknown;
  if (!isRecord(payload) || payload['num_turns'] !== 0 || !isRecord(payload['command'])) {
    throw new Error('agy non ha risposto a /quota da sé');
  }
  return antigravityQuota(payload['command']['data']);
}
