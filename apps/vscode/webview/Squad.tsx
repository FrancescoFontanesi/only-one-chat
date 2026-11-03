// The Squad panel (ADR 0016): over the chat, veiled in 1-bit. Who works and
// how the work flows, the roles with their state and context, what happened,
// what waits, what changed, the models, the selected role's settings and the
// usage windows. Data from the host's stores; settings written as the roles view did.

import { useEffect, useState } from 'preact/hooks';
import type {
  MonitorAgent,
  MonitorState,
  ProviderUsage,
  RoleInfo,
  RoleName,
  RolesState,
  SessionInfo,
} from '../src/webview/protocol.js';
import type { ThreadItem } from './state.js';
import { clock, kilo, Meter, PERMISSIONS, PROVIDER, ROLE, RoleFields } from './ui.js';

const STATE = { working: '▶ Lavora', waiting: '▲ Aspetta te', idle: '○ Fermo' } as const;
const STATE_TAG = { working: '▶ LAVORA', waiting: '▲ ASPETTA TE', idle: '○ FERMO' } as const;
const LEVEL = { info: '■', warn: '▲', error: '×' } as const;

type Tab = 'events' | 'waiting' | 'changes' | 'models';

function agentOf(monitor: MonitorState, role: RoleName): MonitorAgent | undefined {
  return monitor.agents.find((a) => a.role === role);
}

function percent(agent: MonitorAgent | undefined): number | null {
  const context = agent?.context;
  return context?.window ? context.used / context.window : null;
}

function Node({
  role,
  info,
  agent,
  selected,
  select,
}: {
  role: RoleName;
  info: RoleInfo;
  agent: MonitorAgent | undefined;
  selected: boolean;
  select: () => void;
}) {
  return (
    <button
      class={selected ? 'fn fn--sel' : 'fn'}
      type="button"
      aria-pressed={selected}
      onClick={select}
    >
      <span class="fn__n">{ROLE[role]}</span>
      <span class="fn__m">
        {info.cli.toUpperCase()} · {info.modelName.toUpperCase()}
        {info.effort ? ` · ${info.effort.toUpperCase()}` : ''}
      </span>
      <span class="fn__s">{STATE_TAG[agent?.status ?? 'idle']}</span>
      {agent?.subagents.map((s, index) => (
        <span key={index} class="fn__m">
          └ {s.toUpperCase()} · ▶
        </span>
      ))}
    </button>
  );
}

function RoleRow({
  role,
  info,
  agent,
  selected,
  locked,
  select,
}: {
  role: RoleName;
  info: RoleInfo;
  agent: MonitorAgent | undefined;
  selected: boolean;
  locked: boolean;
  select: () => void;
}) {
  const value = percent(agent);
  return (
    <>
      <tr class={selected ? 'cn-accent' : ''} onClick={select}>
        <td>
          <span class="rn">{ROLE[role]}</span>
          <span class="rs">{PROVIDER[info.cli].toUpperCase()}</span>
        </td>
        <td>
          <span class="rv">{info.modelName}</span>
          <span class="rs">
            {(info.effort || 'nessun reasoning').toUpperCase()}
            {locked ? ' · BLOCCATO' : ''}
          </span>
        </td>
        <td>
          <span class="rv">{PERMISSIONS.find((p) => p.value === info.permission)?.short}</span>
        </td>
        <td>
          <span class="rv">{STATE[agent?.status ?? 'idle']}</span>
          {agent?.activity && <span class="rs">{agent.activity}</span>}
        </td>
        <td>
          {value !== null ? (
            <span class="mrow">
              <Meter value={value} />
              <span class="rv">{Math.round(value * 100)}%</span>
            </span>
          ) : (
            <span class="rv mut">—</span>
          )}
          {agent?.context && <span class="rs">{kilo(agent.context.used)} TOKEN</span>}
        </td>
      </tr>
      {agent?.subagents.map((label, index) => (
        <tr key={index} class="sub" onClick={select}>
          <td>
            <span class="rn">└ {label}</span>
            <span class="rs" style={{ paddingLeft: '16px' }}>
              SOTTO-AGENTE
            </span>
          </td>
          <td>
            <span class="rv mut">—</span>
          </td>
          <td>
            <span class="rv">Lettura</span>
          </td>
          <td>
            <span class="rv">▶ Lavora</span>
          </td>
          <td>
            <span class="rv mut">—</span>
          </td>
        </tr>
      ))}
    </>
  );
}

function windowCell(provider: ProviderUsage, name: '5h' | 'weekly') {
  const window = provider.windows.find((w) => w.name === name);
  if (!window) {
    return <td class="mut">{provider.provider === 'claude' ? 'DOPO UN TURNO' : '—'}</td>;
  }
  return (
    <td>
      <span class="mrow">
        <Meter value={window.usedPercent / 100} />
        {Math.round(window.usedPercent)}%
      </span>
    </td>
  );
}

export function Squad({
  session,
  roles,
  monitor,
  usage,
  items,
  theme,
  close,
  go,
}: {
  session: SessionInfo | undefined;
  roles: RolesState | undefined;
  monitor: MonitorState;
  usage: readonly ProviderUsage[];
  items: readonly ThreadItem[];
  theme: 'dark' | 'light';
  close: () => void;
  /** Closes the panel and shows an item of the thread. */
  go: (id: string) => void;
}) {
  const [selected, setSelected] = useState<RoleName>('leader');
  const [tab, setTab] = useState<Tab>('events');

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [close]);

  // The chat's own roles once it has run, else those of the next chat.
  const shown = (role: RoleName): RoleInfo | undefined => roles?.chat?.[role] ?? roles?.roles[role];
  const started = roles?.chat !== null && roles?.chat !== undefined;
  const leader = shown('leader');
  const implementer = shown('implementer');
  const waiting = items.filter(
    (i): i is Extract<ThreadItem, { kind: 'permission' | 'approval' }> =>
      (i.kind === 'permission' || i.kind === 'approval') && !i.closed,
  );
  const changes = items.filter(
    (i): i is Extract<ThreadItem, { kind: 'changes' }> => i.kind === 'changes',
  );
  const open = changes.flatMap((c) =>
    c.files.filter((f) => !c.decisions[f.path]).map((f) => ({ card: c, file: f })),
  );
  const counts = (status: MonitorAgent['status']) =>
    monitor.agents.filter((a) => a.status === status).length;
  const agent = agentOf(monitor, selected);
  const info = shown(selected);
  const next = roles?.roles[selected];
  const catalog = roles?.catalog ?? [];
  const firstWaiting =
    waiting.find((i) => i.kind === 'permission' && i.role === selected) ??
    (selected === 'leader' ? waiting.find((i) => i.kind === 'approval') : undefined);
  const threshold = session?.usageThreshold ?? 0;
  const past = usage.flatMap((p) =>
    p.windows
      .filter((w) => threshold > 0 && w.usedPercent >= threshold)
      .map((w) => `${p.provider.toUpperCase()} ${w.name === '5h' ? '5H' : '1W'}`),
  );

  return (
    <div class="stage stage--layer" data-theme={theme}>
      <div class="veil veil--mezzatinta" onClick={close} />
      <section class="sqw" role="dialog" aria-label="Pannello Squad">
        <header class="sqw__h">
          <h2 class="t-title">Squad</h2>
          <span class="crumb">{(session?.title || 'Nuova chat').toUpperCase()}</span>
          <div class="bar__r">
            {counts('waiting') > 0 && (
              <span class="cn-tag cn-tag--ink">▲ {counts('waiting')} ASPETTA TE</span>
            )}
            {counts('working') > 0 && (
              <span class="cn-tag cn-tag--ink">▶ {counts('working')} LAVORA</span>
            )}
            {counts('idle') > 0 && <span class="cn-tag">○ {counts('idle')} FERMO</span>}
            <button class="cn-btn cn-btn--outline cn-btn--sm" type="button" onClick={close}>
              <span class="cn-btn__label">CHIUDI · ESC</span>
              <span class="cn-btn__icon">×</span>
            </button>
          </div>
        </header>

        <div class="sqw__m">
          {leader && implementer && (
            <section aria-label="Flusso della squadra">
              <div class="sh">
                <span class="cn-tag">
                  <b>01/</b> FLUSSO
                </span>
                <span class="cn-tag">
                  DELEGHE · <b>{session?.mode === 'auto' ? 'AUTOMATICHE' : 'APPROVO IO'}</b>
                </span>
              </div>
              <div class="flow">
                <div class="fn" role="presentation">
                  <span class="fn__n">Tu</span>
                  <span class="fn__m">INGRESSO</span>
                </div>
                <div class="fc">
                  <span class="fc__t">MESSAGGIO →</span>
                  <span class="fc__l" />
                </div>
                <Node
                  role="leader"
                  info={leader}
                  agent={agentOf(monitor, 'leader')}
                  selected={selected === 'leader'}
                  select={() => {
                    setSelected('leader');
                  }}
                />
                <div class="fc">
                  <span class="fc__t">
                    <b>DELEGA →</b>
                  </span>
                  <span class="fc__l" />
                  <span class="fc__l fc__l--d" />
                  <span class="fc__t">← RAPPORTO</span>
                </div>
                <Node
                  role="implementer"
                  info={implementer}
                  agent={agentOf(monitor, 'implementer')}
                  selected={selected === 'implementer'}
                  select={() => {
                    setSelected('implementer');
                  }}
                />
                <div class="fu">
                  <span>DIRETTO → IMPLEMENTATORE</span>
                </div>
              </div>
            </section>
          )}

          {leader && implementer && (
            <section aria-label="Ruoli">
              <div class="sh">
                <span class="cn-tag">
                  <b>02/</b> RUOLI
                </span>
                <span class="cn-tag">{started ? 'DI QUESTA CHAT' : 'PER LA PROSSIMA CHAT'}</span>
              </div>
              <table class="ros">
                <colgroup>
                  <col style={{ width: '24%' }} />
                  <col style={{ width: '22%' }} />
                  <col style={{ width: '14%' }} />
                  <col style={{ width: '24%' }} />
                  <col style={{ width: '16%' }} />
                </colgroup>
                <thead>
                  <tr>
                    <th scope="col">RUOLO</th>
                    <th scope="col">MODELLO</th>
                    <th scope="col">PERMESSI</th>
                    <th scope="col">STATO</th>
                    <th scope="col">CONTESTO</th>
                  </tr>
                </thead>
                <tbody>
                  <RoleRow
                    role="leader"
                    info={leader}
                    agent={agentOf(monitor, 'leader')}
                    selected={selected === 'leader'}
                    locked={started}
                    select={() => {
                      setSelected('leader');
                    }}
                  />
                  <RoleRow
                    role="implementer"
                    info={implementer}
                    agent={agentOf(monitor, 'implementer')}
                    selected={selected === 'implementer'}
                    locked={false}
                    select={() => {
                      setSelected('implementer');
                    }}
                  />
                </tbody>
              </table>
            </section>
          )}

          <section class="act" aria-label="Attività">
            <div class="tabs" role="tablist">
              {(
                [
                  ['events', 'EVENTI', null],
                  ['waiting', 'IN ATTESA', waiting.length],
                  ['changes', 'MODIFICHE', open.length],
                  ['models', 'MODELLI', null],
                ] as const
              ).map(([id, label, count]) => (
                <button
                  key={id}
                  class={tab === id ? 'tab cn-accent' : 'tab'}
                  type="button"
                  role="tab"
                  aria-selected={tab === id}
                  onClick={() => {
                    setTab(id);
                  }}
                >
                  {label} {count !== null && count > 0 && <b>{count}</b>}
                </button>
              ))}
            </div>
            {tab === 'events' &&
              (monitor.events.length === 0 ? (
                <p class="hint">Nessun evento in questa chat.</p>
              ) : (
                <ol class="log">
                  {monitor.events.map((event, index) => (
                    <li key={`${String(event.at)}-${String(index)}`}>
                      <span>{clock(event.at)}</span>
                      <span>{event.text}</span>
                      <span>{LEVEL[event.level]}</span>
                    </li>
                  ))}
                </ol>
              ))}
            {tab === 'waiting' &&
              (waiting.length === 0 ? (
                <p class="hint">Nessuna richiesta aperta.</p>
              ) : (
                <div class="ilist">
                  {waiting.map((i) => (
                    <div key={i.id}>
                      <span>
                        {i.kind === 'permission'
                          ? `▲ Permesso · ${ROLE[i.role].toLowerCase()} · ${i.summary}`
                          : `▲ ${i.approval === 'delegation' ? 'Delega' : 'Rapporto'} da approvare · ${i.from} → ${i.to}`}
                      </span>
                      <button
                        class="cn-btn cn-btn--text"
                        type="button"
                        onClick={() => {
                          go(i.id);
                        }}
                      >
                        <span class="cn-btn__label">VAI ↗</span>
                      </button>
                    </div>
                  ))}
                </div>
              ))}
            {tab === 'changes' &&
              (changes.length === 0 ? (
                <p class="hint">Nessuna modifica in questa chat.</p>
              ) : (
                <div class="ilist">
                  {changes.flatMap((card) =>
                    card.files.map((file) => (
                      <div key={`${card.id}-${file.path}`}>
                        <span>{file.path}</span>
                        <span>
                          {card.decisions[file.path] === 'accepted'
                            ? '■ ACCETTATO'
                            : card.decisions[file.path] === 'rejected'
                              ? '× RIFIUTATO'
                              : file.binary
                                ? 'BINARIO'
                                : `+${String(file.added)} −${String(file.removed)}`}
                        </span>
                      </div>
                    )),
                  )}
                  {open[0] && (
                    <div>
                      <span class="mut">{open.length} da rivedere</span>
                      <button
                        class="cn-btn cn-btn--text"
                        type="button"
                        onClick={() => {
                          if (open[0]) go(open[0].card.id);
                        }}
                      >
                        <span class="cn-btn__label">RIVEDI ↗</span>
                      </button>
                    </div>
                  )}
                </div>
              ))}
            {tab === 'models' && (
              <div class="ilist">
                {roles?.fake && (
                  <div>
                    <span>▲ CLI FINTI ATTIVI</span>
                    <span class="mut">MODELLI DI PROVA</span>
                  </div>
                )}
                {roles?.catalog.map((c) => (
                  <div key={c.cli}>
                    <span>
                      {c.cli.toUpperCase()} ·{' '}
                      {c.status === 'ready'
                        ? '■ DISPONIBILE'
                        : c.status === 'loading'
                          ? '○ IN LETTURA'
                          : `× ${c.note ?? 'NON DISPONIBILE'}`}
                    </span>
                    <span class="mut">{c.models.map((m) => m.name).join(' · ')}</span>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>

        <aside class="sqw__s" aria-label="Ruolo selezionato">
          {info && next && (
            <>
              <div class="ctl">
                <span class="cn-tag">
                  <b>SEL/</b> RUOLO
                </span>
                <span class={agent?.status === 'idle' || !agent ? 'cn-tag' : 'cn-tag cn-tag--ink'}>
                  {STATE_TAG[agent?.status ?? 'idle']}
                </span>
              </div>
              <div>
                <h3 class="t-title">{ROLE[selected]}</h3>
                <span class="t-data mut">
                  {PROVIDER[info.cli]} · {started ? 'in questa chat' : 'dalla prossima chat'}
                </span>
              </div>
              <RoleFields
                role={selected}
                info={
                  // The leader's model stays the chat's; the rest are the settings it writes.
                  selected === 'leader' && started
                    ? { ...next, model: info.model, modelName: info.modelName }
                    : next
                }
                catalog={catalog}
                locked={selected === 'leader' && started}
                providerFixed={selected === 'leader' && started}
                {...(started && next.cli !== info.cli
                  ? {
                      providerNote: `QUESTA CHAT RESTA SU ${PROVIDER[info.cli].toUpperCase()}: IL PROVIDER VALE DALLA PROSSIMA CHAT`,
                    }
                  : selected === 'implementer' && started
                    ? { providerNote: 'UN CAMBIO DI PROVIDER VALE DALLA PROSSIMA CHAT' }
                    : {})}
              />
              <div class="kvl">
                <div>
                  <span>ORA</span>
                  <span>{agent?.activity ?? '—'}</span>
                </div>
                <div>
                  <span>SOTTO-AGENTI</span>
                  <span>
                    {agent && agent.subagents.length > 0 ? agent.subagents.join(' · ') : '—'}
                  </span>
                </div>
              </div>
              {firstWaiting && (
                <button
                  class="cn-btn cn-btn--text"
                  type="button"
                  style={{ alignSelf: 'flex-start' }}
                  onClick={() => {
                    go(firstWaiting.id);
                  }}
                >
                  <span class="cn-btn__label">
                    {firstWaiting.kind === 'permission' ? 'VAI AL PERMESSO ↗' : 'VAI ALLA DELEGA ↗'}
                  </span>
                </button>
              )}
            </>
          )}

          <section style={{ marginTop: 'auto' }} aria-label="Utilizzo">
            <div class="sh">
              <span class="cn-tag">
                <b>03/</b> UTILIZZO
              </span>
              <span class="cn-tag">5H · 1W</span>
            </div>
            <table class="mtab" style={{ marginTop: '8px' }}>
              <thead>
                <tr>
                  <th scope="col">PROVIDER</th>
                  <th scope="col">5H</th>
                  <th scope="col">1W</th>
                </tr>
              </thead>
              <tbody>
                {usage.map((p) => (
                  <tr key={p.provider} title={p.note}>
                    <td>{p.provider.toUpperCase()}</td>
                    {windowCell(p, '5h')}
                    {windowCell(p, 'weekly')}
                  </tr>
                ))}
              </tbody>
            </table>
            {past.map((label) => (
              <p key={label} class="hint" style={{ margin: '8px 0 0' }}>
                ▲ {label} OLTRE LA SOGLIA DEL {threshold}%
              </p>
            ))}
          </section>
        </aside>
      </section>
    </div>
  );
}
