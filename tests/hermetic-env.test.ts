import { expect, it } from 'vitest';
import { dropped } from './hermetic-env.js';

it('strips credential, proxy and agent-session variables from the worker env', () => {
  expect(Object.keys(process.env).filter(dropped)).toEqual([]);
  expect(['ANTHROPIC_BASE_URL', 'claudecode', 'https_proxy', 'CODEX_HOME'].every(dropped)).toBe(
    true,
  );
  expect(['CODEX_EXECUTABLE', 'PATH', 'GOOGLE'].some(dropped)).toBe(false);
});
