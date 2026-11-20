import type { Readable } from 'node:stream';

/**
 * Calls `onLine` for each line of a JSONL stream, split on "\n" only. Not
 * readline: it also splits on U+2028 and U+2029, which JSON leaves unescaped
 * inside strings, and so cuts a valid message in pieces.
 */
export function onJsonLines(stream: Readable, onLine: (line: string) => void): void {
  let rest = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk: string) => {
    const parts = (rest + chunk).split('\n');
    rest = parts.pop() ?? '';
    for (const part of parts) onLine(part.endsWith('\r') ? part.slice(0, -1) : part);
  });
  stream.on('end', () => {
    if (rest !== '') onLine(rest);
  });
}
