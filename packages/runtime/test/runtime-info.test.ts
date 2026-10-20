import { describe, expect, it } from 'vitest';
import { getRuntimeInfo } from '../src/index.js';
import pkg from '../package.json' with { type: 'json' };

describe('getRuntimeInfo', () => {
  it('reports the package identity from package.json', () => {
    expect(getRuntimeInfo()).toEqual({ name: '@agent-workspace/runtime', version: pkg.version });
  });

  it('returns a fresh object on every call', () => {
    expect(getRuntimeInfo()).not.toBe(getRuntimeInfo());
  });
});
