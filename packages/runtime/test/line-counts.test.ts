import { describe, expect, it } from 'vitest';
import { lineCounts } from '../src/line-counts.js';

describe('line counts', () => {
  it('counts the lines added and removed', () => {
    expect(lineCounts('a\nb\nc', 'a\nB\nc\nd')).toEqual({ added: 2, removed: 1 });
    expect(lineCounts('', 'x\ny')).toEqual({ added: 2, removed: 0 });
    expect(lineCounts('x\r\ny', 'x\ny')).toEqual({ added: 0, removed: 0 });
  });
});
