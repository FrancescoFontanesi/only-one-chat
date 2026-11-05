// The thread of the Chat board (ADR 0016): one column of messages, each with
// a head line (who, provider, model, state) and its actions at hand; the
// tools an agent uses as a terminal log inside its turn; delegations and
// reports as records; the facts, the changes and the notices in the same
// rhythm. A block that arrives while the chat is open enters with Construct.

import { Fragment, type ComponentChildren } from 'preact';
import { useRef, useState } from 'preact/hooks';
import type { SessionInfo } from '../src/webview/protocol.js';
import { refTokens } from '../src/webview/refs.js';
import { Progress, Reveal } from './motion.js';
import type { ThreadItem } from './state.js';
import {
  isFacts,
  opsSummary,
  readFacts,
  readOp,
  readUserMessage,
  withoutDelegation,
  type Op,
} from './threadModel.js';
import { duration, kilo, post } from './ui.js';

type Item<K extends ThreadItem['kind']> = Extract<ThreadItem, { kind: K }>;

const STATUS = { running: 'IN CORSO', done: '■ CONCLUSO', failed: '× INTERROTTO' } as const;

function Copy({ text }: { text: string }) {
  return (
    <button
      class="cn-btn cn-btn--text act"
      type="button"
      title="Copia il testo"
      onClick={() => {
        post({ type: 'copy', text });
      }}
    >
      <span class="cn-btn__label">COPIA</span>
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
          lines ? `Apri ${path}, righe ${String(lines.from)}-${String(lines.to)}` : `Apri ${path}`
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
  return (
    <section class="turn turn--you">
      <div class="who">
        <span>{String(index).padStart(2, '0')}/</span>
        <b>TU</b>
        <span>→ {message.to === 'leader' ? 'LEADER' : 'IMPLEMENTATORE'}</span>
        <span class="who__acts">
          <Copy text={message.text} />
          {item.checkpoint && (
            <button
              class="cn-btn cn-btn--text act"
              type="button"
              disabled={busy}
              title="Riporta i file della cartella a com’erano prima di questo messaggio. La conversazione resta com’è."
              onClick={() => {
                if (item.checkpoint)
                  post({ type: 'restoreCheckpoint', checkpoint: item.checkpoint });
              }}
            >
              <span class="cn-btn__label">↺ RIPRISTINA QUI</span>
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
          {ops.length} {ops.length === 1 ? 'AZIONE' : 'AZIONI'}
        </b>
        {ops.length > 0 && <span class="mut">{opsSummary(ops.map((o) => o.op))}</span>}
        {item.subagents.length > 0 && (
          <span class="mut">· {item.subagents.length} SOTTO-AGENTI</span>
        )}
        {hidden > 0 && shown.length > 0 && <span class="mut">· {hidden} PRIMA</span>}
      </button>
      {(shown.length > 0 || subagents.length > 0) && (
        <ol class="tlog__l">
          {subagents.map((s) => (
            <li key={s.id} class="tl tl--sub">
              <span>{s.status === 'running' ? '▶' : s.status === 'completed' ? '■' : '×'}</span>
              <span>
                <b>{s.label.toUpperCase()}</b> · sola lettura
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

function Turn({ item }: { item: Item<'turn'> }) {
  const ops = item.activity.map((line) => ({ line, op: readOp(line) }));
  // A leader's route line of older chats is left out; its delegation block is in its card (ADR 0018).
  const [first = '', ...rest] = item.text.split('\n');
  const leader = item.role === 'leader';
  const text = leader && /^via:/i.test(first.trim()) ? rest.join('\n').trimStart() : item.text;
  const { text: body, writing } = leader ? withoutDelegation(text) : { text, writing: false };
  const [provider, model] = identity(item);
  const usage = item.usage;
  const running = item.status === 'running';
  return (
    <section class={running ? 'turn turn--live' : 'turn'}>
      <div class="who">
        <b>{item.role === 'leader' ? 'LEADER' : 'IMPLEMENTATORE'}</b>
        {provider && <span>{provider}</span>}
        {model && <span>{model}</span>}
        {running ? (
          <span class="cn-tag cn-tag--live cn-tag--ink">{STATUS.running}</span>
        ) : (
          <span>{STATUS[item.status]}</span>
        )}
        <span class="who__acts">{body !== '' && !running && <Copy text={body} />}</span>
      </div>
      <div class="tb">
        {(ops.length > 0 || item.subagents.length > 0) && <ToolLog item={item} ops={ops} />}
        {body !== '' ? (
          <p class={running && !writing ? 't-body txt cn-cursor' : 't-body txt'}>
            <Linked text={body} refs={item.refs} />
          </p>
        ) : (
          running && !writing && <Progress label="LAVORA" />
        )}
        {running && writing && <Progress label="SCRIVE IL BRIEF" />}
        {usage && (
          <div class="tfoot">
            <span>CONTESTO {kilo(usage.context)}</span>
            <span>OUTPUT {kilo(usage.output)}</span>
            <span>{duration(usage.durationMs)}</span>
            {usage.costUsd !== null && (
              <span>COSTO NOMINALE ${usage.costUsd.toFixed(2).replace('.', ',')}</span>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

const DECIDED: Record<string, string> = {
  approve: '■ INVIATA',
  edit: '■ INVIATA MODIFICATA',
  sent: '■ INVIATA · AUTO',
  cancel: '× ANNULLATA',
  interrupted: '× INTERROTTA',
};

/** A report of older chats, approved before it reached the leader. */
const REPORT_DECIDED: Record<string, string> = {
  approve: '■ APPROVATO',
  edit: '■ APPROVATO MODIFICATO',
  cancel: '× ANNULLATO',
  interrupted: '× INTERROTTO',
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
          {delegation ? 'DELEGA' : 'RAPPORTO'} · {item.from} → {item.to}
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
        <span class="cn-btn__label">{delegation ? 'BRIEF' : 'APRI'}</span>
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
  answered: '■ RISPOSTA',
  declined: '× SENZA RISPOSTA',
  interrupted: '× INTERROTTA',
};

/** An agent's questions, once closed: each question and the answer given (ADR 0019). */
function Asked({ item }: { item: Item<'question'> }) {
  return (
    <div class="hand asked">
      <div class="hand__l">
        <span class="cn-tag">
          <b>▲ DOMANDA</b> · {item.role === 'leader' ? 'LEADER' : 'IMPLEMENTATORE'}
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
  accept: 'CONSENTITO',
  acceptForSession: 'PER LA SESSIONE',
  decline: 'NEGATO',
  interrupted: 'INTERROTTO',
};

function Permission({ item }: { item: Item<'permission'> }) {
  const allowed = item.closed === 'accept' || item.closed === 'acceptForSession';
  return (
    <div class="hand">
      <div class="hand__l">
        <span class="cn-tag">
          <b>{allowed ? '■' : '×'} PERMESSO</b>{' '}
          {item.role === 'leader' ? 'LEADER' : 'IMPLEMENTATORE'}
        </span>
        <span class="t-data">{item.summary}</span>
      </div>
      <span class="cn-tag">{PERMIT[item.closed ?? ''] ?? item.closed}</span>
    </div>
  );
}

function FactsTurn({ text, number }: { text: string; number: string | undefined }) {
  const facts = readFacts(text);
  return (
    <section class="turn">
      <div class="who">
        <b>ESTENSIONE</b>
        <span>FATTI VERIFICATI</span>
        {number && <span>D{number}</span>}
      </div>
      <div class="tb">
        <dl class="cn-spec facts">
          <dt>FILE CAMBIATI</dt>
          <dd class="t-data">
            {facts.files.length > 0
              ? facts.files.map((f) => f.replace(/^(added|modified|deleted) /, '')).join(' · ')
              : 'nessuno'}
          </dd>
          {facts.verify && (
            <>
              <dt>VERIFICA</dt>
              <dd class="t-data">{facts.verify}</dd>
            </>
          )}
          {facts.failed.length > 0 && (
            <>
              <dt>FALLITI</dt>
              <dd class="t-data">{facts.failed.join(' · ')}</dd>
            </>
          )}
        </dl>
        {facts.output && <pre class="outp">{facts.output}</pre>}
      </div>
    </section>
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
        <b>MODIFICHE</b>
        {number && <span>D{number}</span>}
        <span>
          {item.files.length} FILE · +{added} −{removed}
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
                title="Apri il diff"
                onClick={() => {
                  review(file.path, 'diff');
                }}
              >
                {file.path}
              </button>
              <span class="chg__n">
                {file.binary
                  ? 'BINARIO'
                  : file.kind === 'deleted'
                    ? `−${String(file.removed)}`
                    : `+${String(file.added)} −${String(file.removed)}`}
              </span>
              <span class="chg__a">
                {decision === 'accepted' ? (
                  <span class="cn-tag cn-tag--ink">■ ACCETTATO</span>
                ) : decision === 'rejected' ? (
                  <span class="cn-tag">× RIFIUTATO</span>
                ) : (
                  <>
                    <button
                      class="cn-btn cn-btn--text"
                      type="button"
                      disabled={busy}
                      title="Rimette il file com’era prima del messaggio"
                      onClick={() => {
                        review(file.path, 'reject');
                      }}
                    >
                      <span class="cn-btn__label">RIFIUTA</span>
                    </button>
                    <button
                      class="cn-btn cn-btn--text"
                      type="button"
                      onClick={() => {
                        review(file.path, 'accept');
                      }}
                    >
                      <span class="cn-btn__label">ACCETTA</span>
                    </button>
                  </>
                )}
              </span>
            </div>
          );
        })}
        {item.uncovered.map((path) => (
          <div key={path} class="chg">
            <span aria-label="non registrato">~</span>
            <span class="t-data">{path}</span>
            <span class="chg__n">OLTRE 2 MB</span>
            <span class="chg__a">
              <span class="cn-tag">▲ NON ANNULLABILE</span>
            </span>
          </div>
        ))}
        {item.uncovered.length > 0 && (
          <p class="hint hint--gap">FILE OLTRE 2 MB: RIFIUTA NON PUÒ RIPRISTINARLI.</p>
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
              <span class="cn-btn__label">RIPROVA</span>
            </button>
          )}
          <button
            class="cn-btn cn-btn--text act"
            type="button"
            onClick={() => {
              post({ type: 'copy', text: item.text });
            }}
          >
            <span class="cn-btn__label">COPIA DETTAGLI</span>
          </button>
        </span>
      ) : (
        <span />
      )}
    </div>
  );
}

/**
 * Which items arrived while the chat was open: those enter with Construct, as
 * the answer to what the user did. What a chat brings when it is loaded
 * (opened, resumed, a new epoch) is just there.
 */
function useArrivals(items: readonly ThreadItem[], epoch: number): ReadonlyMap<string, boolean> {
  const seen = useRef(new Map<string, boolean>());
  const since = useRef({ epoch, at: performance.now() });
  if (since.current.epoch !== epoch) {
    since.current = { epoch, at: performance.now() };
    seen.current.clear();
  }
  const settled = performance.now() - since.current.at > 600;
  for (const item of items) if (!seen.current.has(item.id)) seen.current.set(item.id, settled);
  return seen.current;
}

export function Thread({
  items,
  numbers,
  session,
  epoch,
}: {
  items: readonly ThreadItem[];
  numbers: ReadonlyMap<string, string>;
  session: SessionInfo | undefined;
  /** Changes when the thread is loaded again. */
  epoch: number;
}) {
  const busy = session?.busy ?? false;
  const arrivals = useArrivals(items, epoch);
  let users = 0;
  const lastUser = [...items].reverse().find((i): i is Item<'user'> => i.kind === 'user');
  const retry =
    lastUser && !busy
      ? () => {
          post({ type: 'send', text: lastUser.text });
        }
      : null;
  const enter = (id: string, node: ComponentChildren) =>
    arrivals.get(id) ? <Reveal key={id}>{node}</Reveal> : node;
  return (
    <>
      {items.map((item) => {
        switch (item.kind) {
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
