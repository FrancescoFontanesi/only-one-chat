// The dock of the Chat board (ADR 0016): what waits for the user takes the
// composer's place (a permission as the view's one Slab, a delegation or a
// report to approve as an ink frame), else the composer: one lattice cell,
// closed on its four sides with a + at each corner, the text and, under a
// rule, one line with the recipient, the route and the delegations as picks,
// the context and the send. `@` in the text attaches a file, `/` lists the
// commands. On a wide panel, beside the composer, the two dials (Hud.tsx):
// who you talk to, and the providers' usage.

import { useEffect, useRef, useState } from 'preact/hooks';
import {
  parseHostMessage,
  type ApprovalMode,
  type MonitorState,
  type ProviderUsage,
  type RolesState,
  type PermitDecision,
  type RoleName,
  type Route,
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

function ApprovalFrame({ item, number }: { item: Item<'approval'>; number: string }) {
  const [text, setText] = useState(item.text);
  const delegation = item.approval === 'delegation';
  const edited = text !== item.text;
  const decide = (action: 'approve' | 'edit' | 'cancel') => {
    post(
      action === 'edit'
        ? { type: 'decide', id: item.id, action, text }
        : { type: 'decide', id: item.id, action },
    );
  };
  return (
    <section
      class="cn-frame cn-frame--ink apr"
      aria-label={delegation ? 'Delega da approvare' : 'Rapporto da approvare'}
    >
      <header class="cn-frame__head cn-accent">
        <span class="cn-tag">
          <b>
            {delegation ? '→ D' : '← R'}
            {number}
          </b>{' '}
          {delegation ? 'DELEGA' : 'RAPPORTO'} · {item.from} → {item.to}
        </span>
        <span class="cn-tag">APPROVO IO</span>
      </header>
      <div class="cn-frame__body">
        <div class="ctl">
          <label class="cn-tag" for="brief">
            {delegation ? 'BRIEF · MODIFICABILE' : 'MESSAGGIO AL LEADER · MODIFICABILE'}
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
      </div>
      <footer class="cn-frame__foot">
        <span class="hint">
          {delegation
            ? 'L’IMPLEMENTATORE PARTE SOLO DOPO LA TUA CONFERMA'
            : 'IL LEADER LO LEGGE SOLO DOPO LA TUA CONFERMA'}
        </span>
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
                <span class="cn-btn__label">APPROVA ORIGINALE</span>
              </button>
              <button
                class="cn-btn cn-btn--sm"
                type="button"
                onClick={() => {
                  decide('edit');
                }}
              >
                <span class="cn-btn__label">APPROVA MODIFICATO</span>
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
              <span class="cn-btn__label">APPROVA</span>
              <span class="cn-btn__icon">→</span>
            </button>
          )}
        </div>
      </footer>
    </section>
  );
}

export const ROUTES: readonly { value: Route | 'auto'; label: string; title: string }[] = [
  { value: 'auto', label: 'DECIDE LUI', title: 'Il leader sceglie: risponde, chiede o delega' },
  { value: 'delega', label: 'DELEGA', title: 'Il leader scrive un brief all’implementatore' },
  { value: 'fai', label: 'FAI TU', title: 'Il leader lavora da sé' },
  { value: 'chiedi', label: 'CHIEDI', title: 'Il leader chiede prima di procedere' },
];

interface Command {
  name: string;
  hint: string;
  run: () => void;
}

/**
 * The open popover: the files for `@`, the commands for `/`. `start` is where
 * its word begins in the text, null when it was opened from the toolbar.
 */
interface Pop {
  kind: 'file' | 'command';
  start: number | null;
  query: string;
}

const RECIPIENTS: readonly { value: RoleName; label: string; title: string }[] = [
  { value: 'leader', label: 'LEADER', title: 'Il leader risponde, chiede o delega' },
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
  route,
  setRoute,
}: {
  session: SessionInfo | undefined;
  openSquad: () => void;
  to: RoleName;
  setTo: (to: RoleName) => void;
  route: Route | 'auto';
  setRoute: (route: Route | 'auto') => void;
}) {
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<readonly string[]>([]);
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

  const commands: Command[] = [
    ...ROUTES.filter((r) => r.value !== 'auto').map((r) => ({
      name: r.value,
      hint: `Via · ${r.title}`,
      run: () => {
        setTo('leader');
        setRoute(r.value);
      },
    })),
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
  const commandOptions =
    pop?.kind === 'command'
      ? commands.filter((c) => c.name.startsWith(pop.query.toLowerCase()))
      : [];
  const optionCount = pop?.kind === 'file' ? fileOptions.length : commandOptions.length;

  const follow = (value: string, caret: number) => {
    const file = wordAt(value, caret, '@');
    if (file) {
      openFiles(file.start, file.query);
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
      ...(to === 'leader' && route !== 'auto' ? { route } : {}),
    });
    setText('');
    setAttachments([]);
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
      {pop && optionCount > 0 && (
        <section class="pop pop--up cn-frame cn-frame--ink" role="listbox">
          <div class="cn-frame__head pop__h">
            <span class="t-label">{pop.kind === 'file' ? 'ALLEGA FILE' : 'COMANDI'}</span>
            <span class="t-label mut">{pop.kind === 'file' ? '@' : '/'}</span>
          </div>
          {pop.kind === 'file'
            ? fileOptions.map((path, index) => (
                <button key={path} {...option(index)}>
                  <span class="pick__n">{path}</span>
                  <span class="pick__m">{path.endsWith('/') ? 'CARTELLA' : ''}</span>
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
        {attachments.length > 0 && (
          <div class="atts cmp__atts">
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
                  ? 'Scrivi al leader · @ allega un file · / comandi'
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
                label="Via"
                value={route}
                options={ROUTES}
                disabled={!ready}
                onChange={setRoute}
              />
            ) : (
              <span class="pk pk--off pk--compact">
                <span class="pk__v">DIRETTO</span>
              </span>
            )}
          </span>
          <Pick
            short="DELEGHE"
            label="Deleghe"
            value={session?.mode ?? 'manual'}
            options={[
              { value: 'manual', label: 'APPROVO IO', title: 'Ogni delega e rapporto aspetta te' },
              { value: 'auto', label: 'AUTO', title: 'Deleghe e rapporti passano da soli' },
            ]}
            onChange={(mode: ApprovalMode) => {
              post({ type: 'setMode', mode });
            }}
          />
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
  const [to, setTo] = useState<RoleName>('leader');
  const [route, setRoute] = useState<Route | 'auto'>('auto');
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
            route={route}
            setRoute={setRoute}
            routes={ROUTES}
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
              route={route}
              setRoute={setRoute}
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
