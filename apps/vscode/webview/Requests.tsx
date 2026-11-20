// What waits for the user in the dock (ADR 0016, 0018, 0019): a permission as
// the view's one Slab, the leader's questions and a delegation held by the
// manual delivery as ink frames.

import { useEffect, useRef, useState } from 'preact/hooks';
import type { PermitDecision } from '../src/webview/protocol.js';
import { flash } from './motion.js';
import type { ThreadItem } from './state.js';
import { post, useWho } from './ui.js';

export type Item<K extends ThreadItem['kind']> = Extract<ThreadItem, { kind: K }>;

export function PermissionSlab({
  item,
  theme,
}: {
  item: Item<'permission'>;
  theme: 'dark' | 'light';
}) {
  const slab = useRef<HTMLElement>(null);
  const answer = (decision: PermitDecision) => {
    post({ type: 'permit', id: item.id, decision });
  };
  useEffect(() => {
    if (slab.current) flash(slab.current);
  }, [item.id]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const typing = (event.target as HTMLElement | null)?.closest('textarea, input');
      if (typing) return;
      if (event.key === '1') answer('accept');
      else if (event.key === '2') answer('acceptForSession');
      else if (event.key === '3' || event.key === 'Escape') answer('decline');
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  });
  const file = /^(Edit|Write|NotebookEdit|MultiEdit):/.test(item.summary);
  const who = useWho(item.role);
  return (
    <section
      ref={slab}
      class="cn-slab pslab"
      data-theme={theme === 'dark' ? 'light' : 'dark'}
      aria-label="Permission request"
    >
      <div class="pslab__m">
        <span class="cn-tag cn-tag--live">
          ▲ PERMISSION · {who} · {item.agent}
        </span>
        <h2 class="t-title">
          {file ? 'Requests permission to edit a file' : 'Requests permission to run a command'}
        </h2>
        <code class="t-data pslab__c">
          {file ? item.summary : `$ ${item.summary.replace(/^Bash: /, '')}`}
        </code>
      </div>
      <div class="pslab__a">
        <button
          class="cn-btn cn-btn--sm"
          type="button"
          onClick={() => {
            answer('accept');
          }}
        >
          <span class="cn-btn__label">1 · ALLOW</span>
          <span class="cn-btn__icon">→</span>
        </button>
        <button
          class="cn-btn cn-btn--outline cn-btn--sm"
          type="button"
          onClick={() => {
            answer('acceptForSession');
          }}
        >
          <span class="cn-btn__label">2 · ALLOW FOR SESSION</span>
        </button>
        <button
          class="cn-btn cn-btn--text"
          type="button"
          onClick={() => {
            answer('decline');
          }}
        >
          <span class="cn-btn__label">3 · DENY</span>
        </button>
      </div>
      <span class="hint pslab__h">SESSION APPROVAL APPLIES ONLY TO THIS REQUEST · ESC TO DENY</span>
    </section>
  );
}

/** The free answer of a question with choices, as the choice that opens it. */
const OTHER = '\u0000other';

/**
 * The leader's questions while its turn waits (ADR 0019), one at a time: a
 * single choice among the options, "Other" for a free answer when the model
 * allows it, or a free answer only. Send hands every answer back to the
 * model in the same turn, while Stop ends the turn.
 */
export function QuestionFrame({ item }: { item: Item<'question'> }) {
  const [step, setStep] = useState(0);
  const [picked, setPicked] = useState<Readonly<Record<string, string>>>({});
  const [free, setFree] = useState<Readonly<Record<string, string>>>({});
  const total = item.questions.length;
  const q = item.questions[Math.min(step, total - 1)];
  const answerOf = (question: (typeof item.questions)[number]): string => {
    const choice = picked[question.id];
    if (question.options && choice !== OTHER) return choice ?? '';
    return (free[question.id] ?? '').trim();
  };
  const ready = item.questions.every((question) => answerOf(question) !== '');
  const last = step >= total - 1;
  const submit = () => {
    if (!ready) return;
    post({
      type: 'answer',
      id: item.id,
      answers: Object.fromEntries(
        item.questions.map((question) => [question.id, [answerOf(question)]]),
      ),
    });
  };
  const forward = () => {
    if (last) submit();
    else setStep(step + 1);
  };
  const choose = (value: string) => {
    if (!q) return;
    setPicked({ ...picked, [q.id]: value });
  };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const typing = (event.target as HTMLElement | null)?.closest('textarea, input');
      if (typing || !q?.options) return;
      const index = Number(event.key) - 1;
      const option = q.options[index];
      if (option) choose(option.label);
      else if (q.other && index === q.options.length) choose(OTHER);
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  });
  const who = useWho(item.role);
  if (!q) return null;
  const freeOpen = !q.options || picked[q.id] === OTHER;
  return (
    <section class="cn-frame cn-frame--ink apr qst" aria-label="Agent question">
      <header class="cn-frame__head cn-accent">
        <span class="cn-tag">
          <b>▲ QUESTION</b> · {who} · {item.agent}
        </span>
        {total > 1 && (
          <span class="cn-tag">
            {String(step + 1)}/{String(total)}
          </span>
        )}
      </header>
      <div class="cn-frame__body">
        {q.header && <span class="cn-tag">{q.header.toUpperCase()}</span>}
        <h2 class="t-title qst__q">{q.question}</h2>
        {q.options && (
          <div class="qst__opts" role="radiogroup" aria-label={q.question}>
            {q.options.map((option, index) => (
              <button
                key={option.label}
                type="button"
                role="radio"
                aria-checked={picked[q.id] === option.label}
                class="qst__o"
                onClick={() => {
                  choose(option.label);
                }}
              >
                <span class="qst__k">{String(index + 1)}</span>
                <span class="qst__l">{option.label}</span>
                {option.description && <span class="qst__d">{option.description}</span>}
              </button>
            ))}
            {q.other && (
              <button
                type="button"
                role="radio"
                aria-checked={picked[q.id] === OTHER}
                class="qst__o"
                onClick={() => {
                  choose(OTHER);
                }}
              >
                <span class="qst__k">{String(q.options.length + 1)}</span>
                <span class="qst__l">Other…</span>
                <span class="qst__d">Answer in your own words</span>
              </button>
            )}
          </div>
        )}
        {freeOpen && (
          <div class="box box--mono qst__free">
            <div class="box__row">
              {q.secret ? (
                <input
                  type="password"
                  aria-label="Answer"
                  value={free[q.id] ?? ''}
                  onInput={(event) => {
                    setFree({ ...free, [q.id]: (event.target as HTMLInputElement).value });
                  }}
                />
              ) : (
                <textarea
                  aria-label="Answer"
                  rows={2}
                  value={free[q.id] ?? ''}
                  onInput={(event) => {
                    setFree({ ...free, [q.id]: (event.target as HTMLTextAreaElement).value });
                  }}
                />
              )}
            </div>
          </div>
        )}
      </div>
      <footer class="cn-frame__foot">
        <span class="hint">WAITING FOR YOUR ANSWER</span>
        <div class="ctl__g">
          <button
            class="cn-btn cn-btn--text"
            type="button"
            title="Stop the turn and leave the question unanswered"
            onClick={() => {
              post({ type: 'stop' });
            }}
          >
            <span class="cn-btn__label">STOP</span>
          </button>
          {step > 0 && (
            <button
              class="cn-btn cn-btn--outline cn-btn--sm"
              type="button"
              onClick={() => {
                setStep(step - 1);
              }}
            >
              <span class="cn-btn__label">BACK</span>
            </button>
          )}
          <button
            class="cn-btn cn-btn--sm"
            type="button"
            disabled={last ? !ready : answerOf(q) === ''}
            onClick={forward}
          >
            <span class="cn-btn__label">{last ? 'SEND' : 'NEXT'}</span>
            <span class="cn-btn__icon">→</span>
          </button>
        </div>
      </footer>
    </section>
  );
}

/**
 * A delegation the manual delivery holds (ADR 0018): the brief as free text,
 * editable, sent as it is or as edited, or cancelled. The chat waits for it.
 * Paths that look like files and do not exist are pointed out, not blocking.
 */
export function ApprovalFrame({ item, number }: { item: Item<'approval'>; number: string }) {
  const [text, setText] = useState(item.text);
  const edited = text !== item.text;
  const decide = (action: 'approve' | 'edit' | 'cancel') => {
    post(
      action === 'edit'
        ? { type: 'decide', id: item.id, action, text }
        : { type: 'decide', id: item.id, action },
    );
  };
  return (
    <section class="cn-frame cn-frame--ink apr" aria-label="Delegation awaiting delivery">
      <header class="cn-frame__head cn-accent">
        <span class="cn-tag">
          <b>→ D{number}</b> DELEGATION · {item.from} → {item.to}
        </span>
        <span class="cn-tag">MANUAL DELIVERY</span>
      </header>
      <div class="cn-frame__body">
        <div class="ctl">
          <label class="cn-tag" for="brief">
            EDITABLE BRIEF
          </label>
          {edited && <span class="cn-tag cn-tag--ink">EDITED</span>}
        </div>
        <div class="box box--mono">
          <div class="box__row">
            <textarea
              id="brief"
              value={text}
              onInput={(event) => {
                setText((event.target as HTMLTextAreaElement).value);
              }}
            />
          </div>
        </div>
        {item.missing && item.missing.length > 0 && (
          <p class="apr__miss">
            ▲ {item.missing.length === 1 ? 'Path not found' : 'Paths not found'}:{' '}
            {item.missing.join(', ')} · Files to be created may be missing.
          </p>
        )}
      </div>
      <footer class="cn-frame__foot">
        <span class="hint">SEND OR CANCEL TO RESUME THE CHAT</span>
        <div class="ctl__g">
          <button
            class="cn-btn cn-btn--text"
            type="button"
            onClick={() => {
              decide('cancel');
            }}
          >
            <span class="cn-btn__label">CANCEL</span>
          </button>
          {edited ? (
            <>
              <button
                class="cn-btn cn-btn--outline cn-btn--sm"
                type="button"
                onClick={() => {
                  decide('approve');
                }}
              >
                <span class="cn-btn__label">SEND ORIGINAL</span>
              </button>
              <button
                class="cn-btn cn-btn--sm"
                type="button"
                onClick={() => {
                  decide('edit');
                }}
              >
                <span class="cn-btn__label">SEND EDITED</span>
                <span class="cn-btn__icon">→</span>
              </button>
            </>
          ) : (
            <button
              class="cn-btn cn-btn--sm"
              type="button"
              onClick={() => {
                decide('approve');
              }}
            >
              <span class="cn-btn__label">SEND</span>
              <span class="cn-btn__icon">→</span>
            </button>
          )}
        </div>
      </footer>
    </section>
  );
}
