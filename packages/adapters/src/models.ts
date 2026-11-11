// The models and skills each CLI offers, read through its own protocol with
// no model turn and no quota: Codex `model/list` and `skills/list` over
// app-server, Claude Code the `initialize` control request of stream-json
// input, answered before any user message. Only the model and command fields
// are kept: the same Claude response carries account data, which is never read.

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { withoutApiKeys } from './environment.js';
import { connectCodex } from './codex/session.js';
import { runAgy } from './acp/antigravity.js';

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

/** A skill of a CLI (ADR 0019): what the composer lists after `$`. */
export interface SkillInfo {
  readonly name: string;
  readonly description: string;
  /** Its SKILL.md, where the CLI needs it to invoke the skill (Codex). */
  readonly path?: string;
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

/**
 * The skills among Claude Code's commands: those it loaded from a skill
 * folder, which it tags at the end of their description, `(user)`,
 * `(project)`, `(plugin:…)`, `(managed)` or `(claude.ai sync)`. Its own
 * commands (`clear`, `compact`, `model`…) carry no tag and are left out.
 */
export function claudeSkills(response: unknown): SkillInfo[] {
  const commands =
    isRecord(response) && Array.isArray(response['commands']) ? response['commands'] : [];
  const tagged = /\s*\((user|project|managed|plugin[^()]*|claude\.ai sync)\)\s*$/;
  return commands.flatMap((entry): SkillInfo[] => {
    if (!isRecord(entry)) return [];
    const name = entry['name'];
    const description = entry['description'];
    if (typeof name !== 'string' || name === '' || typeof description !== 'string') return [];
    if (!tagged.test(description)) return [];
    return [{ name, description: description.replace(tagged, '') }];
  });
}

/** Claude Code's models: one `initialize` control request, then stdin closes, no turn. */
export async function listClaudeModels(options: ListModelsOptions): Promise<ModelInfo[]> {
  return claudeModels(await claudeInitialize(options));
}

/** Claude Code's skills, from the same request; `cwd` decides the project's own ones. */
export async function listClaudeSkills(options: ListModelsOptions): Promise<SkillInfo[]> {
  return claudeSkills(await claudeInitialize(options));
}

/** The `initialize` control response of Claude Code: no turn, no quota. */
function claudeInitialize(options: ListModelsOptions): Promise<unknown> {
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
  return new Promise<unknown>((resolve, reject) => {
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
      finish(() => {
        resolve(response['response']);
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

/** The enabled skills of one `skills/list` response, for the first folder it lists. */
export function codexSkills(result: unknown): SkillInfo[] {
  const data = isRecord(result) && Array.isArray(result['data']) ? result['data'] : [];
  const entry: unknown = data[0];
  const skills = isRecord(entry) && Array.isArray(entry['skills']) ? entry['skills'] : [];
  return skills.flatMap((skill): SkillInfo[] => {
    if (!isRecord(skill) || skill['enabled'] === false) return [];
    const { name, description, path } = skill;
    if (typeof name !== 'string' || name === '' || typeof path !== 'string') return [];
    const short = skill['shortDescription'];
    return [
      {
        name,
        description:
          typeof short === 'string' && short !== ''
            ? short
            : typeof description === 'string'
              ? description
              : '',
        path,
      },
    ];
  });
}

/** Codex's skills for a folder: `skills/list` over app-server, no turn. */
export async function listCodexSkills(
  options: ListModelsOptions & { readonly cwd: string },
): Promise<SkillInfo[]> {
  const session = await connectCodex({
    executable: options.executable,
    launcherArgs: options.launcherArgs ?? [],
    ...(options.baseEnv ? { baseEnv: options.baseEnv } : {}),
    clientInfo: { name: 'only-one-chat', version: '0.0.1' },
  });
  try {
    return codexSkills(await session.request('skills/list', { cwds: [options.cwd] }));
  } finally {
    await session.close();
  }
}

const LEVELS = ['low', 'medium', 'high'] as const;
const LEVEL_ID = /^(.+)-(low|medium|high)$/;
const LEVEL_NAME = /^(.+?)\s*\((low|medium|high)\)$/i;

/** An Antigravity model id split into the model and its level: `gemini-3.8-flash-low`. */
export function antigravityLevel(id: string): { model: string; effort: string } | null {
  const match = LEVEL_ID.exec(id);
  return match?.[1] && match[2] ? { model: match[1], effort: match[2] } : null;
}

/** The id `agy` takes: the model with its level, as `agy models` lists it. */
export function antigravityModelId(model: string, effort: string): string {
  return effort ? `${model}-${effort}` : model;
}

/**
 * Antigravity's models, from `agy models`: one `id<TAB>name` line each, no
 * turn. An id with its level (`gemini-3.8-flash-low`, "Gemini 3.8 Flash
 * (Low)") is one level of a model, so the levels are shown as reasoning
 * (ADR 0023); `antigravityModelId` puts them back together.
 */
export function antigravityModels(output: string): ModelInfo[] {
  const models = new Map<string, { id: string; name: string; efforts: string[] }>();
  for (const line of output.split(/\r?\n/)) {
    const [rawId, rawName] = line.split('\t');
    const id = rawId?.trim() ?? '';
    const name = rawName?.trim() ?? '';
    if (!id || !name || /\s/.test(id)) continue;
    const level = antigravityLevel(id);
    const named = LEVEL_NAME.exec(name);
    const key = level && named?.[1] ? level.model : id;
    const entry = models.get(key) ?? {
      id: key,
      name: named?.[1] && level ? named[1] : name,
      efforts: [],
    };
    if (level && named) entry.efforts.push(level.effort);
    models.set(key, entry);
  }
  return [...models.values()].map(({ id, name, efforts }) => {
    const ordered = LEVELS.filter((l) => efforts.includes(l));
    return {
      id,
      name,
      efforts: ordered,
      defaultEffort: ordered.includes('medium') ? 'medium' : (ordered[0] ?? null),
      isDefault: false,
    };
  });
}

export async function listAntigravityModels(options: ListModelsOptions): Promise<ModelInfo[]> {
  const models = antigravityModels(await runAgy(options, ['models']));
  if (models.length === 0) throw new Error('agy models listed no model');
  return models;
}
