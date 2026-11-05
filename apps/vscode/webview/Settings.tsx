// The settings page (ADR 0013, 0016), composed as the design system's printed
// lattice slides (RefLatticeSlidesPrint): a stack of Lattices on the same
// fourteen columns (a margin, twelve, a margin), broken lines with a + at each
// junction, dense cells. The cover: the mark, the sections and the way out, a
// bracket title, the search and where to save. Then one sheet per section: a
// head row with its index and page, its title and one giant numeral in the
// lead column, each setting as three cells (its name and origin, what it is,
// its value). No motion. VS Code's own settings underneath.

import { type ComponentChildren, Fragment } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import {
  parseHostMessage,
  type SettingItem,
  type SettingValue,
  type SettingsState,
  type SettingsTarget,
} from '../src/webview/protocol.js';
import { Lattice } from './lattice.js';
import { Opts, post, PROVIDER, ROLE, RoleFields, useTheme } from './ui.js';

const SCOPE = { user: '■ Utente', workspace: '■ Cartella' } as const;

/** What a section is for, under its title. */
const ABOUT: Record<string, string> = {
  Ruoli: 'Chi guida e chi esegue nelle prossime chat: provider, modello, reasoning, permessi.',
};

const slug = (title: string) =>
  title
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

/** A text written when it loses focus, not at each key; a list is comma-separated. */
function TextField({
  item,
  multiline,
  write,
}: {
  item: SettingItem;
  multiline: boolean;
  write: (value: SettingValue) => void;
}) {
  const list = item.kind === 'list';
  const shown = Array.isArray(item.value) ? item.value.join(', ') : String(item.value);
  const [text, setText] = useState(shown);
  useEffect(() => {
    setText(shown);
  }, [shown]);
  const commit = () => {
    if (text === shown) return;
    write(
      list
        ? text
            .split(',')
            .map((part) => part.trim())
            .filter(Boolean)
        : text,
    );
  };
  return multiline ? (
    <textarea
      aria-label={item.label}
      value={text}
      onInput={(event) => {
        setText((event.target as HTMLTextAreaElement).value);
      }}
      onBlur={commit}
    />
  ) : (
    <input
      type="text"
      aria-label={item.label}
      value={text}
      placeholder={list ? 'valori separati da virgole' : 'vuoto'}
      onInput={(event) => {
        setText((event.target as HTMLInputElement).value);
      }}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') commit();
      }}
    />
  );
}

const pad = (n: number) => String(n).padStart(2, '0');
const area = (r0: number, c0: number, r1: number, c1: number) => ({
  gridArea: `${String(r0)} / ${String(c0)} / ${String(r1)} / ${String(c1)}`,
});

/** A setting's value, as the control its kind asks for. */
function Control({ item, write }: { item: SettingItem; write: (value: SettingValue) => void }) {
  switch (item.kind) {
    case 'boolean':
      return (
        <Opts
          label={item.label}
          value={item.value ? 'yes' : 'no'}
          options={[
            { value: 'yes', label: 'Sì' },
            { value: 'no', label: 'No' },
          ]}
          onChange={(value) => {
            write(value === 'yes');
          }}
        />
      );
    case 'enum':
      return (
        <Opts
          label={item.label}
          value={String(item.value)}
          options={(item.options ?? []).map((o) => ({ value: o.value, label: o.label }))}
          onChange={write}
        />
      );
    case 'number':
      return (
        <label class="cn-field">
          <span class="cn-field__box" data-prompt="#">
            <input
              type="number"
              aria-label={item.label}
              min={item.min}
              max={item.max}
              value={String(item.value)}
              onChange={(event) => {
                const value = Number((event.target as HTMLInputElement).value);
                if (Number.isFinite(value)) write(value);
              }}
            />
          </span>
        </label>
      );
    default:
      return (
        <label class={item.kind === 'text' ? 'cn-field sx-area' : 'cn-field'}>
          <span class="cn-field__box">
            <TextField item={item} multiline={item.kind === 'text'} write={write} />
          </span>
        </label>
      );
  }
}

/** One entry of a sheet: a head row, then what it is beside its value. */
interface Entry {
  key: string;
  name: string;
  side?: ComponentChildren;
  about: ComponentChildren;
  value: ComponentChildren;
}

/** A setting as an entry: its name and where its value comes from, what it is, the value. */
function settingEntry(item: SettingItem, target: SettingsTarget): Entry {
  // A setting that never comes from a folder is always written for the user.
  const where: SettingsTarget = item.userOnly ? 'user' : target;
  const write = (value: SettingValue) => {
    post({ type: 'setSetting', key: item.key, value, target: where });
  };
  const resettable =
    item.scope !== 'default' && (item.scope === 'workspace') === (where === 'workspace');
  return {
    key: item.key,
    name: item.label,
    side: (
      <>
        {item.scope === 'default' ? (
          <span class="cn-tag">○ Predefinito</span>
        ) : (
          <span class="cn-tag cn-tag--ink">{SCOPE[item.scope]}</span>
        )}
        {item.userOnly && <span class="cn-tag">Solo utente</span>}
        {resettable && (
          <button
            class="cn-btn cn-btn--text"
            type="button"
            title="Toglie il valore da qui: vale quello dell’utente o il predefinito"
            onClick={() => {
              post({ type: 'setSetting', key: item.key, target: where });
            }}
          >
            <span class="cn-btn__label">Ripristina</span>
          </button>
        )}
      </>
    ),
    about: <p class="sl-d">{item.description}</p>,
    value: <Control item={item} write={write} />,
  };
}

/**
 * A section as one sheet: a head row (index and title; the page), the margins,
 * the lead column (title, what it is for, one giant numeral), then each entry
 * as a head row over two cells.
 */
function Sheet({
  id,
  index,
  total,
  title,
  count,
  entries,
}: {
  id: string;
  index: number;
  total: number;
  title: string;
  count: string;
  entries: readonly Entry[];
}) {
  const number = pad(index);
  const end = 2 + 2 * entries.length;
  const lead = (
    <>
      <span class="cn-tag">
        <b>{number}/</b> Sezione
      </span>
      <h2 class="t-heading cn-caps sl-title">{title}</h2>
      {ABOUT[title] && <p class="t-body mut sl-about">{ABOUT[title]}</p>}
      <span class="cn-tag">{count}</span>
    </>
  );
  return (
    <Lattice
      class="sl-cols sl-sheet"
      edges={{ top: true }}
      rows={`48px ${entries.map(() => '40px auto').join(' ')}`}
    >
      <div class="cn-cell cn-cell--row sl-anchor" id={id} style={area(1, 1, 2, 8)}>
        <span class="cn-tag">
          <b>{number}/</b> {title}
        </span>
      </div>
      <div class="cn-cell cn-cell--row sl-end" style={area(1, 8, 2, 15)}>
        <span class="cn-tag">Only/One · Impostazioni</span>
        <span class="cn-tag">
          <b>{number}</b> / {pad(total)}
        </span>
      </div>
      <div class="cn-cell cn-cell--margin" style={area(2, 1, end, 2)} />
      <div class="cn-cell cn-cell--margin" style={area(2, 14, end, 15)} />
      {entries.length > 1 ? (
        <>
          <div class="cn-cell sl-lead" style={area(2, 2, 4, 5)}>
            {lead}
          </div>
          <div class="cn-cell cn-cell--flush sl-numc" style={area(4, 2, end, 5)}>
            <span class="sl-num" aria-hidden="true">
              {number}
            </span>
          </div>
        </>
      ) : (
        <div class="cn-cell sl-lead" style={area(2, 2, end, 5)}>
          {lead}
          <span class="sl-num sl-num--in" aria-hidden="true">
            {number}
          </span>
        </div>
      )}
      {entries.map((entry, i) => {
        const r = 2 + 2 * i;
        return (
          <Fragment key={entry.key}>
            <div class="cn-cell cn-cell--row sl-eh" style={area(r, 5, r + 1, 14)}>
              <span class="cn-tag cn-tag--ink">
                <b>{pad(i + 1)}</b> {entry.name}
              </span>
              {entry.side && <span class="sl-side">{entry.side}</span>}
            </div>
            <div class="cn-cell sl-eb" style={area(r + 1, 5, r + 2, 9)}>
              {entry.about}
            </div>
            <div class="cn-cell sl-ev" style={area(r + 1, 9, r + 2, 14)}>
              {entry.value}
            </div>
          </Fragment>
        );
      })}
    </Lattice>
  );
}

export function SettingsApp() {
  const theme = useTheme();
  const [state, setState] = useState<SettingsState>();
  const [target, setTarget] = useState<SettingsTarget>('user');
  const [query, setQuery] = useState('');
  const [current, setCurrent] = useState('ruoli');

  useEffect(() => {
    const onMessage = (event: MessageEvent<unknown>) => {
      const message = parseHostMessage(event.data);
      if (message?.type === 'settings') setState(message.settings);
    };
    window.addEventListener('message', onMessage);
    post({ type: 'ready' });
    return () => {
      window.removeEventListener('message', onMessage);
    };
  }, []);

  if (!state) {
    return (
      <div class="cn app app--page" data-theme={theme}>
        <p class="hint sl-wait">Lettura delle impostazioni…</p>
      </div>
    );
  }
  const q = query.trim().toLowerCase();
  const sections = [
    { id: 'ruoli', title: 'Ruoli' },
    ...state.sections.map((s) => ({ id: slug(s.title), title: s.title })),
  ];
  const go = (id: string) => {
    setCurrent(id);
    document.getElementById(id)?.scrollIntoView({ block: 'start' });
  };
  const providers = sections.find((s) => s.title === 'Provider');
  const showRoles = q === '' || 'ruoli modello reasoning permessi provider'.includes(q);
  const visible = state.sections
    .map((section, index) => ({
      section,
      index,
      items: section.items.filter(
        (item) =>
          q === '' ||
          item.label.toLowerCase().includes(q) ||
          item.description.toLowerCase().includes(q),
      ),
    }))
    .filter((s) => s.items.length > 0);
  const roleEntries: Entry[] = (['leader', 'implementer'] as const).map((role, index) => {
    const info = state.roles.roles[role];
    return {
      key: role,
      name: `${index === 0 ? 'A' : 'B'} / ${ROLE[role]}`,
      side: <span class="cn-tag">{PROVIDER[info.cli]}</span>,
      about: (
        <>
          <span class="sl-model">{info.modelName}</span>
          <p class="sl-d">
            {role === 'leader'
              ? 'Nella chat il modello si blocca al primo messaggio.'
              : 'In chat, un altro provider vale dalla chat successiva.'}
          </p>
        </>
      ),
      value: <RoleFields still role={role} info={info} catalog={state.roles.catalog} />,
    };
  });
  const total = sections.length;

  return (
    <div class="cn app app--page" data-theme={theme}>
      <div class="sl-scroll">
        <div class="sl-page">
          <Lattice class="sl-cols sl-cover">
            <div class="cn-cell cn-cell--row" style={area(1, 1, 2, 4)}>
              <span class="lt-mark">Only/One</span>
            </div>
            <nav class="cn-cell cn-cell--row sl-nav" aria-label="Sezioni" style={area(1, 4, 2, 11)}>
              {sections.map((section, index) => (
                <a
                  key={section.id}
                  href={`#${section.id}`}
                  class={current === section.id ? 'cn-tag cn-tag--ink' : 'cn-tag'}
                  aria-current={current === section.id}
                  onClick={(event) => {
                    event.preventDefault();
                    go(section.id);
                  }}
                >
                  <b>{pad(index + 1)}</b> {section.title}
                </a>
              ))}
            </nav>
            <div class="cn-cell cn-cell--row sl-end" style={area(1, 11, 2, 15)}>
              <button
                class="cn-btn cn-btn--text"
                type="button"
                onClick={() => {
                  post({ type: 'openNativeSettings' });
                }}
              >
                <span class="cn-btn__label">VS Code ↗</span>
              </button>
              <button
                class="cn-btn cn-btn--sm"
                type="button"
                onClick={() => {
                  post({ type: 'showChat' });
                }}
              >
                <span class="cn-btn__label">Chat</span>
                <span class="cn-btn__icon">←</span>
              </button>
            </div>
            <div class="cn-cell cn-cell--margin" style={area(2, 1, 3, 2)} />
            <div class="cn-cell cn-cell--center sl-hero" style={area(2, 2, 3, 14)}>
              <header class="cn-heading cn-heading--center cn-bracket">
                <h1 class="t-caps sl-h1">Impostazioni</h1>
                <p class="cn-heading__sub">
                  {String(total)} sezioni · salvate per{' '}
                  {target === 'user' ? 'l’utente' : 'questa cartella'}
                </p>
              </header>
            </div>
            <div class="cn-cell cn-cell--margin" style={area(2, 14, 3, 15)} />
            <div class="cn-cell cn-cell--row" style={area(3, 1, 4, 8)}>
              <label class="cn-field sl-search">
                <span class="sr">Cerca un’impostazione</span>
                <span class="cn-field__box" data-prompt="/">
                  <input
                    placeholder="Cerca un’impostazione"
                    value={query}
                    onInput={(event) => {
                      setQuery((event.target as HTMLInputElement).value);
                    }}
                  />
                </span>
              </label>
            </div>
            <div class="cn-cell cn-cell--row sl-end" style={area(3, 8, 4, 15)}>
              <Opts
                lead="Salva per"
                label="Salva per"
                value={target}
                options={[
                  { value: 'user', label: 'Utente' },
                  {
                    value: 'workspace',
                    label: 'Cartella',
                    disabled: !state.hasWorkspace,
                    ...(state.hasWorkspace ? {} : { title: 'Nessuna cartella aperta' }),
                  },
                ]}
                onChange={setTarget}
              />
            </div>
            {state.roles.fake && (
              <div
                class="cn-cell cn-cell--row cn-accent sl-fake"
                data-theme={theme === 'dark' ? 'light' : 'dark'}
                style={area(4, 1, 5, 15)}
              >
                <span class="sl-fake__t">
                  <span class="cn-tag">
                    <b>▲</b> CLI finti attivi
                  </span>
                  <span class="t-title">Le chat non parlano con modelli veri.</span>
                </span>
                {providers && (
                  <button
                    class="cn-btn cn-btn--sm"
                    type="button"
                    onClick={() => {
                      go(providers.id);
                    }}
                  >
                    <span class="cn-btn__label">Vai a Provider</span>
                    <span class="cn-btn__icon">→</span>
                  </button>
                )}
              </div>
            )}
          </Lattice>

          {showRoles && (
            <Sheet
              id="ruoli"
              index={1}
              total={total}
              title="Ruoli"
              count="Valori per le prossime chat"
              entries={roleEntries}
            />
          )}

          {visible.map(({ section, index, items }) => (
            <Sheet
              key={section.title}
              id={slug(section.title)}
              index={index + 2}
              total={total}
              title={section.title}
              count={`${String(items.length)} ${items.length === 1 ? 'voce' : 'voci'}`}
              entries={items.map((item) => settingEntry(item, target))}
            />
          ))}

          {!showRoles && visible.length === 0 && (
            <Lattice class="sl-cols" edges={{ top: true }}>
              <div class="cn-cell sl-none" style={area(1, 2, 2, 14)}>
                <span class="hint">Nessuna impostazione per “{query.trim()}”.</span>
              </div>
            </Lattice>
          )}

          <Lattice class="sl-cols sl-foot" edges={{ top: true }}>
            <div class="cn-cell cn-cell--row" style={area(1, 1, 2, 10)}>
              <span class="cn-tag">
                Salvate in <b>{target === 'user' ? 'utente' : 'cartella'}</b> | Sezioni{' '}
                <b>{String(total)}</b> | <b>Only/One</b>
              </span>
            </div>
            <div class="cn-cell cn-cell--row sl-end" style={area(1, 10, 2, 15)}>
              <span class="cn-tag">
                <b>{pad(total)}</b> / {pad(total)}
              </span>
            </div>
          </Lattice>
        </div>
      </div>
    </div>
  );
}
