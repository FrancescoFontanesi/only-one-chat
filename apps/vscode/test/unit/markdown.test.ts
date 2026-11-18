// The agents' Markdown, parsed into blocks and inline parts (webview/markdown.tsx).

import { describe, expect, it } from 'vitest';
import { parseBlocks, parseInline } from '../../webview/markdownModel.js';

describe('markdown of the agents', () => {
  it('reads the blocks the CLIs write', () => {
    const text = [
      '## Piano',
      'Primo paragrafo',
      'che continua.',
      '',
      '- uno',
      '  - due, più a destra',
      '1. primo',
      '',
      '```python',
      'print("<b>")',
      '```',
      '> citato',
      '| A | B |',
      '| --- | :-: |',
      '| 1 | 2 |',
      '---',
    ].join('\n');
    expect(parseBlocks(text)).toEqual([
      { kind: 'heading', level: 2, text: 'Piano' },
      { kind: 'p', text: 'Primo paragrafo\nche continua.' },
      {
        kind: 'list',
        items: [
          { depth: 0, marker: '–', text: 'uno' },
          { depth: 1, marker: '–', text: 'due, più a destra' },
          { depth: 0, marker: '1.', text: 'primo' },
        ],
      },
      { kind: 'code', lang: 'python', text: 'print("<b>")' },
      { kind: 'quote', text: 'citato' },
      { kind: 'table', head: ['A', 'B'], rows: [['1', '2']] },
      { kind: 'rule' },
    ]);
  });

  it('draws a fence still streaming as code to the end', () => {
    expect(parseBlocks('Ecco:\n```ts\nconst a = 1;')).toEqual([
      { kind: 'p', text: 'Ecco:' },
      { kind: 'code', lang: 'ts', text: 'const a = 1;' },
    ]);
  });

  it('reads code, emphasis and links, and leaves snake_case and HTML as text', () => {
    expect(
      parseInline('Usa `a*b*c` e **molto** *poco* [doc](https://x.y) in snake_case_name'),
    ).toEqual([
      { kind: 'text', text: 'Usa ' },
      { kind: 'code', text: 'a*b*c' },
      { kind: 'text', text: ' e ' },
      { kind: 'strong', children: [{ kind: 'text', text: 'molto' }] },
      { kind: 'text', text: ' ' },
      { kind: 'em', children: [{ kind: 'text', text: 'poco' }] },
      { kind: 'text', text: ' ' },
      { kind: 'link', text: 'doc', url: 'https://x.y' },
      { kind: 'text', text: ' in snake_case_name' },
    ]);
    expect(parseInline('<img src=x onerror=alert(1)>')).toEqual([
      { kind: 'text', text: '<img src=x onerror=alert(1)>' },
    ]);
    expect(parseInline('2 * 3 * 4')).toEqual([{ kind: 'text', text: '2 * 3 * 4' }]);
  });

  it('reads LaTeX inline and in blocks, and leaves prices and escaped dollars as text', () => {
    expect(parseInline('Filtri a $\\sigma \\in \\{0.8, 1.6\\}$ e \\(a_i\\)')).toEqual([
      { kind: 'text', text: 'Filtri a ' },
      { kind: 'math', tex: '\\sigma \\in \\{0.8, 1.6\\}', display: false },
      { kind: 'text', text: ' e ' },
      { kind: 'math', tex: 'a_i', display: false },
    ]);
    expect(parseInline('Costa $5 e poi $10.')).toEqual([
      { kind: 'text', text: 'Costa $5 e poi $10.' },
    ]);
    expect(parseInline('Non è \\$x\\$ né $ x $')).toEqual([
      { kind: 'text', text: 'Non è \\$x\\$ né $ x $' },
    ]);
    // A formula is read before emphasis: its stars are not italics.
    expect(parseInline('$a*b*c$')).toEqual([{ kind: 'math', tex: 'a*b*c', display: false }]);
    expect(parseBlocks('Somma:\n$$\n\\sum_{i=1}^n i\n$$\n\\[ x^2 \\]')).toEqual([
      { kind: 'p', text: 'Somma:' },
      { kind: 'math', tex: '\\sum_{i=1}^n i' },
      { kind: 'math', tex: 'x^2' },
    ]);
  });
});
