// The thread of the Chat board (ADR 0016): one column of messages, each with
// a head line (who, provider, model, state) and its actions at hand; the
// tools an agent uses as a terminal log inside its turn; delegations and
// reports as records; the facts, the changes and the notices in the same
// rhythm. A block that arrives while the chat is open enters with Construct.

import { Fragment, type ComponentChildren } from 'preact';
import { useContext, useState } from 'preact/hooks';
import type { SessionInfo, TurnHandoff } from '../src/webview/protocol.js';
import { refTokens } from '../src/shared/refs.js';
import { FactsTurn, Verification } from './Facts.js';
import { Markdown } from './markdown.js';
import { Progress } from './motion.js';
import type { ThreadItem } from './state.js';
import { isFacts, opsSummary, readOp, readUserMessage, type Op } from './threadModel.js';
import { duration, kilo, post, ShownNode, useWho } from './ui.js';

type Item<K extends ThreadItem['kind']> = Extract<ThreadItem, { kind: K }>;

const STATUS = { running: 'RUNNING', done: '■ DONE', failed: '× STOPPED' } as const;

function Copy({ text }: { text: string }) {
  return (
    <button
      class="cn-btn cn-btn--text act"
      type="button"
      title="Copy text"
      onClick={() => {
        post({ type: 'copy', text });
      }}
    >
      <span class="cn-btn__label">COPY</span>
    </button>
  );
}

/**
 * A text with its `@` paths as links (ADR 0018): only those the host found in
 * the folder; a click opens the file at its lines.
 */
function Linked({ text, refs }: { text: string; refs: readonly string[] | undefined }) {
  if (!refs || refs.length === 0) return <>{text}</>;
  const parts: ComponentChildren[] = [];
  let at = 0;
  for (const token of refTokens(text)) {
    if (!refs.includes(token.path)) continue;
    parts.push(text.slice(at, token.start));
    const { path, lines } = token;
    parts.push(
      <button
        key={token.start}
        class="ref"
        type="button"
        title={
          lines ? `Open ${path}, lines ${String(lines.from)}-${String(lines.to)}` : `Open ${path}`
        }
        onClick={() => {
          post({
            type: 'openFile',
            path,
            ...(lines ? { from: lines.from, to: lines.to } : {}),
          });
        }}
      >
        {text.slice(token.start, token.end)}
      </button>,
    );
    at = token.end;
  }
  parts.push(text.slice(at));
  return <>{parts}</>;
}

function User({ item, index, busy }: { item: Item<'user'>; index: number; busy: boolean }) {
  const message = readUserMessage(item.text, item.attachments, item.to);
  const recipient = useWho(message.to);
  return (
    <section class="turn turn--you">
      <div class="who">
        <span>{String(index).padStart(2, '0')}/</span>
        <b>YOU</b>
        <span>→ {recipient}</span>
        <span class="who__acts">
          <Copy text={message.text} />
          {item.checkpoint && (
            <button
              class="cn-btn cn-btn--text act"
              type="button"
              disabled={busy}
              title="Restore the workspace files to their state before this message. The conversation is preserved."
              onClick={() => {
                if (item.checkpoint)
                  post({ type: 'restoreCheckpoint', checkpoint: item.checkpoint });
              }}
            >
              <span class="cn-btn__label">↺ RESTORE HERE</span>
            </button>
          )}
        </span>
      </div>
      <div class="tb">
        <p class="t-body txt">
          <Linked text={message.text} refs={item.refs} />
        </p>
        {((item.attachments && item.attachments.length > 0) || item.skill) && (
          <div class="atts">
            {item.skill && <span class="att att--skill">$ {item.skill}</span>}
            {(item.attachments ?? []).map((a) => (
              <span key={a} class="att">
                @ {a}
              </span>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

/** Provider, model and reasoning of a turn: from its label once done, else from its agent. */
function identity(item: Item<'turn'>): string[] {
  if (item.label) {
    const [provider = '', model = '', effort = ''] = item.label.split(' · ');
    return [provider, [model, effort.replace(/^effort /, '')].filter(Boolean).join(' · ')];
  }
  const match = /^(.*?) \((.*)\)$/.exec(item.agent);
  return match ? [match[1] ?? '', match[2] ?? ''] : [item.agent];
}

const GLYPH_OF: Record<Op['group'], string> = {
  comandi: '$',
  lette: '>',
  modifiche: '~',
  ricerche: '/',
  altre: '·',
};
/** While a turn runs, its log shows the latest actions only. */
const LIVE_TAIL = 6;

/** The tools a turn used, as a terminal log: commands in ink, the rest muted. */
function ToolLog({ item, ops }: { item: Item<'turn'>; ops: readonly { line: string; op: Op }[] }) {
  const [open, setOpen] = useState(false);
  const running = item.status === 'running';
  const shown = open ? ops : running ? ops.slice(-LIVE_TAIL) : [];
  const hidden = ops.length - shown.length;
  const subagents = item.subagents.filter((s) => open || s.status === 'running');
  return (
    <div class={running ? 'tlog tlog--live' : 'tlog'}>
      <button
        class="tlog__h"
        type="button"
        aria-expanded={open}
        onClick={() => {
          setOpen(!open);
        }}
      >
        <span>{open ? '−' : '+'}</span>
        <b>
          {ops.length} {ops.length === 1 ? 'ACTION' : 'ACTIONS'}
        </b>
        {ops.length > 0 && <span class="mut">{opsSummary(ops.map((o) => o.op))}</span>}
        {item.subagents.length > 0 && (
          <span class="mut">
            · {item.subagents.length} {item.subagents.length === 1 ? 'SUBAGENT' : 'SUBAGENTS'}
          </span>
        )}
        {hidden > 0 && shown.length > 0 && <span class="mut">· {hidden} EARLIER</span>}
      </button>
      {(shown.length > 0 || subagents.length > 0) && (
        <ol class="tlog__l">
          {subagents.map((s) => (
            <li key={s.id} class="tl tl--sub">
              <span>{s.status === 'running' ? '▶' : s.status === 'completed' ? '■' : '×'}</span>
              <span>
                <b>{s.label.toUpperCase()}</b> · read-only
              </span>
              <span>{s.status === 'running' && <Progress variant="spinner" />}</span>
            </li>
          ))}
          {shown.map(({ line, op }, index) => (
            <li
              key={hidden + index}
              class={`tl tl--${op.group}${line.startsWith('↳ ') ? ' tl--sub' : ''}`}
            >
              <span>{GLYPH_OF[op.group]}</span>
              <span>
                <b>{op.verb}</b> {op.what}
              </span>
              <span>{running && index === shown.length - 1 && <Progress variant="spinner" />}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

type Step = Item<'turn'>['steps'][number];

/** How a step ended: interrupted when its turn ended while it ran. */
function stepState(step: Step, running: boolean): 'running' | 'done' | 'failed' | 'stopped' {
  if (!('status' in step)) return 'done';
  return step.status === 'running' && !running ? 'stopped' : step.status;
}

const PLAN_GLYPH = { completed: '■', inProgress: '▶', pending: '□' } as const;

/** A diff, a line at a time, coloured by what the line does. */
function Diff({ text }: { text: string }) {
  return (
    <pre class="outp diff">
      {text.split('\n').map((line, index) => (
        <span
          key={index}
          class={
            line.startsWith('+') && !line.startsWith('+++')
              ? 'diff__a'
              : line.startsWith('-') && !line.startsWith('---')
                ? 'diff__d'
                : line.startsWith('@@')
                  ? 'diff__h'
                  : undefined
          }
        >
          {line}
          {'\n'}
        </span>
      ))}
    </pre>
  );
}

/**
 * The turn as it happened (ADR 0019), in order: intermediate messages as
 * text, the reasoning, commands with their output, file changes with their
 * diff, the turn's plan, other tools. A step opens on a click.
 */
function Steps({ item }: { item: Item<'turn'> }) {
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const running = item.status === 'running';
  const toggle = (id: string) => {
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const end = (step: Step) => {
    const state = stepState(step, running);
    return state === 'running' ? (
      <Progress variant="spinner" />
    ) : state === 'stopped' ? (
      <span class="mut">× STOPPED</span>
    ) : state === 'failed' ? (
      <span>× ERROR</span>
    ) : null;
  };
  return (
    <ol class="tsteps">
      {item.steps.map((step) => {
        const isOpen = open.has(step.id);
        switch (step.kind) {
          case 'message':
            return (
              <li key={step.id} class="st st--msg">
                <Markdown class="t-body" text={step.text} />
              </li>
            );
          case 'reasoning':
            return (
              <li key={step.id} class="st">
                <button
                  class="tl st__h"
                  type="button"
                  disabled={step.text === ''}
                  aria-expanded={isOpen}
                  onClick={() => {
                    toggle(step.id);
                  }}
                >
                  <span>◇</span>
                  <span>
                    <b>REASONING</b> {!isOpen && step.text.split('\n')[0]}
                  </span>
                  <span />
                </button>
                {isOpen && <p class="st__more txt">{step.text}</p>}
              </li>
            );
          case 'command':
            return (
              <li key={step.id} class="st">
                <button
                  class="tl tl--comandi st__h"
                  type="button"
                  disabled={step.output === ''}
                  aria-expanded={isOpen}
                  onClick={() => {
                    toggle(step.id);
                  }}
                >
                  <span>$</span>
                  <span>
                    <b>{step.command}</b>
                  </span>
                  <span>
                    {end(step) ??
                      [
                        step.exitCode !== null ? `EXIT ${String(step.exitCode)}` : null,
                        step.durationMs !== null ? duration(step.durationMs) : null,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                  </span>
                </button>
                {isOpen && <pre class="outp st__more">{step.output}</pre>}
              </li>
            );
          case 'file':
            return (
              <li key={step.id} class="st">
                {step.changes.map((change, index) => {
                  const key = `${step.id}#${String(index)}`;
                  return (
                    <Fragment key={key}>
                      <button
                        class="tl st__h"
                        type="button"
                        disabled={change.diff === ''}
                        aria-expanded={open.has(key)}
                        onClick={() => {
                          toggle(key);
                        }}
                      >
                        <span>
                          {change.change === 'add' ? '+' : change.change === 'delete' ? '−' : '~'}
                        </span>
                        <span>
                          <b>{change.path}</b>{' '}
                          <span class="mut">
                            +{change.added} −{change.removed}
                          </span>
                        </span>
                        <span>{index === step.changes.length - 1 && end(step)}</span>
                      </button>
                      {open.has(key) && <Diff text={change.diff} />}
                    </Fragment>
                  );
                })}
              </li>
            );
          case 'plan':
            return (
              <li key={step.id} class="st st--plan">
                <span class="tl">
                  <span>☰</span>
                  <span>
                    <b>PLAN</b> {step.explanation}
                  </span>
                  <span />
                </span>
                <ul class="tplan">
                  {step.steps.map((s, index) => (
                    <li key={index} class={`tplan__s tplan__s--${s.status}`}>
                      <span>{PLAN_GLYPH[s.status]}</span> {s.step}
                    </li>
                  ))}
                </ul>
              </li>
            );
          case 'tool':
            return (
              <li key={step.id} class="st">
                <span class="tl">
                  <span>↳</span>
                  <span>
                    <b>{step.name}</b> {step.detail}
                  </span>
                  <span>{end(step)}</span>
                </span>
              </li>
            );
        }
      })}
    </ol>
  );
}

const OUTCOME: Record<string, string> = {
  done: '■ DONE',
  partial: '▲ PARTIAL',
  blocked: '× BLOCKED',
};

const VERDICT: Record<string, string> = {
  approved: '■ APPROVED',
  with_reservations: '▲ WITH RESERVATIONS',
  rejected: '× REJECTED',
};

const HANDOFF: Record<string, { label: string; aria: string }> = {
  report: { label: 'REPORT', aria: 'The implementer’s report' },
  review: { label: 'REVIEW', aria: 'The reviewer’s review' },
  findings: { label: 'FINDINGS', aria: 'The reviewer’s findings for the implementer' },
};

/**
 * A handoff a role made with a tool call (ADR 0035): the report, the review or
 * the findings as the runtime rendered them, with the outcome or the verdict.
 * A delegation has no card here: its brief is the approval record's.
 */
function HandoffCard({
  handoff,
  refs,
}: {
  handoff: TurnHandoff;
  refs: readonly string[] | undefined;
}) {
  const kind = HANDOFF[handoff.tool];
  if (!kind) return null;
  return (
    <section class="rep" aria-label={kind.aria}>
      <div class="rep__h">
        <span class="cn-tag">
          <b>{kind.label}</b>
        </span>
        {handoff.outcome && (
          <span class="cn-tag">{OUTCOME[handoff.outcome] ?? handoff.outcome.toUpperCase()}</span>
        )}
        {handoff.verdict && (
          <span class="cn-tag">{VERDICT[handoff.verdict] ?? handoff.verdict.toUpperCase()}</span>
        )}
        {handoff.tool === 'findings' && <span class="cn-tag">→ IMPLEMENTER</span>}
      </div>
      <Markdown
        class="t-body"
        text={handoff.text}
        refs={refs}
        leaf={(text) => <Linked text={text} refs={refs} />}
      />
      {typeof handoff.commandEvidence === 'string' && handoff.commandEvidence && (
        <aside aria-label="Runtime command evidence" class="rep">
          <Markdown class="t-body" text={handoff.commandEvidence} />
        </aside>
      )}
    </section>
  );
}

function Turn({ item }: { item: Item<'turn'> }) {
  const ops = item.activity.map((line) => ({ line, op: readOp(line) }));
  // A leader's route line of older chats is left out; its delegation block is in its card (ADR 0018).
  const [first = '', ...rest] = item.text.split('\n');
  const leader = item.role === 'leader';
  const text = leader && /^via:/i.test(first.trim()) ? rest.join('\n').trimStart() : item.text;
  const body = text;
  const handoff = item.handoff;
  const [provider, model] = identity(item);
  const usage = item.usage;
  const running = item.status === 'running';
  const who = useWho(item.role);
  return (
    <section class={running ? 'turn turn--live' : 'turn'}>
      <div class="who">
        <b>{who}</b>
        {provider && <span>{provider}</span>}
        {model && <span>{model}</span>}
        {running ? (
          <span class="cn-tag cn-tag--live cn-tag--ink">{STATUS.running}</span>
        ) : (
          <span>{STATUS[item.status]}</span>
        )}
        <span class="who__acts">
          {(body !== '' || handoff) && !running && (
            <Copy
              text={[body, handoff?.text, handoff?.commandEvidence].filter(Boolean).join('\n\n')}
            />
          )}
        </span>
      </div>
      <div class="tb">
        {item.steps.length > 0 ? (
          <>
            {item.subagents.length > 0 && <ToolLog item={item} ops={[]} />}
            <Steps item={item} />
          </>
        ) : (
          (ops.length > 0 || item.subagents.length > 0) && <ToolLog item={item} ops={ops} />
        )}
        {body !== '' ? (
          <Markdown
            class={running ? 't-body cn-cursor' : 't-body'}
            text={body}
            refs={item.refs}
            leaf={(text) => <Linked text={text} refs={item.refs} />}
          />
        ) : (
          running && <Progress label="WORKING" />
        )}
        {handoff && !running && <HandoffCard handoff={handoff} refs={item.refs} />}
        {usage && (
          <div class="tfoot">
            <span>CONTEXT {kilo(usage.context)}</span>
            <span>OUTPUT {kilo(usage.output)}</span>
            <span>{duration(usage.durationMs)}</span>
            {usage.costUsd !== null && <span>ESTIMATED COST ${usage.costUsd.toFixed(2)}</span>}
          </div>
        )}
      </div>
    </section>
  );
}

const DECIDED: Record<string, string> = {
  approve: '■ SENT',
  edit: '■ SENT WITH EDITS',
  sent: '■ SENT · AUTO',
  cancel: '× CANCELED',
  interrupted: '× STOPPED',
};

/** A report of older chats, approved before it reached the leader. */
const REPORT_DECIDED: Record<string, string> = {
  approve: '■ APPROVED',
  edit: '■ APPROVED WITH EDITS',
  cancel: '× CANCELED',
  interrupted: '× STOPPED',
};

/** A message between agents, once decided: a record, its text one click away. */
function Hand({ item, number }: { item: Item<'approval'>; number: string }) {
  const [open, setOpen] = useState(false);
  const delegation = item.approval === 'delegation';
  const decided = (delegation ? DECIDED : REPORT_DECIDED)[item.closed ?? ''] ?? item.closed ?? '';
  return (
    <div class="hand">
      <div class="hand__l">
        <span class="cn-tag">
          <b>
            {delegation ? '→ D' : '← R'}
            {number}
          </b>{' '}
          {delegation ? 'DELEGATION' : 'REPORT'} · {item.from} → {item.to}
        </span>
        <span class="cn-tag">{decided}</span>
      </div>
      <button
        class="cn-btn cn-btn--text"
        type="button"
        aria-expanded={open}
        onClick={() => {
          setOpen(!open);
        }}
      >
        <span class="cn-btn__label">{delegation ? 'BRIEF' : 'OPEN'}</span>
      </button>
      {open && (
        <pre class="opn">
          <Linked text={item.text} refs={item.refs} />
        </pre>
      )}
    </div>
  );
}

const ASKED: Record<string, string> = {
  answered: '■ ANSWERED',
  declined: '× UNANSWERED',
  interrupted: '× STOPPED',
};

/** An agent's questions, once closed: each question and the answer given (ADR 0019). */
function Asked({ item }: { item: Item<'question'> }) {
  const who = useWho(item.role);
  return (
    <div class="hand asked">
      <div class="hand__l">
        <span class="cn-tag">
          <b>▲ QUESTION</b> · {who}
        </span>
        <span class="cn-tag">{ASKED[item.closed ?? ''] ?? item.closed}</span>
      </div>
      <dl class="asked__l">
        {item.questions.map((q) => (
          <Fragment key={q.id}>
            <dt>{q.question}</dt>
            <dd>{item.answers?.[q.id]?.join(', ') ?? '—'}</dd>
          </Fragment>
        ))}
      </dl>
    </div>
  );
}

const PERMIT: Record<string, string> = {
  accept: 'ALLOWED',
  acceptForSession: 'ALLOWED FOR SESSION',
  decline: 'DENIED',
  interrupted: 'STOPPED',
};

function Permission({ item }: { item: Item<'permission'> }) {
  const allowed = item.closed === 'accept' || item.closed === 'acceptForSession';
  const who = useWho(item.role);
  return (
    <div class="hand">
      <div class="hand__l">
        <span class="cn-tag">
          <b>{allowed ? '■' : '×'} PERMISSION</b> {who}
        </span>
        <span class="t-data">{item.summary}</span>
      </div>
      <span class="cn-tag">{PERMIT[item.closed ?? ''] ?? item.closed}</span>
    </div>
  );
}

const KIND = { added: '+', modified: '~', deleted: '−' } as const;

function Changes({
  item,
  number,
  busy,
}: {
  item: Item<'changes'>;
  number: string | undefined;
  busy: boolean;
}) {
  const added = item.files.reduce((sum, f) => sum + f.added, 0);
  const removed = item.files.reduce((sum, f) => sum + f.removed, 0);
  const review = (path: string, action: 'diff' | 'accept' | 'reject') => {
    post({ type: 'reviewFile', id: item.id, path, action });
  };
  return (
    <section class="turn" id={`item-${item.id}`}>
      <div class="who">
        <b>CHANGES</b>
        {number && <span>D{number}</span>}
        <span>
          {item.files.length} {item.files.length === 1 ? 'FILE' : 'FILES'} · +{added} −{removed}
        </span>
      </div>
      <div class="tb tb--flush">
        {item.files.map((file) => {
          const decision = item.decisions[file.path];
          return (
            <div key={file.path} class={decision === 'rejected' ? 'chg chg--off' : 'chg'}>
              <span aria-label={file.kind}>{KIND[file.kind]}</span>
              <button
                class="lnk"
                type="button"
                title="Open diff"
                onClick={() => {
                  review(file.path, 'diff');
                }}
              >
                {file.path}
              </button>
              <span class="chg__n">
                {file.binary
                  ? 'BINARY'
                  : file.kind === 'deleted'
                    ? `−${String(file.removed)}`
                    : `+${String(file.added)} −${String(file.removed)}`}
              </span>
              <span class="chg__a">
                {decision === 'accepted' ? (
                  <span class="cn-tag cn-tag--ink">■ ACCEPTED</span>
                ) : decision === 'rejected' ? (
                  <span class="cn-tag">× REJECTED</span>
                ) : (
                  <>
                    <button
                      class="cn-btn cn-btn--text"
                      type="button"
                      disabled={busy}
                      title="Restore the file to its state before this message"
                      onClick={() => {
                        review(file.path, 'reject');
                      }}
                    >
                      <span class="cn-btn__label">REJECT</span>
                    </button>
                    <button
                      class="cn-btn cn-btn--text"
                      type="button"
                      onClick={() => {
                        review(file.path, 'accept');
                      }}
                    >
                      <span class="cn-btn__label">ACCEPT</span>
                    </button>
                  </>
                )}
              </span>
            </div>
          );
        })}
        {item.uncovered.map((path) => (
          <div key={path} class="chg">
            <span aria-label="not tracked">~</span>
            <span class="t-data">{path}</span>
            <span class="chg__n">OVER 2 MB</span>
            <span class="chg__a">
              <span class="cn-tag">▲ CANNOT RESTORE</span>
            </span>
          </div>
        ))}
        {item.uncovered.length > 0 && (
          <p class="hint hint--gap">FILES OVER 2 MB CANNOT BE RESTORED.</p>
        )}
      </div>
    </section>
  );
}

const GLYPH = { info: '■', warn: '▲', error: '×' } as const;

function Notice({ item, retry }: { item: Item<'notice'>; retry: (() => void) | null }) {
  // A short line about what passed between the agents.
  if (item.level === 'info' && !item.text.includes('\n') && item.text.length < 120) {
    return <span class="evt">{item.text.replace(/\.$/, '')}</span>;
  }
  return (
    <div class="note">
      <span>{GLYPH[item.level]}</span>
      <span class="txt">{item.text}</span>
      {item.level === 'error' ? (
        <span class="ctl__g note__a">
          {retry && (
            <button class="cn-btn cn-btn--text act" type="button" onClick={retry}>
              <span class="cn-btn__label">RETRY</span>
            </button>
          )}
          <button
            class="cn-btn cn-btn--text act"
            type="button"
            onClick={() => {
              post({ type: 'copy', text: item.text });
            }}
          >
            <span class="cn-btn__label">COPY DETAILS</span>
          </button>
        </span>
      ) : (
        <span />
      )}
    </div>
  );
}

export function Thread({
  items,
  numbers,
  session,
}: {
  items: readonly ThreadItem[];
  numbers: ReadonlyMap<string, string>;
  session: SessionInfo | undefined;
}) {
  const node = useContext(ShownNode);
  const busy = node ? (session?.busyNodes ?? []).includes(node.id) : (session?.busy ?? false);
  let users = 0;
  const lastUser = [...items].reverse().find((i): i is Item<'user'> => i.kind === 'user');
  const retry =
    lastUser && !busy
      ? () => {
          post({ type: 'send', text: lastUser.text, ...(node ? { node: node.id } : {}) });
        }
      : null;
  // Items are just there: no entrance draws lines around them (static rules, +------+).
  const enter = (_id: string, node: ComponentChildren) => node;
  return (
    <>
      {items.map((item) => {
        switch (item.kind) {
          case 'verification':
            return <Verification key={item.id} item={item} />;
          case 'user':
            users++;
            return enter(item.id, <User key={item.id} item={item} index={users} busy={busy} />);
          case 'turn':
            return enter(item.id, <Turn key={item.id} item={item} />);
          case 'approval':
            // Waiting: it is in the dock, in place of the composer.
            return item.closed
              ? enter(
                  item.id,
                  <Hand key={item.id} item={item} number={numbers.get(item.id) ?? ''} />,
                )
              : null;
          case 'permission':
            return item.closed ? <Permission key={item.id} item={item} /> : null;
          case 'question':
            // Waiting: it is in the dock, in place of the composer.
            return item.closed ? enter(item.id, <Asked key={item.id} item={item} />) : null;
          case 'changes':
            return enter(
              item.id,
              <Changes key={item.id} item={item} number={numbers.get(item.id)} busy={busy} />,
            );
          case 'notice':
            return isFacts(item.text) ? (
              enter(
                item.id,
                <FactsTurn key={item.id} text={item.text} number={numbers.get(item.id)} />,
              )
            ) : (
              <Notice key={item.id} item={item} retry={retry} />
            );
        }
      })}
    </>
  );
}
