// The fixed format of a delegation message from the orchestrator to a worker,
// and its parser. The block is delimited by marker lines so it can be found in
// a longer answer (plan first, then the block), and must contain the six
// sections in order, none empty. The start line may name the recipient:
// `<<<DELEGA @claude`.

export const DELEGATION_START = '<<<DELEGA';
export const DELEGATION_END = 'DELEGA>>>';

export const DELEGATION_SECTIONS = [
  'Obiettivo',
  'Contesto',
  'Vincoli',
  'Assunzioni',
  'Domande aperte',
  'Output atteso',
] as const;

export type DelegationSection = (typeof DELEGATION_SECTIONS)[number];

export interface Delegation {
  /** Recipient named on the start line, lowercase; null when none is given. */
  readonly recipient: string | null;
  readonly sections: Readonly<Record<DelegationSection, string>>;
  /** The block as it will be forwarded, markers excluded. */
  readonly text: string;
}

export type DelegationParse =
  | { readonly status: 'valid'; readonly delegation: Delegation }
  | { readonly status: 'absent' }
  | { readonly status: 'malformed'; readonly errors: readonly string[] };

const START_LINE = /^<<<DELEGA(?:\s+@([\w.-]+))?$/;

/** Template shown to the orchestrator in its role instructions. */
export function delegationTemplate(recipient?: string): string {
  return [
    recipient ? `${DELEGATION_START} @${recipient}` : DELEGATION_START,
    ...DELEGATION_SECTIONS.map((section) => `## ${section}\n<testo>`),
    DELEGATION_END,
  ].join('\n');
}

function lines(text: string): string[] {
  return text.replace(/\r\n/g, '\n').split('\n');
}

/**
 * Finds and checks the delegation block in an agent answer. `absent` means no
 * start marker at all (the answer is a conclusion, not a delegation).
 */
export function parseDelegation(answer: string): DelegationParse {
  const all = lines(answer);
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

  const body = all.slice(start + 1, end);
  const headings = body.flatMap((line, at) => {
    const match = /^##\s+(.+?)\s*$/.exec(line);
    return match?.[1] === undefined ? [] : [{ name: match[1], at }];
  });
  const names = headings.map((heading) => heading.name);
  if (names.join('|') !== DELEGATION_SECTIONS.join('|')) {
    errors.push(
      `sections must be exactly, in order: ${DELEGATION_SECTIONS.join(', ')}; found: ${
        names.length > 0 ? names.join(', ') : 'none'
      }`,
    );
  }
  if (body.slice(0, headings[0]?.at ?? body.length).some((line) => line.trim() !== '')) {
    errors.push('text before the first section');
  }
  const sections: Partial<Record<DelegationSection, string>> = {};
  headings.forEach((heading, index) => {
    const content = body
      .slice(heading.at + 1, headings[index + 1]?.at ?? body.length)
      .join('\n')
      .trim();
    if ((DELEGATION_SECTIONS as readonly string[]).includes(heading.name)) {
      if (content === '') errors.push(`section "${heading.name}" is empty`);
      sections[heading.name as DelegationSection] = content;
    }
  });
  if (errors.length > 0) return { status: 'malformed', errors };
  return {
    status: 'valid',
    delegation: {
      recipient,
      sections: sections as Record<DelegationSection, string>,
      text: body.join('\n').trim(),
    },
  };
}
