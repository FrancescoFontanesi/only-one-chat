// The handoffs between the roles (ADR 0035): the four tools of the MCP server
// `ooc`, their schemas (the source of truth of the protocol), the reader that
// takes a handoff from the calls an adapter reported, and the deterministic
// renderers to the Markdown the other roles and the thread read.
//
// Enums are fixed English values; every other field is free text, in any language.

import type { HandoffCall, HandoffServer, HandoffSpec, HandoffTools } from './agent.js';
import { validate, type Schema } from './handoff-server.js';

export const REPORT_OUTCOMES = ['done', 'partial', 'blocked'] as const;
export const CRITERION_STATUSES = ['verified', 'not_verified', 'not_met'] as const;
export const REVIEW_VERDICTS = ['approved', 'with_reservations', 'rejected'] as const;
export const SEVERITIES = ['blocking', 'minor'] as const;
const RESOLUTIONS = ['fixed', 'disputed', 'not_fixed'] as const;

export type ReportOutcome = (typeof REPORT_OUTCOMES)[number];
export type CriterionStatus = (typeof CRITERION_STATUSES)[number];
export type ReviewVerdict = (typeof REVIEW_VERDICTS)[number];
export type Severity = (typeof SEVERITIES)[number];

export interface CriterionResult {
  readonly id: string;
  readonly status: CriterionStatus;
  readonly evidence: string;
}

/** The leader's brief to the implementer. */
export interface Delegate {
  readonly goal: string;
  readonly context?: string;
  readonly constraints?: string;
  readonly acceptance_criteria: readonly string[];
  readonly verification?: string;
  readonly scope?: string;
  readonly stop_if?: string;
}

/** The implementer's report. */
export interface Report {
  readonly outcome: ReportOutcome;
  readonly summary: string;
  readonly changes: readonly { readonly path: string; readonly change: string }[];
  readonly criteria: readonly CriterionResult[];
  readonly verification?: string;
  readonly decisions?: string;
  readonly blocked_on?: string;
  readonly out_of_scope?: string;
  readonly findings?: readonly {
    readonly id: string;
    readonly resolution: (typeof RESOLUTIONS)[number];
    readonly note: string;
  }[];
}

/** The reviewer's findings, for the implementer. */
export interface Findings {
  readonly items: readonly {
    readonly id: string;
    readonly severity: Severity;
    readonly issue: string;
    readonly evidence: string;
    readonly criterion?: string;
  }[];
}

/** The reviewer's review, for the leader. */
export interface Review {
  readonly verdict: ReviewVerdict;
  readonly summary: string;
  readonly criteria: readonly CriterionResult[];
  readonly axes: {
    readonly honesty: 'clean' | 'doubtful' | 'bypassed';
    readonly security: 'clean' | 'doubtful' | 'flaw';
    readonly currency: 'clean' | 'doubtful' | 'outdated';
  };
  readonly open_findings?: readonly {
    readonly id: string;
    readonly severity: Severity;
    readonly issue: string;
  }[];
  readonly closed_findings?: readonly { readonly id: string; readonly note: string }[];
  readonly changes?: string;
  readonly decisions?: string;
  readonly on_brief?: string;
  readonly unverified?: string;
}

interface Payloads {
  delegate: Delegate;
  report: Report;
  findings: Findings;
  review: Review;
}
export type HandoffName = keyof Payloads;

// ---- Schemas ---------------------------------------------------------------

const required = (description: string): Schema => ({ type: 'string', minLength: 1, description });
const optional = (description: string): Schema => ({ type: 'string', description });
const list = (items: Schema, extra: Partial<Schema> = {}): Schema => ({
  type: 'array',
  items,
  ...extra,
});
const object = (properties: Record<string, Schema>, requiredKeys: string[]): Schema => ({
  type: 'object',
  properties,
  required: requiredKeys,
});
const choice = (values: readonly string[], description: string): Schema => ({
  type: 'string',
  enum: values,
  description,
});
const criterionId = (what: string): Schema => ({
  type: 'string',
  pattern: '^C\\d+$',
  description: `${what}, as "C1", "C2"…`,
});
const findingId: Schema = {
  type: 'string',
  pattern: '^R\\d+$',
  description: 'The finding number, "R1", "R2"…',
};

const CRITERIA_RESULTS: Schema = list(
  object(
    {
      id: criterionId('The criterion of the brief'),
      status: choice(
        CRITERION_STATUSES,
        'verified: shown by a command or test you ran in this turn; not_verified: not shown; not_met: shown to fail.',
      ),
      evidence: required(
        'The test (file and name) or command that shows it, with the output line that matters; for not_verified, why.',
      ),
    },
    ['id', 'status', 'evidence'],
  ),
  { description: 'One entry for each criterion of the brief.' },
);

const SCHEMAS: Readonly<Record<HandoffName, Schema>> = {
  delegate: object(
    {
      goal: required('What must exist at the end and why, in 1-5 sentences.'),
      context: optional(
        'What is needed to avoid mistakes: files as @path with the reason, the current behavior, the decisions taken with the user and why, an agreed interface written in full.',
      ),
      constraints: optional(
        'Only the invariants: what not to touch, what not to add (dependencies, public interfaces), the project rules the work touches; which request prevails if two can clash.',
      ),
      acceptance_criteria: list(
        required(
          'One externally observable behavior: the condition or input and the result, with concrete cases "input → expected result" (edge case, error, a hostile input if the work takes outside input). Do not write the number: the runtime numbers them C1, C2…',
        ),
        {
          minItems: 1,
          description: 'The acceptance criteria: behaviors observed from outside.',
        },
      ),
      verification: optional(
        'The commands that verify the work, the ones the repository already uses (build, typecheck, lint, tests), which must pass. Not an acceptance criterion.',
      ),
      scope: optional(
        'What is inside and outside the work; what the implementer may decide alone.',
      ),
      stop_if: optional(
        'When the implementer must stop and report instead of deciding, for example changing a public interface, touching files outside the Context, adding a dependency.',
      ),
    },
    ['goal', 'acceptance_criteria'],
  ),
  report: object(
    {
      outcome: choice(
        REPORT_OUTCOMES,
        'done: every criterion verified by a command you ran in this turn and nothing blocks; partial: a criterion is missing or not verified; blocked: you stopped for a missing decision.',
      ),
      summary: required('What changed, in 1-2 sentences.'),
      changes: list(
        object(
          {
            path: required('The file path.'),
            change: required('What changed there and for which criterion.'),
          },
          ['path', 'change'],
        ),
        { description: 'Every file created, modified or deleted, tests included. May be empty.' },
      ),
      criteria: CRITERIA_RESULTS,
      verification: optional(
        'Commands run, each with its outcome and the output lines that matter; new tests you saw fail before the change; existing tests changed, skipped or removed and why; hostile inputs tried; versions checked (language, dependencies); what is not verified and how to verify it.',
      ),
      decisions: optional('Your own choices and deviations from the brief, each with its why.'),
      blocked_on: optional(
        'The decision that is missing, as a question for the leader, with the options if any. Empty if nothing blocks.',
      ),
      out_of_scope: optional('What you noticed and did not touch.'),
      findings: list(
        object(
          {
            id: findingId,
            resolution: choice(
              RESOLUTIONS,
              'fixed: you fixed it; disputed: you contest it; not_fixed: you did not fix it.',
            ),
            note: required(
              'fixed: the file and the test added; disputed: the passage of the brief or the output you got; not_fixed: why.',
            ),
          },
          ['id', 'resolution', 'note'],
        ),
        { description: 'Only when answering the reviewer’s findings: one entry per finding.' },
      ),
    },
    ['outcome', 'summary', 'changes', 'criteria'],
  ),
  findings: object(
    {
      items: list(
        object(
          {
            id: findingId,
            severity: choice(
              SEVERITIES,
              'blocking: a criterion is not met, a constraint or boundary is violated, a regression, a check bypassed or weakened, or an exploitable security flaw; minor: anything else worth saying.',
            ),
            issue: required(
              'What is wrong, in one sentence: say what does not hold, not how to rewrite it.',
            ),
            evidence: required(
              'The proof: the failing test you wrote (@path and name), or the command with expected → obtained, or @path:line and the input that breaks it; for security, the hostile input and what it gets.',
            ),
            criterion: optional(
              'The criterion (C2), constraint, boundary, repository rule or axis (honesty, security, currency) it violates.',
            ),
          },
          ['id', 'severity', 'issue', 'evidence'],
        ),
        { minItems: 1, description: 'The findings, each with its proof.' },
      ),
    },
    ['items'],
  ),
  review: object(
    {
      verdict: choice(
        REVIEW_VERDICTS,
        'approved: you verified every criterion yourself, no axis is doubtful or worse, no finding is open; with_reservations: no blocking finding is open but a criterion is unverified, an axis doubtful or a minor finding open; rejected: a blocking finding is open or an axis is bypassed, flaw or outdated.',
      ),
      summary: required('Why this verdict, in 1-2 sentences, and how many rounds it took.'),
      criteria: list(
        object(
          {
            id: criterionId('The criterion of the brief'),
            status: choice(CRITERION_STATUSES, 'As you verified it yourself.'),
            evidence: required(
              'The test or command you ran yourself, with the output line that matters; for not_verified, why.',
            ),
          },
          ['id', 'status', 'evidence'],
        ),
        {
          description:
            'One entry for each criterion of the brief (number them yourself if it does not).',
        },
      ),
      axes: object(
        {
          honesty: choice(
            ['clean', 'doubtful', 'bypassed'],
            'Does the work solve the problem or satisfy the checks?',
          ),
          security: choice(
            ['clean', 'doubtful', 'flaw'],
            'What can whoever controls the inputs do?',
          ),
          currency: choice(
            ['clean', 'doubtful', 'outdated'],
            'Does the code use what is current in the versions the project really uses?',
          ),
        },
        ['honesty', 'security', 'currency'],
      ),
      open_findings: list(
        object(
          {
            id: findingId,
            severity: choice(SEVERITIES, 'blocking or minor.'),
            issue: required('What, the proof, the implementer’s answer.'),
          },
          ['id', 'severity', 'issue'],
        ),
        { description: 'The findings still open. Empty if none.' },
      ),
      closed_findings: list(
        object({ id: findingId, note: required('What it was and how it was closed.') }, [
          'id',
          'note',
        ]),
        { description: 'The findings closed during the review.' },
      ),
      changes: optional(
        'Files changed, from the runtime’s facts, one line each with the criterion; mark those the implementer’s report does not name.',
      ),
      decisions: optional(
        'The implementer’s choices and deviations the leader must know, and whether they stay within the scope; if its outcome is partial, its blocked_on question as it is.',
      ),
      on_brief: optional(
        'Ambiguities and gaps of the brief that the work revealed: the point, the possible readings, which one the implementer chose. Criteria that asked for an unsafe behavior go here.',
      ),
      unverified: optional(
        'What you could not check, suspicions without proof, and how to verify them.',
      ),
    },
    ['verdict', 'summary', 'criteria', 'axes'],
  ),
};

const DESCRIPTIONS: Readonly<Record<HandoffName, string>> = {
  delegate:
    'Delegate the work to the implementer. Call it once, with the complete brief, when you delegate; the implementer receives only what these fields say. Outside a delegation, answer normally and do not call it.',
  report:
    'Your report on the work. Call it once, at the end of the turn, instead of writing the report as text. Report what you did and saw in this turn; say what you did not run.',
  findings:
    'Send your findings to the implementer, who answers them. Call it once, at the end of the turn, instead of the review, only while correction rounds are left.',
  review:
    'Send your review to the leader. Call it once, at the end of the turn, instead of writing the review as text. It closes the review.',
};

const BY_ROLE: Readonly<Record<'leader' | 'implementer' | 'reviewer', readonly HandoffName[]>> = {
  leader: ['delegate'],
  implementer: ['report'],
  reviewer: ['findings', 'review'],
};

/** The handoff tools of a role, with the server that serves them (ADR 0035). */
export function handoffTools(
  role: 'leader' | 'implementer' | 'reviewer',
  server: HandoffServer,
): HandoffTools {
  const tools: HandoffSpec[] = BY_ROLE[role].map((name) => ({
    name,
    description: DESCRIPTIONS[name],
    inputSchema: { ...SCHEMAS[name] },
  }));
  return { server, tools };
}

// ---- Reader ------------------------------------------------------------------

/**
 * Drops the keys a schema does not declare, at every object level, and the
 * nulls (an absent optional field): CLIs add fields of their own.
 */
function strip(schema: Schema, value: unknown): unknown {
  if (
    schema.type === 'object' &&
    schema.properties &&
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value)
  ) {
    const properties = schema.properties;
    return Object.fromEntries(
      Object.entries(value).flatMap(([key, child]) => {
        const sub = properties[key];
        return sub && child !== null && child !== undefined ? [[key, strip(sub, child)]] : [];
      }),
    );
  }
  if (schema.type === 'array' && schema.items && Array.isArray(value)) {
    const items = schema.items;
    return value.map((item) => strip(items, item));
  }
  return value;
}

/**
 * The last call of `tool` whose arguments are valid, after dropping the fields
 * the schema does not declare; the CLI's own success status is never trusted.
 * With no valid call, `value` is null and `errors` are those of the last
 * invalid call: empty when the tool was not called at all.
 */
export function readHandoff<K extends HandoffName>(
  calls: readonly HandoffCall[] | undefined,
  tool: K,
): { readonly value: Payloads[K] | null; readonly errors: readonly string[] } {
  const schema = SCHEMAS[tool];
  let errors: string[] = [];
  for (const call of [...(calls ?? [])].reverse()) {
    if (call.tool !== tool) continue;
    const clean = strip(schema, call.arguments);
    const found = validate(schema, clean);
    if (found.length === 0) return { value: clean as Payloads[K], errors: [] };
    if (errors.length === 0) errors = found;
  }
  return { value: null, errors };
}

// ---- Renderers -----------------------------------------------------------------

const clean = (text: string | undefined) => (text ?? '').trim();
const section = (title: string, body: string) => `## ${title}\n\n${body}`;
const orNone = (text: string | undefined) => (clean(text) === '' ? 'none' : clean(text));
const bullets = (lines: readonly string[]) =>
  lines.length === 0
    ? 'none'
    : lines.map((line) => `- ${line.split('\n').join('\n  ')}`).join('\n');
const criteriaLines = (criteria: readonly CriterionResult[]) =>
  criteria.map((c) => `${c.id}: ${c.status} — ${clean(c.evidence)}`);

/** The brief as the implementer and the reviewer read it. */
export function renderBrief(delegate: Delegate): string {
  const parts = [section('Goal', clean(delegate.goal))];
  if (clean(delegate.context) !== '') parts.push(section('Context', clean(delegate.context)));
  if (clean(delegate.constraints) !== '') {
    parts.push(section('Constraints', clean(delegate.constraints)));
  }
  parts.push(
    section(
      'Acceptance criteria',
      delegate.acceptance_criteria
        .map((text, at) => `- C${String(at + 1)} — ${clean(text).split('\n').join('\n  ')}`)
        .join('\n'),
    ),
  );
  if (clean(delegate.verification) !== '') {
    parts.push(section('Verification', clean(delegate.verification)));
  }
  if (clean(delegate.scope) !== '') parts.push(section('Scope', clean(delegate.scope)));
  if (clean(delegate.stop_if) !== '') parts.push(section('Stop if', clean(delegate.stop_if)));
  return parts.join('\n\n');
}

/** The implementer's report, for the leader and the reviewer. */
export function renderReport(report: Report): string {
  const parts = [
    section('Outcome', `${report.outcome} — ${clean(report.summary)}`),
    section('Changes', bullets(report.changes.map((c) => `${clean(c.path)} — ${clean(c.change)}`))),
    section('Criteria', bullets(criteriaLines(report.criteria))),
    section('Verification', orNone(report.verification)),
    section('Decisions', orNone(report.decisions)),
    section('Blocked on', orNone(report.blocked_on)),
    section('Out of scope', orNone(report.out_of_scope)),
  ];
  if (report.findings && report.findings.length > 0) {
    parts.push(
      section(
        'Findings',
        bullets(report.findings.map((f) => `${f.id}: ${f.resolution} — ${clean(f.note)}`)),
      ),
    );
  }
  return parts.join('\n\n');
}

/** The reviewer's findings, for the implementer. */
export function renderFindings(findings: Findings): string {
  return findings.items
    .map((item) =>
      [
        `${item.id} [${item.severity}]${clean(item.criterion) === '' ? '' : ` ${clean(item.criterion)}`} — ${clean(item.issue)}`,
        `Evidence: ${clean(item.evidence)}`,
      ].join('\n'),
    )
    .join('\n\n');
}

/** The reviewer's review, for the leader. */
export function renderReview(review: Review): string {
  const open = (review.open_findings ?? []).map(
    (f) => `${f.id} [${f.severity}] — ${clean(f.issue)}`,
  );
  const closed = (review.closed_findings ?? []).map((f) => `${f.id} — ${clean(f.note)}`);
  return [
    section('Verdict', `${review.verdict} — ${clean(review.summary)}`),
    section('Criteria', bullets(criteriaLines(review.criteria))),
    section(
      'Assessment',
      [
        `Honesty: ${review.axes.honesty}`,
        `Security: ${review.axes.security}`,
        `Currency: ${review.axes.currency}`,
      ].join('\n'),
    ),
    section('Changes', orNone(review.changes)),
    section('Findings', `Open:\n${bullets(open)}\n\nClosed:\n${bullets(closed)}`),
    section('Decisions', orNone(review.decisions)),
    section('On the brief', orNone(review.on_brief)),
    section('Unverified', orNone(review.unverified)),
  ].join('\n\n');
}
