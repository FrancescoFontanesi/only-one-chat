// Token usage and quota as the real CLIs report them (recorded fixtures).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { claudeQuota, claudeUsage, codexQuota, codexTokens } from '../src/usage.js';

const FIXTURES = join(import.meta.dirname, 'fixtures');

function messages(file: string): Record<string, unknown>[] {
  return readFileSync(join(FIXTURES, file), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { type: string; message?: Record<string, unknown> })
    .flatMap((entry) => (entry.type === 'message' && entry.message ? [entry.message] : []));
}

describe('Codex', () => {
  const codex = messages('codex/0.164.0/subagent-turn.jsonl');
  const params = (method: string) =>
    codex.filter((m) => m['method'] === method).map((m) => m['params'] as Record<string, unknown>);

  it('reads cumulative thread tokens, cached input apart from the rest', () => {
    const usage = params('thread/tokenUsage/updated').at(-1)?.['tokenUsage'] as Record<
      string,
      unknown
    >;
    const tokens = codexTokens(usage['total']);
    const total = usage['total'] as Record<string, number>;
    expect(tokens.cachedInput).toBe(total['cachedInputTokens']);
    expect(tokens.input + tokens.cachedInput).toBe(total['inputTokens']);
    expect(tokens.output).toBe(total['outputTokens']);
  });

  it('reads the 5h and weekly windows in whole percents', () => {
    const quota = codexQuota(params('account/rateLimits/updated').at(-1)?.['rateLimits']);
    expect(quota?.windows.map((w) => w.name)).toEqual(['5h', 'weekly']);
    expect(Number.isInteger(quota?.windows[0]?.usedPercent)).toBe(true);
  });
});

describe('Claude', () => {
  const claude = messages('claude/2.1.308/turn-subagent.jsonl');
  const result = claude.find((m) => m['type'] === 'result') ?? {};

  it('reads modelUsage per model, sub-agents included', () => {
    const usage = claudeUsage(result['modelUsage']);
    expect(Object.keys(usage)).toEqual(['claude-haiku-5-5']);
    expect(usage['claude-haiku-5-5']).toEqual({
      input: 1258,
      cachedInput: 25642,
      cacheWrite: 20290,
      output: 1245,
      reasoning: 321,
    });
  });

  it('reads the utilization of each window as a percent', () => {
    const event = claude.find((m) => m['type'] === 'rate_limit_event') ?? {};
    expect(claudeQuota(event['rate_limit_info'])).toEqual({
      windows: [
        { name: '5h', usedPercent: 69, resetsAt: 1792975800 },
        { name: 'weekly', usedPercent: 29, resetsAt: 1793512800 },
      ],
    });
  });
});
