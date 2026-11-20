import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { onJsonLines } from '../src/lines.js';

describe('onJsonLines', () => {
  it('splits on newlines only, across chunks and multi-byte characters', async () => {
    const stream = new PassThrough();
    const lines: string[] = [];
    onJsonLines(stream, (line) => lines.push(line));
    const message = JSON.stringify({ text: 'a b c → é' });
    const bytes = Buffer.from(`${message}\r\n{"n":2}\n{"n":`);
    // Cut inside the "→": the decoder must join its bytes again.
    const cut = bytes.indexOf(Buffer.from('→')) + 1;
    stream.write(bytes.subarray(0, cut));
    stream.write(bytes.subarray(cut));
    stream.end('3}');
    await new Promise((resolve) => stream.on('end', resolve));
    expect(lines).toEqual([message, '{"n":2}', '{"n":3}']);
    expect(JSON.parse(lines[0] ?? '')).toEqual({ text: 'a b c → é' });
  });
});
