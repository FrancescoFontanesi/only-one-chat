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
  /** The route asked of the leader, if any. */
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
  sign: '@' | '/',
): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  // `@` a file anywhere; `/` a command, only at the start of the message.
  const match = (sign === '@' ? /(^|\s)@([^\s@]*)$/ : /^()\/([\p{L}]*)$/u).exec(before);
  if (!match) return null;
  const query = match[2] ?? '';
  return { start: caret - query.length - 1, query };
}
