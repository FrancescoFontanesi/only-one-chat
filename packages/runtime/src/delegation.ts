// The fixed format of a delegation message from the leader to the implementer,
// and its parser. The block is delimited by marker lines so it can be found in
// a longer answer (plan first, then the block). Its body is free (the leader's
// own brief, with its own `## ` headings): only the marker lines are checked.
// The start line may name the recipient: `<<<DELEGA #claude` (ADR 0018: `@` is for files);
// the older `<<<DELEGA @claude` is still read, for sessions resumed with the earlier instructions.

const DELEGATION_START = '<<<DELEGA';
const DELEGATION_END = 'DELEGA>>>';

interface Delegation {
  /** Recipient named on the start line, lowercase; null when none is given. */
  readonly recipient: string | null;
  /** The block as it will be forwarded, markers excluded. */
  readonly text: string;
}

export type DelegationParse =
  | { readonly status: 'valid'; readonly delegation: Delegation }
  | { readonly status: 'absent' }
  | { readonly status: 'malformed'; readonly errors: readonly string[] };

const START_LINE = /^<<<DELEGA(?:\s+[#@]([\w.-]+))?$/;

/** The start line of a block for `recipient`. */
export function delegationStart(recipient: string): string {
  return `${DELEGATION_START} #${recipient}`;
}

/**
 * Finds and checks the delegation block in an agent answer. `absent` means no
 * start marker at all (the answer is a conclusion, not a delegation).
 */
export function parseDelegation(answer: string): DelegationParse {
  const all = answer.replace(/\r\n/g, '\n').split('\n');
  const starts = all.flatMap((line, at) => (START_LINE.test(line.trim()) ? [at] : []));
  const ends = all.flatMap((line, at) => (line.trim() === DELEGATION_END ? [at] : []));
  if (starts.length === 0 && ends.length === 0) return { status: 'absent' };

  const errors: string[] = [];
  if (starts.length !== 1)
    errors.push(`expected one "${DELEGATION_START}" line, found ${String(starts.length)}`);
  if (ends.length !== 1)
    errors.push(`expected one "${DELEGATION_END}" line, found ${String(ends.length)}`);
  if (errors.length > 0) return { status: 'malformed', errors };
  const [start, end] = [starts[0] ?? 0, ends[0] ?? 0];
  const recipient = START_LINE.exec(all[start]?.trim() ?? '')?.[1]?.toLowerCase() ?? null;
  if (end < start)
    return { status: 'malformed', errors: ['the end marker comes before the start marker'] };

  const text = all
    .slice(start + 1, end)
    .join('\n')
    .trim();
  if (text === '') return { status: 'malformed', errors: ['the block is empty'] };
  return { status: 'valid', delegation: { recipient, text } };
}
