// Token usage and subscription quota as the CLIs report them, in one shape for
// both providers (runtime: TurnUsage, QuotaSnapshot). Token counts are the
// providers' own and are not comparable across them (different tokenizers):
// they are kept per model. `reasoning` is part of `output` for both.

export interface TokenUsage {
  /** Input tokens not read from the cache. */
  readonly input: number;
  /** Input tokens read from the cache. */
  readonly cachedInput: number;
  /** Input tokens written to the cache (Claude; Codex reports 0). */
  readonly cacheWrite: number;
  readonly output: number;
  /** Reasoning or thinking tokens, included in `output`. */
  readonly reasoning: number;
}

export interface TurnUsage {
  /** This turn only, sub-agents included, by the model id the CLI reported. */
  readonly byModel: Readonly<Record<string, TokenUsage>>;
  /** Nominal cost the CLI reports (Claude's list price); null when it reports none. */
  readonly costUsd: number | null;
  /** Wall time of the turn, as measured by the adapter. */
  readonly durationMs: number;
}

export interface QuotaWindow {
  /** "5h" or "weekly". */
  readonly name: string;
  /** 0–100, as precise as the CLI reports it (Codex: whole percent). */
  readonly usedPercent: number;
  /** Unix seconds; null when not reported. */
  readonly resetsAt: number | null;
}

/** The latest subscription usage the CLI reported during the turn. */
export interface QuotaSnapshot {
  readonly windows: readonly QuotaWindow[];
}

export const NO_TOKENS: TokenUsage = {
  input: 0,
  cachedInput: 0,
  cacheWrite: 0,
  output: 0,
  reasoning: 0,
};

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export function addTokens(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    input: a.input + b.input,
    cachedInput: a.cachedInput + b.cachedInput,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    output: a.output + b.output,
    reasoning: a.reasoning + b.reasoning,
  };
}

export function subtractTokens(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    input: a.input - b.input,
    cachedInput: a.cachedInput - b.cachedInput,
    cacheWrite: a.cacheWrite - b.cacheWrite,
    output: a.output - b.output,
    reasoning: a.reasoning - b.reasoning,
  };
}

/**
 * A Codex `tokenUsage.total` (thread/tokenUsage/updated): cumulative for the
 * thread; `inputTokens` includes the cached ones.
 */
export function codexTokens(total: unknown): TokenUsage {
  const t = isRecord(total) ? total : {};
  const cached = count(t['cachedInputTokens']);
  return {
    input: count(t['inputTokens']) - cached,
    cachedInput: cached,
    cacheWrite: count(t['cacheWriteInputTokens']),
    output: count(t['outputTokens']),
    reasoning: count(t['reasoningOutputTokens']),
  };
}

const CODEX_WINDOWS: Readonly<Record<string, string>> = { primary: '5h', secondary: 'weekly' };

/** Codex `rateLimits` (account/rateLimits/read or /updated): whole percents. */
export function codexQuota(rateLimits: unknown): QuotaSnapshot | null {
  if (!isRecord(rateLimits)) return null;
  const windows: QuotaWindow[] = [];
  for (const [key, name] of Object.entries(CODEX_WINDOWS)) {
    const window = rateLimits[key];
    if (!isRecord(window) || typeof window['usedPercent'] !== 'number') continue;
    windows.push({
      name,
      usedPercent: window['usedPercent'],
      resetsAt: typeof window['resetsAt'] === 'number' ? window['resetsAt'] : null,
    });
  }
  return windows.length > 0 ? { windows } : null;
}

/** Claude `result.modelUsage`: this turn, every model it used (sub-agents included). */
export function claudeUsage(modelUsage: unknown): Record<string, TokenUsage> {
  const out: Record<string, TokenUsage> = {};
  if (!isRecord(modelUsage)) return out;
  for (const [model, usage] of Object.entries(modelUsage)) {
    if (!isRecord(usage)) continue;
    out[model] = {
      input: count(usage['inputTokens']),
      cachedInput: count(usage['cacheReadInputTokens']),
      cacheWrite: count(usage['cacheCreationInputTokens']),
      output: count(usage['outputTokens']),
      reasoning: count(usage['thinkingTokens']),
    };
  }
  return out;
}

const CLAUDE_WINDOWS: Readonly<Record<string, string>> = { five_hour: '5h', seven_day: 'weekly' };

/** Claude `rate_limit_event.rate_limit_info`: utilization 0–1 per window. */
export function claudeQuota(info: unknown): QuotaSnapshot | null {
  if (!isRecord(info) || !isRecord(info['unifiedWindows'])) return null;
  const windows: QuotaWindow[] = [];
  for (const [key, name] of Object.entries(CLAUDE_WINDOWS)) {
    const window = info['unifiedWindows'][key];
    if (!isRecord(window) || typeof window['utilization'] !== 'number') continue;
    windows.push({
      name,
      usedPercent: Math.round(window['utilization'] * 10_000) / 100,
      resetsAt: typeof window['resetsAt'] === 'number' ? window['resetsAt'] : null,
    });
  }
  return windows.length > 0 ? { windows } : null;
}
