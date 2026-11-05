// The dock of the Chat board (ADR 0016): what waits for the user takes the
// composer's place (a permission as the view's one Slab, a delegation held by
// the manual delivery as an ink frame: the chat waits for it, ADR 0018), else
// the composer: one lattice cell, closed on its four sides with a + at each
// corner, the text and, under a rule, one line with the recipient and the
// delivery as picks, the context and the send. `@` in the text attaches a file, `$` names a
// skill of the recipient's CLI (ADR 0019), `/` lists the commands. On a wide panel, beside the composer, the two dials (Hud.tsx):
// who you talk to, and the providers' usage.

import { useEffect, useRef, useState } from 'preact/hooks';
import {
  parseHostMessage,
  type ApprovalMode,
  type Cli,
  type HostToWebviewMessage,
  type MonitorState,
  type ProviderUsage,
  type RolesState,
  type PermitDecision,
  type RoleName,
  type SessionInfo,
} from '../src/webview/protocol.js';
import { matchPaths } from './mentions.js';
import { Lattice } from './lattice.js';
import { RoleHud, UsageHud } from './Hud.js';
import { flash, Progress } from './motion.js';
import type { ThreadItem } from './state.js';
import { wordAt } from './threadModel.js';
import { Meter, Pick, post } from './ui.js';

type Item<K extends ThreadItem['kind']> = Extract<ThreadItem, { kind: K }>;

function PermissionSlab({ item, theme }: { item: Item<'permission'>; theme: 'dark' | 'light' }) {
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
  return (
    <section
      ref={slab}
      class="cn-slab pslab"
      data-theme={theme === 'dark' ? 'light' : 'dark'}
      aria-label="Permesso richiesto"
    >
      <div class="pslab__m">
        <span class="cn-tag cn-tag--live">
          ▲ PERMESSO · {item.role === 'leader' ? 'LEADER' : 'IMPLEMENTATORE'} · {item.agent}
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
function QuestionFrame({ item }: { item: Item<'question'> }) {
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
  if (!q) return null;
  const freeOpen = !q.options || picked[q.id] === OTHER;
  return (
    <section class="cn-frame cn-frame--ink apr qst" aria-label="Domanda del leader">
      <header class="cn-frame__head cn-accent">
        <span class="cn-tag">
          <b>▲ DOMANDA</b> · {item.role === 'leader' ? 'LEADER' : 'IMPLEMENTATORE'} · {item.agent}
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
function ApprovalFrame({ item, number }: { item: Item<'approval'>; number: string }) {
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

/** How the leader's delegations reach the implementer (ADR 0018). */
const DELIVERY: readonly { value: ApprovalMode; label: string; title: string }[] = [
  { value: 'auto', label: 'AUTO', title: 'Il brief parte subito per l’implementatore' },
  {
    value: 'manual',
    label: 'MANUALE',
    title: 'Il brief aspetta te, modificabile; la chat si ferma finché non lo invii o annulli',
  },
];

const setMode = (mode: ApprovalMode) => {
  post({ type: 'setMode', mode });
};

type SkillsMessage = Extract<HostToWebviewMessage, { type: 'skills' }>;

/** The skills that match, best first: the name starting with the query, then containing it. */
function matchSkills(
  skills: SkillsMessage['skills'],
  query: string,
  limit = 8,
): SkillsMessage['skills'] {
  const q = query.toLowerCase();
  return skills
    .map((s) => {
      const name = s.name.toLowerCase();
      return { s, score: q === '' ? 1 : name.startsWith(q) ? 0 : name.includes(q) ? 1 : -1 };
    })
    .filter((x) => x.score >= 0)
    .sort((a, b) => a.score - b.score || a.s.name.localeCompare(b.s.name))
    .slice(0, limit)
    .map((x) => x.s);
}

interface Command {
  name: string;
  hint: string;
  run: () => void;
}

/**
 * The open popover: the files for `@`, the skills for `$`, the commands for
 * `/`. `start` is where its word begins in the text, null when it was opened
 * from a command.
 */
interface Pop {
  kind: 'file' | 'skill' | 'command';
  start: number | null;
  query: string;
}

const RECIPIENTS: readonly { value: RoleName; label: string; title: string }[] = [
  { value: 'leader', label: 'LEADER', title: 'Ragioni con il leader; delega quando glielo chiedi' },
  {
    value: 'implementer',
    label: 'IMPLEMENTATORE',
    title: 'Diretto all’implementatore: il modo più economico quando sai già cosa chiedere',
  },
];

function Composer({
  session,
  openSquad,
  to,
  setTo,
  cli,
}: {
  session: SessionInfo | undefined;
  openSquad: () => void;
  to: RoleName;
  setTo: (to: RoleName) => void;
  /** The recipient's CLI, whose skills `$` lists. */
  cli: Cli | undefined;
}) {
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<readonly string[]>([]);
  /** The skill this message invokes, one at most (ADR 0019). */
  const [skill, setSkill] = useState<string | null>(null);
  const [skills, setSkills] = useState<Partial<Record<Cli, SkillsMessage>>>({});
  const [files, setFiles] = useState<readonly string[]>([]);
  const [pop, setPop] = useState<Pop | null>(null);
  const [choice, setChoice] = useState(0);
  const box = useRef<HTMLTextAreaElement>(null);
  const busy = session?.busy ?? false;
  const ready = session !== undefined && session.workspace !== null && session.trusted;
  const canSend = ready && !busy && text.trim() !== '';
  const enterSends = session?.enterSends ?? true;

  const attach = (path: string) => {
    setAttachments((current) => (current.includes(path) ? current : [...current, path]));
  };

  useEffect(() => {
    const onMessage = (event: MessageEvent<unknown>) => {
      const message = parseHostMessage(event.data);
      if (message?.type === 'files') setFiles(message.paths);
      if (message?.type === 'skills') {
        setSkills((current) => ({ ...current, [message.cli]: message }));
      }
      // The editor's file or selection (Ctrl+Alt+K) arrives as `@path#L1-2`: an attachment.
      if (message?.type === 'insert') {
        const path = /^@(\S+)\s*$/.exec(message.text)?.[1];
        if (path) attach(path);
        box.current?.focus();
      }
    };
    window.addEventListener('message', onMessage);
    return () => {
      window.removeEventListener('message', onMessage);
    };
  }, []);

  const openFiles = (start: number | null, query: string) => {
    if (pop?.kind !== 'file') post({ type: 'listFiles' });
    setPop({ kind: 'file', start, query });
    setChoice(0);
  };
  const openSkills = (start: number | null, query: string) => {
    // Read from the CLI the first time; the host keeps them for the folder.
    if (cli && pop?.kind !== 'skill' && skills[cli]?.status !== 'ready') {
      post({ type: 'listSkills', cli });
    }
    setPop({ kind: 'skill', start, query });
    setChoice(0);
  };
  // A skill belongs to its recipient's CLI: another recipient drops it.
  useEffect(() => {
    setSkill(null);
  }, [to, cli]);

  const commands: Command[] = [
    {
      name: 'impl',
      hint: 'Scrivi all’implementatore',
      run: () => {
        setTo('implementer');
      },
    },
    {
      name: 'leader',
      hint: 'Scrivi al leader',
      run: () => {
        setTo('leader');
      },
    },
    {
      name: 'allega',
      hint: 'Allega un file o una cartella',
      run: () => {
        openFiles(null, '');
      },
    },
    {
      name: 'skill',
      hint: 'Usa una skill di chi ricevi',
      run: () => {
        openSkills(null, '');
      },
    },
    busy
      ? {
          name: 'ferma',
          hint: 'Ferma tutto e nega le richieste in attesa',
          run: () => {
            post({ type: 'stop' });
          },
        }
      : {
          name: 'nuova',
          hint: 'Una chat nuova',
          run: () => {
            post({ type: 'newChat' });
          },
        },
    { name: 'squad', hint: 'Ruoli, eventi, utilizzo', run: openSquad },
    {
      name: 'impostazioni',
      hint: 'Tutte le impostazioni',
      run: () => {
        post({ type: 'openSettings' });
      },
    },
  ];
  const fileOptions = pop?.kind === 'file' ? matchPaths(files, pop.query) : [];
  const skillList = cli ? skills[cli] : undefined;
  const skillOptions =
    pop?.kind === 'skill' && skillList?.status === 'ready'
      ? matchSkills(skillList.skills, pop.query)
      : [];
  const commandOptions =
    pop?.kind === 'command'
      ? commands.filter((c) => c.name.startsWith(pop.query.toLowerCase()))
      : [];
  const optionCount =
    pop?.kind === 'file'
      ? fileOptions.length
      : pop?.kind === 'skill'
        ? skillOptions.length
        : commandOptions.length;
  /** Why the skills popover has nothing to choose, if so. */
  const skillNote =
    pop?.kind !== 'skill'
      ? null
      : !cli || !skillList || skillList.status === 'loading'
        ? 'LETTURA DELLE SKILL…'
        : skillList.status === 'unavailable'
          ? `× ${skillList.note ?? 'SKILL NON DISPONIBILI'}`
          : skillOptions.length === 0
            ? 'NESSUNA SKILL CON QUESTO NOME'
            : null;

  const follow = (value: string, caret: number) => {
    const file = wordAt(value, caret, '@');
    if (file) {
      openFiles(file.start, file.query);
      return;
    }
    const named = wordAt(value, caret, '$');
    if (named) {
      openSkills(named.start, named.query);
      return;
    }
    const command = wordAt(value, caret, '/');
    if (command) {
      setPop({ kind: 'command', ...command });
      setChoice(0);
      return;
    }
    setPop(null);
  };
  const removeWord = (start: number, query: string) => {
    const next = text.slice(0, start) + text.slice(start + 1 + query.length);
    setText(next);
    requestAnimationFrame(() => {
      box.current?.setSelectionRange(start, start);
      box.current?.focus();
    });
  };
  const pick = (index: number) => {
    if (!pop) return;
    if (pop.start !== null) removeWord(pop.start, pop.query);
    setPop(null);
    if (pop.kind === 'file') {
      const path = fileOptions[index];
      if (path) attach(path);
    } else if (pop.kind === 'skill') {
      const chosen = skillOptions[index];
      if (chosen) setSkill(chosen.name);
    } else {
      commandOptions[index]?.run();
    }
    box.current?.focus();
  };
  const send = () => {
    if (!canSend) return;
    // The attachments go as a last line of `@path` mentions, which the host reads (ADR 0015).
    const mentions = attachments.map((a) => `@${a}`).join(' ');
    post({
      type: 'send',
      text: mentions ? `${text.trimEnd()}\n\n${mentions}` : text,
      ...(to === 'implementer' ? { to } : {}),
      ...(skill ? { skill } : {}),
    });
    setText('');
    setAttachments([]);
    setSkill(null);
  };
  const option = (index: number) => ({
    class: index === choice ? 'pick pick--mono cn-accent' : 'pick pick--mono',
    type: 'button' as const,
    role: 'option' as const,
    'aria-selected': index === choice,
    onMouseDown: (event: MouseEvent) => {
      event.preventDefault();
      pick(index);
    },
  });

  const context = session?.context[to];
  const percent = context?.window ? context.used / context.window : null;
  return (
    <Lattice
      class={ready ? 'cmp' : 'cmp cmp--off'}
      edges={{ top: true, bottom: true, left: true, right: true }}
    >
      {pop && (optionCount > 0 || skillNote) && (
        <section class="pop pop--up cn-frame cn-frame--ink" role="listbox">
          <div class="cn-frame__head pop__h">
            <span class="t-label">
              {pop.kind === 'file'
                ? 'ALLEGA FILE'
                : pop.kind === 'skill'
                  ? `SKILL · ${cli === 'claude' ? 'CLAUDE' : 'CODEX'}`
                  : 'COMANDI'}
            </span>
            <span class="t-label mut">
              {pop.kind === 'file' ? '@' : pop.kind === 'skill' ? '$' : '/'}
            </span>
          </div>
          {skillNote && <p class="hint pop__note">{skillNote}</p>}
          {pop.kind === 'file'
            ? fileOptions.map((path, index) => (
                <button key={path} {...option(index)}>
                  <span class="pick__n">{path}</span>
                  <span class="pick__m">{path.endsWith('/') ? 'CARTELLA' : ''}</span>
                </button>
              ))
            : pop.kind === 'skill'
              ? skillOptions.map((s, index) => (
                  <button
                    key={s.name}
                    {...option(index)}
                    class={`${option(index).class} pick--skill`}
                    title={s.description}
                  >
                    <span class="pick__n">${s.name}</span>
                    <span class="pick__m">{s.description}</span>
                  </button>
                ))
              : commandOptions.map((command, index) => (
                  <button key={command.name} {...option(index)}>
                    <span class="pick__n">/{command.name}</span>
                    <span class="pick__m">{command.hint}</span>
                  </button>
                ))}
          <div class="cn-frame__foot pop__f">
            <span class="hint">↑↓ · INVIO O TAB SCEGLIE · ESC CHIUDE</span>
          </div>
        </section>
      )}
      <div class="cn-cell cmp__cell">
        {(attachments.length > 0 || skill) && (
          <div class="atts cmp__atts">
            {skill && (
              <span class="att att--skill">
                $ {skill}{' '}
                <button
                  type="button"
                  aria-label={`Togli la skill ${skill}`}
                  onClick={() => {
                    setSkill(null);
                  }}
                >
                  ×
                </button>
              </span>
            )}
            {attachments.map((a) => (
              <span key={a} class="att">
                @ {a}{' '}
                <button
                  type="button"
                  aria-label={`Rimuovi ${a}`}
                  onClick={() => {
                    setAttachments((current) => current.filter((c) => c !== a));
                  }}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
        <div class="cmp__in">
          <label class="sr" for="msg">
            Messaggio
          </label>
          <textarea
            id="msg"
            ref={box}
            rows={1}
            disabled={!ready}
            value={text}
            placeholder={
              !ready
                ? 'Invio non disponibile finché la chat non è pronta.'
                : to === 'leader'
                  ? 'Scrivi al leader · @ allega un file · $ skill · / comandi'
                  : 'Scrivi all’implementatore · il leader leggerà il rapporto dopo'
            }
            onInput={(event) => {
              const area = event.target as HTMLTextAreaElement;
              setText(area.value);
              follow(area.value, area.selectionStart);
            }}
            onBlur={() => {
              setPop(null);
            }}
            onKeyDown={(event) => {
              if (pop && optionCount > 0) {
                const move = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0;
                if (move !== 0) {
                  event.preventDefault();
                  setChoice((choice + move + optionCount) % optionCount);
                  return;
                }
                if (event.key === 'Enter' || event.key === 'Tab') {
                  event.preventDefault();
                  pick(choice);
                  return;
                }
              }
              if (pop && event.key === 'Escape') {
                event.preventDefault();
                setPop(null);
                return;
              }
              if (event.key !== 'Enter' || event.isComposing) return;
              const sends = enterSends ? !event.shiftKey : event.ctrlKey || event.metaKey;
              if (sends) {
                event.preventDefault();
                send();
              }
            }}
          />
        </div>
        <div class="cmp__foot">
          {/* Who and how, here only when the dials beside the composer are not shown. */}
          <span class="cmp__to">
            <Pick
              short="A"
              label="Destinatario"
              value={to}
              options={RECIPIENTS}
              disabled={!ready}
              onChange={setTo}
            />
            {to === 'leader' ? (
              <Pick
                compact
                label="Consegna"
                value={session?.mode ?? 'manual'}
                options={DELIVERY}
                onChange={setMode}
              />
            ) : (
              <span class="pk pk--off pk--compact">
                <span class="pk__v">DIRETTO</span>
              </span>
            )}
          </span>
          <span
            class="ctx cmp__ctx"
            title={
              context
                ? `Contesto della sessione dopo il suo ultimo turno: ${String(context.used)} token${context.window ? ` su ${String(context.window)}` : ''}.`
                : 'Il contesto si conosce dopo il primo turno.'
            }
          >
            CTX
            {percent !== null ? (
              <>
                <Meter value={percent} />
                <b>{Math.round(percent * 100)}%</b>
              </>
            ) : (
              <b>—</b>
            )}
          </span>
          <span class="cmp__send">
            {busy ? (
              <>
                <Progress label="IN CORSO" cells={8} />
                <button
                  class="cn-btn cn-btn--sm"
                  type="button"
                  aria-label="Ferma tutto e nega le richieste in attesa"
                  onClick={() => {
                    post({ type: 'stop' });
                  }}
                >
                  <span class="cn-btn__label">FERMA</span>
                  <span class="cn-btn__icon">■</span>
                </button>
              </>
            ) : (
              <button
                class="cn-btn cn-btn--outline cn-btn--sm"
                type="button"
                disabled={!canSend}
                title={enterSends ? 'Invio · Maiusc+Invio a capo' : 'Ctrl+Invio · Invio a capo'}
                onClick={send}
              >
                <span class="cn-btn__label">INVIA</span>
                <span class="cn-btn__icon">↗</span>
              </button>
            )}
          </span>
        </div>
      </div>
    </Lattice>
  );
}

/** Why the chat cannot run: no folder, or one not trusted; it sits at the top of the thread. */
export function NotReady({ session }: { session: SessionInfo }) {
  const noFolder = session.workspace === null;
  return (
    <div class="note">
      <span>×</span>
      <span>
        {noFolder
          ? 'Nessuna cartella aperta: apri quella in cui gli agenti devono lavorare.'
          : 'Cartella non attendibile (Workspace Trust): gli agenti possono leggere e modificare file solo in una cartella attendibile.'}
      </span>
      <button
        class="cn-btn cn-btn--outline cn-btn--sm"
        type="button"
        onClick={() => {
          post({ type: noFolder ? 'openFolder' : 'manageTrust' });
        }}
      >
        <span class="cn-btn__label">{noFolder ? 'APRI CARTELLA' : 'GESTISCI ATTENDIBILITÀ'}</span>
        <span class="cn-btn__icon">↗</span>
      </button>
    </div>
  );
}

export function Dock({
  session,
  items,
  numbers,
  theme,
  roles,
  monitor,
  usage,
  openSquad,
}: {
  session: SessionInfo | undefined;
  items: readonly ThreadItem[];
  numbers: ReadonlyMap<string, string>;
  theme: 'dark' | 'light';
  roles: RolesState | undefined;
  monitor: MonitorState;
  usage: readonly ProviderUsage[];
  openSquad: () => void;
}) {
  const permission = items.find(
    (i): i is Item<'permission'> => i.kind === 'permission' && !i.closed,
  );
  const approval = items.find((i): i is Item<'approval'> => i.kind === 'approval' && !i.closed);
  const question = items.find((i): i is Item<'question'> => i.kind === 'question' && !i.closed);
  const [to, setTo] = useState<RoleName>('leader');
  const recipient = roles ? (roles.chat?.[to] ?? roles.roles[to]) : undefined;
  return (
    <footer class="dock">
      <div class="dock__in">
        <aside class="dock__side" aria-label="Parli con">
          <RoleHud
            roles={roles}
            monitor={monitor}
            to={to}
            setTo={setTo}
            mode={session?.mode ?? 'manual'}
            setMode={setMode}
            busy={session?.busy ?? false}
          />
        </aside>
        <div class="colw">
          {permission ? (
            <>
              <PermissionSlab item={permission} theme={theme} />
              <div class="below">
                <span class="hint">
                  {permission.role === 'leader' ? 'IL LEADER' : 'L’IMPLEMENTATORE'} ASPETTA LA TUA
                  RISPOSTA · L’INVIO RIPRENDE DOPO
                </span>
                <button
                  class="cn-btn cn-btn--outline cn-btn--sm"
                  type="button"
                  aria-label="Ferma tutto e nega le richieste in attesa"
                  onClick={() => {
                    post({ type: 'stop' });
                  }}
                >
                  <span class="cn-btn__label">FERMA</span>
                  <span class="cn-btn__icon">■</span>
                </button>
              </div>
            </>
          ) : question ? (
            <QuestionFrame key={question.id} item={question} />
          ) : approval ? (
            <ApprovalFrame
              key={approval.id}
              item={approval}
              number={numbers.get(approval.id) ?? ''}
            />
          ) : (
            <Composer
              session={session}
              openSquad={openSquad}
              to={to}
              setTo={setTo}
              cli={recipient?.cli}
            />
          )}
        </div>
        <aside class="dock__side" aria-label="Utilizzo">
          <UsageHud
            usage={usage}
            threshold={session?.usageThreshold ?? 0}
            active={recipient?.cli ?? 'codex'}
          />
        </aside>
      </div>
    </footer>
  );
}
