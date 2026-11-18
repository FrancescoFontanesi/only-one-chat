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
      aria-label="Permesso richiesto"
    >
      <div class="pslab__m">
        <span class="cn-tag cn-tag--live">
          ▲ PERMESSO · {who} · {item.agent}
        </span>
        <h2 class="t-title">{file ? 'Vuole modificare un file' : 'Vuole eseguire un comando'}</h2>
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
          <span class="cn-btn__label">1 · CONSENTI</span>
          <span class="cn-btn__icon">→</span>
        </button>
        <button
          class="cn-btn cn-btn--outline cn-btn--sm"
          type="button"
          onClick={() => {
            answer('acceptForSession');
          }}
        >
          <span class="cn-btn__label">2 · PER LA SESSIONE</span>
        </button>
        <button
          class="cn-btn cn-btn--text"
          type="button"
          onClick={() => {
            answer('decline');
          }}
        >
          <span class="cn-btn__label">3 · NEGA</span>
        </button>
      </div>
      <span class="hint pslab__h">
        PER LA SESSIONE VALE SOLO PER QUESTO STESSO COMANDO · ESC NEGA
      </span>
    </section>
  );
}

/** The free answer of a question with choices, as the choice that opens it. */
const OTHER = '\u0000other';

/**
 * The leader's questions while its turn waits (ADR 0019), one at a time: a
 * single choice among the options, "Altro" for a free answer when the model
 * allows it, or a free answer only. Invia hands every answer back to the
 * model in the same turn; Ferma stops the turn.
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
    <section class="cn-frame cn-frame--ink apr qst" aria-label="Domanda del leader">
      <header class="cn-frame__head cn-accent">
        <span class="cn-tag">
          <b>▲ DOMANDA</b> · {who} · {item.agent}
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
                <span class="qst__l">Altro…</span>
                <span class="qst__d">Rispondi con parole tue</span>
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
                  aria-label="Risposta"
                  value={free[q.id] ?? ''}
                  onInput={(event) => {
                    setFree({ ...free, [q.id]: (event.target as HTMLInputElement).value });
                  }}
                />
              ) : (
                <textarea
                  aria-label="Risposta"
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
        <span class="hint">IL TURNO ASPETTA LA TUA RISPOSTA</span>
        <div class="ctl__g">
          <button
            class="cn-btn cn-btn--text"
            type="button"
            title="Ferma il turno: la domanda resta senza risposta"
            onClick={() => {
              post({ type: 'stop' });
            }}
          >
            <span class="cn-btn__label">FERMA</span>
          </button>
          {step > 0 && (
            <button
              class="cn-btn cn-btn--outline cn-btn--sm"
              type="button"
              onClick={() => {
                setStep(step - 1);
              }}
            >
              <span class="cn-btn__label">INDIETRO</span>
            </button>
          )}
          <button
            class="cn-btn cn-btn--sm"
            type="button"
            disabled={last ? !ready : answerOf(q) === ''}
            onClick={forward}
          >
            <span class="cn-btn__label">{last ? 'INVIA' : 'AVANTI'}</span>
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
    <section class="cn-frame cn-frame--ink apr" aria-label="Delega da inviare">
      <header class="cn-frame__head cn-accent">
        <span class="cn-tag">
          <b>→ D{number}</b> DELEGA · {item.from} → {item.to}
        </span>
        <span class="cn-tag">CONSEGNA MANUALE</span>
      </header>
      <div class="cn-frame__body">
        <div class="ctl">
          <label class="cn-tag" for="brief">
            BRIEF · MODIFICABILE
          </label>
          {edited && <span class="cn-tag cn-tag--ink">MODIFICATO DA TE</span>}
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
            ▲ {item.missing.length === 1 ? 'Percorso non trovato' : 'Percorsi non trovati'}:{' '}
            {item.missing.join(', ')} · un file da creare non esiste ancora
          </p>
        )}
      </div>
      <footer class="cn-frame__foot">
        <span class="hint">LA CHAT ASPETTA: INVIA O ANNULLA</span>
        <div class="ctl__g">
          <button
            class="cn-btn cn-btn--text"
            type="button"
            onClick={() => {
              decide('cancel');
            }}
          >
            <span class="cn-btn__label">ANNULLA</span>
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
                <span class="cn-btn__label">INVIA ORIGINALE</span>
              </button>
              <button
                class="cn-btn cn-btn--sm"
                type="button"
                onClick={() => {
                  decide('edit');
                }}
              >
                <span class="cn-btn__label">INVIA MODIFICATO</span>
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
              <span class="cn-btn__label">INVIA</span>
              <span class="cn-btn__icon">→</span>
            </button>
          )}
        </div>
      </footer>
    </section>
  );
}
