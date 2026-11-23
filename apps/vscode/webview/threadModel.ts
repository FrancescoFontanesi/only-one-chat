// How the chat thread reads what the host sent (ADR 0016): delegations
// numbered in order, a turn's activity counted by kind, the facts of a
// delegation and a user message split into its parts. Pure functions.

import {
  CONFIGURED_COMMAND_PREFIX,
  CONTRACT_SUFFIX,
  DIFF_CHECKS_HEADER,
  DIFF_CHECKS_SKIPPED_PREFIX,
  DIFF_CHECKS_UNAVAILABLE,
  FAILED_TESTS_HEADER,
  FILES_UNAVAILABLE,
  GATE_SENT_BACK_HEADER,
  NO_CONFIGURED_COMMAND,
  NO_FLAGS,
  OUTPUT_HEADER,
  RISK_PREFIX,
  TURN_FILES_HEADER,
  VERIFY_PREFIX,
} from '../../../packages/runtime/src/fact-headers.js';
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
  lette: ['read', 'reads'],
  modifiche: ['edit', 'edits'],
  comandi: ['command', 'commands'],
  ricerche: ['search', 'searches'],
  altre: ['other action', 'other actions'],
};

/** "2 reads · 1 edit · 1 command" */
export function opsSummary(ops: readonly Op[]): string {
  const counts = new Map<Op['group'], number>();
  for (const op of ops) counts.set(op.group, (counts.get(op.group) ?? 0) + 1);
  return [...counts]
    .map(([group, n]) => `${String(n)} ${GROUP_LABEL[group][n === 1 ? 0 : 1]}`)
    .join(' · ');
}

/** Recognize the facts the extension writes, including notices from older chats. */
export function isFacts(text: string): boolean {
  return /^(?:Files changed(?: since the request began)?|File cambiati(?: dall’inizio della richiesta)?):/.test(
    text,
  );
}

export interface Facts {
  readonly files: readonly string[];
  /** The workspace could not be compared: too many files, or unreadable (ADR 0047). */
  readonly unavailable: boolean;
  /** What the implementer's last turn changed, when listed (ADR 0041). */
  readonly turn?: readonly string[];
  readonly verify?: string;
  readonly failed: readonly string[];
  readonly output?: string;
  /** The diff checks' flags, empty for `no flags`; absent when the text has none (ADR 0046). */
  readonly flags?: readonly string[];
  /** Changed files too large to check. */
  readonly skipped?: string;
  readonly checksUnavailable: boolean;
  readonly risk?: { readonly level: string; readonly score: string; readonly reasons: string[] };
}

/** Lines that end the verification output: the blocks written after it. */
const AFTER_OUTPUT = [
  CONFIGURED_COMMAND_PREFIX,
  NO_CONFIGURED_COMMAND,
  DIFF_CHECKS_HEADER,
  DIFF_CHECKS_UNAVAILABLE,
  RISK_PREFIX,
];
/** The verification heading; older chats wrote it in Italian. */
const VERIFY_HEADING = new RegExp(
  `^(?:${VERIFY_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}|Verifica eseguita dal runtime: )`,
);

/** The facts' text read back into its parts, by the headers its producers write (ADR 0048). */
export function readFacts(text: string): Facts {
  const files: string[] = [];
  const failed: string[] = [];
  const output: string[] = [];
  let turn: string[] | undefined;
  let flags: string[] | undefined;
  let verify: string | undefined;
  let skipped: string | undefined;
  let risk: Facts['risk'];
  let unavailable = false;
  let checksUnavailable = false;
  let section: 'files' | 'turn' | 'failed' | 'output' | 'flags' | null = 'files';
  for (const line of text.split(/\r?\n/).slice(1)) {
    if (section === 'output') {
      if (!AFTER_OUTPUT.some((start) => line.startsWith(start))) {
        output.push(line);
        continue;
      }
      section = null;
    }
    const heading = VERIFY_HEADING.exec(line);
    if (heading) {
      verify = line.slice(heading[0].length).replace(' → exit ', ' · exit ');
      section = null;
    } else if (line === TURN_FILES_HEADER) [section, turn] = ['turn', []];
    else if (line === FAILED_TESTS_HEADER || line === 'Test falliti:') section = 'failed';
    else if (line === OUTPUT_HEADER || line === 'Ultime righe dell’output:') section = 'output';
    else if (line === DIFF_CHECKS_HEADER) [section, flags] = ['flags', []];
    else if (line === DIFF_CHECKS_UNAVAILABLE) checksUnavailable = true;
    else if (line.startsWith(DIFF_CHECKS_SKIPPED_PREFIX))
      skipped = line.slice(DIFF_CHECKS_SKIPPED_PREFIX.length);
    else if (line.startsWith(RISK_PREFIX)) risk = readRisk(line.slice(RISK_PREFIX.length));
    else if (!line.startsWith('- ')) section = line === '' ? null : section;
    else if (section === 'files' && line === FILES_UNAVAILABLE) unavailable = true;
    else if (section === 'files') files.push(line.slice(2));
    else if (section === 'turn') turn?.push(line.slice(2));
    else if (section === 'failed') failed.push(line.slice(2));
    else if (section === 'flags' && line !== NO_FLAGS) flags?.push(line.slice(2));
  }
  while (output.at(-1) === '') output.pop();
  return {
    files,
    unavailable,
    ...(turn ? { turn } : {}),
    ...(verify ? { verify } : {}),
    failed,
    ...(output.length > 0 ? { output: output.join('\n') } : {}),
    ...(flags ? { flags } : {}),
    ...(skipped ? { skipped } : {}),
    checksUnavailable,
    ...(risk ? { risk } : {}),
  };
}

/** `medium (0.42) — 3 files changed; no tests changed.` */
function readRisk(text: string): Facts['risk'] {
  const match = /^(\w+) \((-?[\d.]+)\)(?: — (.*?))?\.?$/.exec(text);
  if (!match) return undefined;
  const [, level = '', score = '', reasons = ''] = match;
  return { level, score, reasons: reasons.split('; ').filter(Boolean) };
}

/** The checks of a report or a review against the brief, as the runtime writes them (ADR 0031, 0042). */
export function readContract(text: string): { title: string; items: string[] } | null {
  const [first = '', ...rest] = text.split(/\r?\n/);
  if (!/^Checks on the \w+/.test(first) || !first.endsWith(CONTRACT_SUFFIX)) return null;
  return {
    title: first.slice(0, -CONTRACT_SUFFIX.length),
    items: rest.filter((line) => line.startsWith('- ')).map((line) => line.slice(2)),
  };
}

/** A check before the review that sent the work back (ADR 0041): its result line. */
export function readGate(text: string): string | null {
  return text.startsWith(GATE_SENT_BACK_HEADER)
    ? text.slice(GATE_SENT_BACK_HEADER.length).trim()
    : null;
}

interface UserMessage {
  readonly to: 'leader' | 'implementer' | 'reviewer';
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

/** What waits for the user (ADR 0021): open permissions, delegations to send, questions. */
export type WaitingItem = Extract<ThreadItem, { kind: 'permission' | 'approval' | 'question' }>;

export function waitingItems(items: readonly ThreadItem[]): WaitingItem[] {
  return items.filter(
    (item): item is WaitingItem =>
      (item.kind === 'permission' || item.kind === 'approval' || item.kind === 'question') &&
      item.closed === undefined,
  );
}
