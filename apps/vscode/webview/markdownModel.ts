// The agents' Markdown as data (webview/markdown.tsx draws it): the blocks
// and inline parts of the subset the CLIs write. No HTML is ever read as HTML.

export type Inline =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'code'; readonly text: string }
  | { readonly kind: 'strong' | 'em'; readonly children: readonly Inline[] }
  | { readonly kind: 'link'; readonly text: string; readonly url: string }
  /** LaTeX: `$…$`, `\(…\)`, or `$$…$$` within a line. */
  | { readonly kind: 'math'; readonly tex: string; readonly display: boolean };

type Block =
  | { readonly kind: 'heading'; readonly level: number; readonly text: string }
  | { readonly kind: 'p'; readonly text: string }
  | { readonly kind: 'code'; readonly lang: string; readonly text: string }
  | { readonly kind: 'quote'; readonly text: string }
  | {
      readonly kind: 'list';
      /** `marker`: "1." counted per level, or "–"; a list may mix both. */
      readonly items: readonly {
        readonly depth: number;
        readonly marker: string;
        readonly text: string;
      }[];
    }
  | { readonly kind: 'table'; readonly head: readonly string[]; readonly rows: readonly string[][] }
  | { readonly kind: 'rule' }
  /** A LaTeX block: `$$ … $$` or `\[ … \]` on lines of their own. */
  | { readonly kind: 'math'; readonly tex: string };

/** A LaTeX block opening its line: `$$` or `\[`, maybe with the formula after it. */
const MATH_OPEN = /^\s*(\$\$|\\\[)(.*)$/;
const FENCE = /^\s*(```|~~~)\s*([\w+-]*)\s*$/;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;
const QUOTE = /^\s*>\s?(.*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

const cells = (line: string): string[] =>
  line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());

/** The blocks of a Markdown text. */
export function parseBlocks(source: string): Block[] {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const blocks: Block[] = [];
  let i = 0;
  const startsBlock = (line: string, next: string | undefined) =>
    MATH_OPEN.test(line) ||
    FENCE.test(line) ||
    HEADING.test(line) ||
    ITEM.test(line) ||
    RULE.test(line) ||
    QUOTE.test(line) ||
    (line.includes('|') && next !== undefined && TABLE_SEP.test(next));
  while (i < lines.length) {
    const line = lines[i] ?? '';
    const next = lines[i + 1];
    if (line.trim() === '') {
      i++;
      continue;
    }
    const math = MATH_OPEN.exec(line);
    if (math) {
      const close = math[1] === '$$' ? '$$' : '\\]';
      const rest = math[2] ?? '';
      // All on one line: `$$ x^2 $$`.
      if (rest.trimEnd().endsWith(close) && rest.trim() !== '') {
        blocks.push({ kind: 'math', tex: rest.trimEnd().slice(0, -close.length).trim() });
        i++;
        continue;
      }
      const body = rest.trim() === '' ? [] : [rest];
      i++;
      while (i < lines.length && !(lines[i] ?? '').trimEnd().endsWith(close))
        body.push(lines[i++] ?? '');
      if (i < lines.length) {
        const last = (lines[i] ?? '').trimEnd().slice(0, -close.length);
        if (last.trim() !== '') body.push(last);
        i++;
      }
      blocks.push({ kind: 'math', tex: body.join('\n').trim() });
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence) {
      const close = fence[1] ?? '```';
      const body: string[] = [];
      i++;
      while (i < lines.length && (lines[i] ?? '').trim() !== close) body.push(lines[i++] ?? '');
      i++;
      blocks.push({ kind: 'code', lang: fence[2] ?? '', text: body.join('\n') });
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({ kind: 'heading', level: heading[1]?.length ?? 1, text: heading[2] ?? '' });
      i++;
      continue;
    }
    if (RULE.test(line)) {
      blocks.push({ kind: 'rule' });
      i++;
      continue;
    }
    if (line.includes('|') && next !== undefined && TABLE_SEP.test(next)) {
      const head = cells(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && (lines[i] ?? '').includes('|') && (lines[i] ?? '').trim() !== '') {
        rows.push(cells(lines[i++] ?? ''));
      }
      blocks.push({ kind: 'table', head, rows });
      continue;
    }
    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i] ?? '')) {
        body.push(QUOTE.exec(lines[i++] ?? '')?.[1] ?? '');
      }
      blocks.push({ kind: 'quote', text: body.join('\n') });
      continue;
    }
    const item = ITEM.exec(line);
    if (item) {
      const base = item[1]?.length ?? 0;
      const items: { depth: number; marker: string; text: string }[] = [];
      /** The number of the last ordered item at each level. */
      const counts: number[] = [];
      while (i < lines.length) {
        const current = lines[i] ?? '';
        const match = ITEM.exec(current);
        if (match) {
          const depth = Math.max(0, Math.floor(((match[1]?.length ?? 0) - base) / 2));
          counts.length = depth + 1;
          const ordered = /\d/.test(match[2] ?? '');
          counts[depth] = ordered ? (counts[depth] ?? 0) + 1 : 0;
          items.push({
            depth,
            marker: ordered ? `${String(counts[depth])}.` : '–',
            text: match[3] ?? '',
          });
          i++;
        } else if (current.trim() !== '' && /^\s+/.test(current) && items.length > 0) {
          // A continuation line, indented under its item.
          const last = items[items.length - 1];
          if (last) last.text += `\n${current.trim()}`;
          i++;
        } else break;
      }
      blocks.push({ kind: 'list', items });
      continue;
    }
    const body: string[] = [];
    while (i < lines.length && (lines[i] ?? '').trim() !== '') {
      if (body.length > 0 && startsBlock(lines[i] ?? '', lines[i + 1])) break;
      body.push(lines[i++] ?? '');
    }
    blocks.push({ kind: 'p', text: body.join('\n') });
  }
  return blocks;
}

// Code first, so nothing inside it is read as emphasis or a link.
// Then LaTeX, before emphasis (`$a*b*c$` is a formula). A `$` opens only when
// a non-space follows and closes only when one precedes and no digit follows
// (pandoc's rule), so prices stay text: "$5 e $10".
const INLINE =
  /(`+)([\s\S]*?[^`])\1(?!`)|(?<!\\)\$\$([^\n]+?)\$\$|\\\(([^\n]+?)\\\)|(?<![\\$\w])\$(?![\s$])([^$\n]+?)(?<![\s\\])\$(?![\d$])|\*\*([\s\S]+?)\*\*|__([\s\S]+?)__|(?<![\w*])\*(?!\s)([\s\S]+?)(?<!\s)\*(?![\w*])|(?<![\w_])_(?!\s)([\s\S]+?)(?<!\s)_(?![\w_])|\[([^\]\n]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

/** The inline parts of a line of Markdown. */
export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  let at = 0;
  for (const match of text.matchAll(INLINE)) {
    const start = match.index;
    if (start > at) out.push({ kind: 'text', text: text.slice(at, start) });
    const [, , code, display, paren, dollar, strong, strong2, em, em2, label, url] = match;
    if (display !== undefined) out.push({ kind: 'math', tex: display.trim(), display: true });
    else if (paren !== undefined || dollar !== undefined) {
      out.push({ kind: 'math', tex: (paren ?? dollar ?? '').trim(), display: false });
    } else if (code !== undefined)
      out.push({ kind: 'code', text: code.trim() === '' ? code : code.trim() });
    else if (strong !== undefined || strong2 !== undefined) {
      out.push({ kind: 'strong', children: parseInline(strong ?? strong2 ?? '') });
    } else if (em !== undefined || em2 !== undefined) {
      out.push({ kind: 'em', children: parseInline(em ?? em2 ?? '') });
    } else if (label !== undefined && url !== undefined) {
      out.push({ kind: 'link', text: label, url });
    }
    at = start + match[0].length;
  }
  if (at < text.length) out.push({ kind: 'text', text: text.slice(at) });
  return out;
}
