// The composer of the dock (ADR 0016): one lattice cell with the text and, under
// a rule, the recipient and the delivery as picks, the context and the send.
// `@` in the text attaches a file, `$` names a skill of the recipient's CLI
// (ADR 0019), `/` lists the commands.

import { useContext, useEffect, useRef, useState } from 'preact/hooks';
import {
  parseHostMessage,
  type ApprovalMode,
  type Cli,
  type HostToWebviewMessage,
  type TurnRole,
  type SessionInfo,
} from '../src/webview/protocol.js';
import { matchPaths } from './mentions.js';
import { Lattice } from './lattice.js';
import { Progress } from './motion.js';
import { wordAt } from './threadModel.js';
import { kilo, Meter, Pick, post, ShownNode } from './ui.js';

/** How the leader's delegations reach the implementer (ADR 0018). */
const DELIVERY: readonly { value: ApprovalMode; label: string; title: string }[] = [
  { value: 'auto', label: 'AUTO', title: 'Il brief parte subito per l’implementatore' },
  {
    value: 'manual',
    label: 'MANUALE',
    title: 'Il brief aspetta te, modificabile; la chat si ferma finché non lo invii o annulli',
  },
];

export const setMode = (mode: ApprovalMode) => {
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

const RECIPIENTS: readonly { value: TurnRole; label: string; title: string }[] = [
  { value: 'leader', label: 'LEADER', title: 'Ragioni con il leader; delega quando glielo chiedi' },
  {
    value: 'implementer',
    label: 'IMPLEMENTATORE',
    title: 'Diretto all’implementatore: il revisore lo rivede, poi il leader legge la revisione',
  },
  {
    value: 'reviewer',
    label: 'REVISORE',
    title:
      'Chiedi una revisione dell’ultimo lavoro: il leader la legge con il tuo prossimo messaggio',
  },
];

export function Composer({
  session,
  openSquad,
  waiting,
  to,
  setTo,
  cli,
  reviewerOn,
}: {
  session: SessionInfo | undefined;
  openSquad: () => void;
  waiting: number;
  to: TurnRole;
  setTo: (to: TurnRole) => void;
  /** The recipient's CLI, whose skills `$` lists. */
  cli: Cli | undefined;
  /** The reviewer is on (ADR 0033): only then it takes a review request. */
  reviewerOn: boolean;
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
  /** A node's thread is shown (ADR 0023): the message goes to it, on its own. */
  const node = useContext(ShownNode);
  const busy = node ? (session?.busyNodes ?? []).includes(node.id) : (session?.busy ?? false);
  const ready =
    session !== undefined &&
    session.workspace !== null &&
    session.trusted &&
    node?.removed !== true;
  const reviewerOff = !node && to === 'reviewer' && !reviewerOn;
  const canSend = ready && !busy && !reviewerOff && text.trim() !== '';
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
      name: 'rev',
      hint: 'Chiedi una revisione al revisore',
      run: () => {
        setTo('reviewer');
      },
    },
    {
      name: 'allega',
      hint: 'Allega file al contesto',
      run: () => {
        post({ type: 'attachFiles' });
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
  /** `@path ` in the text where the `@` was typed. */
  const mention = (start: number, path: string) => {
    const token = `@${path} `;
    const rest = text.slice(start + 1 + (pop?.query.length ?? 0));
    setText(text.slice(0, start) + token + rest.replace(/^ /, ''));
    requestAnimationFrame(() => {
      box.current?.setSelectionRange(start + token.length, start + token.length);
      box.current?.focus();
    });
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
    if (pop.start !== null && pop.kind !== 'file') removeWord(pop.start, pop.query);
    setPop(null);
    if (pop.kind === 'file') {
      // `@` names a path in the text, as in Claude Code and Codex; it reaches the agent as the
      // path. Attaching is the + button's (ADR 0026).
      const path = fileOptions[index];
      if (path && pop.start !== null) mention(pop.start, path);
      else if (path) attach(path);
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
    // The attachments go apart from the text: the host adds them to the context (ADR 0026).
    post({
      type: 'send',
      text,
      ...(attachments.length > 0 ? { attachments } : {}),
      ...(node ? { node: node.id } : to !== 'leader' ? { to } : {}),
      ...(skill && !node && to !== 'reviewer' ? { skill } : {}),
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

  const context = node ? session?.nodeContext[node.id] : session?.context[to];
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
              node?.removed
                ? `${node.name} non è più sulla lavagna: la sua conversazione si legge soltanto.`
                : !ready
                  ? 'Invio non disponibile finché la chat non è pronta.'
                  : node
                    ? `Scrivi a ${node.name} · una conversazione sua, il leader non la vede`
                    : to === 'leader'
                      ? 'Scrivi al leader · @ nomina un file · $ skill · / comandi'
                      : to === 'reviewer'
                        ? reviewerOn
                          ? 'Chiedi una revisione dell’ultimo lavoro · il leader la leggerà dopo'
                          : 'Il revisore è spento: accendilo da Squad o dalla ghiera'
                        : reviewerOn
                          ? 'Scrivi all’implementatore · il revisore lo rivede, il leader legge dopo'
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
            {node ? (
              <span class="pk pk--off">
                <span class="pk__k">A</span>
                <span class="pk__v">{node.name.toUpperCase()}</span>
              </span>
            ) : (
              <Pick
                short="A"
                label="Destinatario"
                value={to}
                options={RECIPIENTS}
                disabled={!ready}
                onChange={setTo}
              />
            )}
            {to === 'leader' && !node ? (
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
          <button
            class="cn-btn cn-btn--outline cn-btn--sm cmp__add"
            type="button"
            title="Allega file al contesto del messaggio"
            aria-label="Allega file"
            disabled={!ready}
            onClick={() => {
              post({ type: 'attachFiles' });
            }}
          >
            <span class="cn-btn__label">+</span>
          </button>
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
            ) : context ? (
              // The model's window is not reported: the tokens alone.
              <b>{kilo(context.used)}</b>
            ) : (
              <b>—</b>
            )}
          </span>
          {/* Squad, in the middle of the box: where nodes and groups are made and chosen. */}
          <button
            class="cn-btn--bare cn-btn cn-btn--outline cn-btn--sm cmp__squad sq-open"
            type="button"
            aria-label={`Apri il pannello Squad${waiting > 0 ? `, ${String(waiting)} richieste in attesa` : ''}`}
            onClick={openSquad}
          >
            <span class="cn-btn__label">SQUAD</span>
            {/* One per request that waits for you (ADR 0021). */}
            {waiting > 0 && (
              <span class="sq-badge" aria-hidden="true">
                {waiting > 99 ? '99+' : String(waiting)}
              </span>
            )}
          </button>
          <span class="cmp__send">
            {busy ? (
              <>
                <Progress label="IN CORSO" cells={8} />
                <button
                  class="cn-btn cn-btn--sm"
                  type="button"
                  aria-label="Ferma tutto e nega le richieste in attesa"
                  onClick={() => {
                    post(node ? { type: 'stop', node: node.id } : { type: 'stop' });
                  }}
                >
                  <span class="cn-btn__label">FERMA</span>
                  <span class="cn-btn__icon">■</span>
                </button>
              </>
            ) : (
              <button
                class="cn-btn--bare cn-btn cn-btn--outline cn-btn--sm"
                type="button"
                disabled={!canSend}
                title={enterSends ? 'Invio · Maiusc+Invio a capo' : 'Ctrl+Invio · Invio a capo'}
                onClick={send}
              >
                <span class="cn-btn__label">INVIA</span>
              </button>
            )}
          </span>
        </div>
      </div>
    </Lattice>
  );
}
