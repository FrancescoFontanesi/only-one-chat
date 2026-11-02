// The models each CLI offers, read through its own protocol with no model
// turn and no quota: Codex `model/list` over app-server, Claude Code the
// `initialize` control request of stream-json input, answered before any user
// message. Only the model fields are kept: the same Claude response carries
// account data, which is never read.

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { withoutApiKeys } from './environment.js';
import { connectCodex } from './codex/session.js';

export interface ModelInfo {
  /** What the CLI takes as its model: a Codex model id, a Claude alias or id. */
  readonly id: string;
  readonly name: string;
  /** Reasoning levels the model supports; empty: none. */
  readonly efforts: readonly string[];
  readonly defaultEffort: string | null;
  /** The CLI's own default model. */
  readonly isDefault: boolean;
}

type Json = Record<string, unknown>;

const isRecord = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

/** The visible models of one `model/list` page. */
export function codexModels(result: unknown): ModelInfo[] {
  const data = isRecord(result) && Array.isArray(result['data']) ? result['data'] : [];
  return data.flatMap((entry): ModelInfo[] => {
    if (!isRecord(entry) || entry['hidden'] === true) return [];
    const id = entry['id'];
    if (typeof id !== 'string' || id === '') return [];
    const efforts = Array.isArray(entry['supportedReasoningEfforts'])
      ? entry['supportedReasoningEfforts'].flatMap((e) =>
          isRecord(e) && typeof e['reasoningEffort'] === 'string' ? [e['reasoningEffort']] : [],
        )
      : [];
    const name = entry['displayName'];
    const defaultEffort = entry['defaultReasoningEffort'];
    return [
      {
        id,
        name: typeof name === 'string' && name !== '' ? name : id,
        efforts,
        defaultEffort: typeof defaultEffort === 'string' ? defaultEffort : null,
        isDefault: entry['isDefault'] === true,
      },
    ];
  });
}

export interface ListModelsOptions {
  readonly executable: string;
  /** Arguments before the CLI's own: the fake CLIs' scripts in tests. */
  readonly launcherArgs?: readonly string[];
  readonly baseEnv?: NodeJS.ProcessEnv;
  readonly cwd?: string;
  readonly timeoutMs?: number;
}

/** Codex's models, page by page. */
export async function listCodexModels(options: ListModelsOptions): Promise<ModelInfo[]> {
  const session = await connectCodex({
    executable: options.executable,
    launcherArgs: options.launcherArgs ?? [],
    ...(options.baseEnv ? { baseEnv: options.baseEnv } : {}),
    clientInfo: { name: 'only-one-chat', version: '0.0.1' },
  });
  try {
    const models: ModelInfo[] = [];
    let cursor: string | null = null;
    // A bound on the pages, in case a cursor never ends.
    for (let page = 0; page < 20; page++) {
      const result: unknown = await session.request(
        'model/list',
        cursor === null ? {} : { cursor },
      );
      models.push(...codexModels(result));
      const next = isRecord(result) ? result['nextCursor'] : null;
      if (typeof next !== 'string' || next === '') break;
      cursor = next;
    }
    return models;
  } finally {
    await session.close();
  }
}

/** The models of Claude's `initialize` response; `default` only names another one. */
export function claudeModels(response: unknown): ModelInfo[] {
  const models = isRecord(response) && Array.isArray(response['models']) ? response['models'] : [];
  return models.flatMap((entry): ModelInfo[] => {
    if (!isRecord(entry)) return [];
    const id = entry['value'];
    if (typeof id !== 'string' || id === '' || id === 'default') return [];
    const name = entry['displayName'];
    return [
      {
        id,
        name: typeof name === 'string' && name !== '' ? name : id,
        efforts: entry['supportsEffort'] === true ? strings(entry['supportedEffortLevels']) : [],
        defaultEffort: null,
        isDefault: false,
      },
    ];
  });
}

const INITIALIZE_ID = 'ooc-models';

/** Claude Code's models: one `initialize` control request, then stdin closes, no turn. */
export function listClaudeModels(options: ListModelsOptions): Promise<ModelInfo[]> {
  const child = spawn(
    options.executable,
    [
      ...(options.launcherArgs ?? []),
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
    ],
    {
      ...(options.cwd ? { cwd: options.cwd } : {}),
      env: withoutApiKeys(options.baseEnv ?? process.env),
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true,
    },
  );
  return new Promise<ModelInfo[]>((resolve, reject) => {
    const timer = setTimeout(() => {
      finish(() => {
        reject(new Error('Claude did not list its models in time'));
      });
    }, options.timeoutMs ?? 30_000);
    let settled = false;
    const finish = (outcome: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdin.end();
      if (child.exitCode === null) setTimeout(() => child.kill(), 5_000).unref();
      outcome();
    };
    child.once('error', (error) => {
      finish(() => {
        reject(new Error(`Cannot run Claude: ${error.message}`));
      });
    });
    child.once('close', () => {
      finish(() => {
        reject(new Error('Claude closed before listing its models'));
      });
    });
    child.stdin.on('error', () => undefined);
    createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', (line) => {
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (!isRecord(message) || message['type'] !== 'control_response') return;
      const response = message['response'];
      if (!isRecord(response) || response['request_id'] !== INITIALIZE_ID) return;
      if (response['subtype'] !== 'success') {
        const error = response['error'];
        finish(() => {
          reject(new Error(`Claude refused to list its models: ${String(error)}`));
        });
        return;
      }
      const models = claudeModels(response['response']);
      finish(() => {
        resolve(models);
      });
    });
    child.stdin.write(
      `${JSON.stringify({
        type: 'control_request',
        request_id: INITIALIZE_ID,
        request: { subtype: 'initialize' },
      })}\n`,
    );
  });
}
