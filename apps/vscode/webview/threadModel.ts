// How the chat thread reads what the host sent (ADR 0016): delegations
// numbered in order, a turn's activity counted by kind, the facts of a
// delegation and a user message split into its parts. Pure functions.

import type { ThreadItem } from './state.js';

/** D01, D02 for delegations; a report and the facts after a delegation take its number. */
export function delegationNumbers(items: readonly ThreadItem[]): Map<string, string> {
  const numbers = new Map<string, string>();
  let count = 0;
  let current: string | null = null;
  for (const item of items) {
    if (item.kind === 'user') current = null;
    if (item.kind === 'approval' && item.approval === 'delegation') {
      count++;
      current = String(count).padStart(2, '0');
      numbers.set(item.id, current);
    } else if (current !== null && (item.kind === 'approval' || item.kind === 'changes')) {
      numbers.set(item.id, current);
    } else if (current !== null && item.kind === 'notice' && isFacts(item.text)) {
      numbers.set(item.id, current);
    }
  }
  return numbers;
}

/** One line of a turn's activity, as the thread lists it. */
export interface Op {
  readonly verb: string;
  readonly what: string;
  readonly group: 'lette' | 'modifiche' | 'comandi' | 'ricerche' | 'altre';
}

/** Activity lines are `kind: detail`; Claude's tools are `Name {json}`. */
export function readOp(line: string): Op {
  const sub = line.startsWith('↳ ');
  const text = sub ? line.slice(2) : line;
  const colon = text.indexOf(': ');
  const kind = colon >= 0 ? text.slice(0, colon) : text;
  const detail = colon >= 0 ? text.slice(colon + 2) : '';
  if (kind === 'command') return { verb: 'CMD', what: detail, group: 'comandi' };
  if (kind === 'tool') {
    const space = detail.indexOf(' ');
    const name = space >= 0 ? detail.slice(0, space) : detail;
    const raw = space >= 0 ? detail.slice(space + 1) : '';
    let what = raw;
    try {
      const input = JSON.parse(raw) as Record<string, unknown>;
      const pick = input['file_path'] ?? input['command'] ?? input['pattern'] ?? input['path'];
      if (typeof pick === 'string') what = pick;
    } catch {
      // A truncated input: shown as it is.
    }
    const group: Op['group'] =
      name === 'Read'
        ? 'lette'
        : name === 'Edit' || name === 'Write' || name === 'NotebookEdit'
          ? 'modifiche'
          : name === 'Bash'
            ? 'comandi'
            : name === 'Grep' || name === 'Glob'
              ? 'ricerche'
              : 'altre';
    return { verb: name.toUpperCase(), what, group };
  }
  return { verb: kind.toUpperCase(), what: detail, group: 'altre' };
}

const GROUP_LABEL: Record<Op['group'], [string, string]> = {
  lette: ['lettura', 'letture'],
  modifiche: ['modifica', 'modifiche'],
  comandi: ['comando', 'comandi'],
  ricerche: ['ricerca', 'ricerche'],
  altre: ['altra', 'altre'],
};

/** "2 letture · 1 modifica · 1 comando" */
export function opsSummary(ops: readonly Op[]): string {
  const counts = new Map<Op['group'], number>();
  for (const op of ops) counts.set(op.group, (counts.get(op.group) ?? 0) + 1);
  return [...counts]
    .map(([group, n]) => `${String(n)} ${GROUP_LABEL[group][n === 1 ? 0 : 1]}`)
    .join(' · ');
}

/** The facts the extension writes after a delegation, or the files a message changed. */
export function isFacts(text: string): boolean {
  return (
    text.startsWith('File cambiati dall’inizio della richiesta:') ||
    text.startsWith('File cambiati:')
  );
}

export interface Facts {
  readonly files: readonly string[];
  readonly verify?: string;
  readonly failed: readonly string[];
  readonly output?: string;
}

/** The facts' text read back into its parts (facts.ts writes it). */
export function readFacts(text: string): Facts {
  const lines = text.split('\n');
  const files: string[] = [];
  const failed: string[] = [];
  let verify: string | undefined;
  let section: 'files' | 'failed' | 'output' | null = 'files';
  const output: string[] = [];
  for (const line of lines.slice(1)) {
    if (line.startsWith('Verifica eseguita dal runtime: ')) {
      verify = line
        .slice('Verifica eseguita dal runtime: '.length)
        .replace(' → exit ', ' · uscita ');
      section = null;
    } else if (line === 'Test falliti:') section = 'failed';
    else if (line === 'Ultime righe dell’output:') section = 'output';
    else if (section === 'output') output.push(line);
    else if (line.startsWith('- ') && section === 'files') files.push(line.slice(2));
    else if (line.startsWith('- ') && section === 'failed') failed.push(line.slice(2));
  }
  return {
    files,
    ...(verify ? { verify } : {}),
    failed,
    ...(output.length > 0 ? { output: output.join('\n') } : {}),
  };
}

export interface UserMessage {
  readonly to: 'leader' | 'implementer';
  /** The route older chats asked of the leader with `/fai`, `/delega`, `/chiedi`; no longer shown (ADR 0018). */
  readonly route: 'fai' | 'delega' | 'chiedi' | null;
  readonly text: string;
}

const ROUTE = /^\/(fai|delega|chiedi)\b\s*/i;
const DIRECT = /^@impl\b\s*/i;

/**
 * A user message as sent: `@impl` or `/route` first, then the text, then the
 * attached files as a last line of `@path` mentions, which the chips show.
 */
export function readUserMessage(
  raw: string,
  attachments: readonly string[] = [],
  /** The recipient the chat recorded; older chats wrote `@impl` first instead. */
  recipient?: UserMessage['to'],
): UserMessage {
  let text = raw;
  let to: UserMessage['to'] = recipient ?? 'leader';
  let route: UserMessage['route'] = null;
  if (!recipient && DIRECT.test(text)) {
    to = 'implementer';
    text = text.replace(DIRECT, '');
  } else {
    const match = ROUTE.exec(text);
    if (match) {
      route = (match[1]?.toLowerCase() ?? 'fai') as UserMessage['route'];
      text = text.replace(ROUTE, '');
    }
  }
  if (attachments.length > 0) {
    const lines = text.split('\n');
    const last = lines.at(-1)?.trim() ?? '';
    if (last !== '' && last.split(/\s+/).every((token) => token.startsWith('@'))) {
      text = lines.slice(0, -1).join('\n').trimEnd();
    }
  }
  return { to, route, text };
}

/** The `@` or `/` word the caret is in: where it starts and what follows the sign. */
export function wordAt(
  text: string,
  caret: number,
  sign: '@' | '/' | '$',
): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  // `@` a file and `$` a skill anywhere; `/` a command, only at the start of the message.
  const match = (
    sign === '@' ? /(^|\s)@([^\s@]*)$/ : sign === '$' ? /(^|\s)\$([\w.:-]*)$/ : /^()\/([\p{L}]*)$/u
  ).exec(before);
  if (!match) return null;
  const query = match[2] ?? '';
  return { start: caret - query.length - 1, query };
}

/**
 * A leader's text without its delegation block (ADR 0018), which its card in
 * the thread shows: the text before and after it; `writing` while the block
 * is still streaming, unclosed. Older `<<<DELEGA @id` blocks count too.
 */
export function withoutDelegation(text: string): { text: string; writing: boolean } {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex((line) => /^<<<DELEGA(?:\s+[#@][\w.-]+)?$/.test(line.trim()));
  if (start < 0) return { text, writing: false };
  const end = lines.findIndex((line, at) => at > start && line.trim() === 'DELEGA>>>');
  const before = lines.slice(0, start).join('\n').trimEnd();
  if (end < 0) return { text: before, writing: true };
  const after = lines
    .slice(end + 1)
    .join('\n')
    .trim();
  return { text: after === '' ? before : `${before}\n\n${after}`.trim(), writing: false };
}

/** The implementer's report (ADR 0020): its sections, and the text around it. */
export interface Report {
  readonly before: string;
  /** completato, parziale, bloccato; null when the Esito does not say. */
  readonly outcome: 'completato' | 'parziale' | 'bloccato' | null;
  readonly sections: readonly { readonly name: string; readonly body: string }[];
  readonly after: string;
}

/**
 * The report between `<<<RAPPORTO` and `RAPPORTO>>>` in a turn's text, if any;
 * a block still open (the turn streams) is not one yet.
 */
export function readReport(text: string): Report | null {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex((line) => line.trim() === '<<<RAPPORTO');
  if (start < 0) return null;
  const end = lines.findIndex((line, at) => at > start && line.trim() === 'RAPPORTO>>>');
  if (end < 0) return null;
  const sections: { name: string; body: string[] }[] = [];
  for (const line of lines.slice(start + 1, end)) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading?.[1]) sections.push({ name: heading[1], body: [] });
    else sections.at(-1)?.body.push(line);
  }
  const done = sections.map((section) => ({
    name: section.name,
    body: section.body.join('\n').trim(),
  }));
  const esito = done.find((section) => /^esito$/i.test(section.name))?.body ?? '';
  const word = /^(completato|parziale|bloccato)\b/i.exec(esito)?.[1]?.toLowerCase();
  return {
    before: lines.slice(0, start).join('\n').trim(),
    outcome: word === 'completato' || word === 'parziale' || word === 'bloccato' ? word : null,
    sections: done,
    after: lines
      .slice(end + 1)
      .join('\n')
      .trim(),
  };
}
