// The settings page, as the canvas's Impostazioni board draws it (ADR 0013,
// 0016): a rail with the sections and where to save, the roles for the next
// chats, then each setting with where its value comes from. VS Code's own
// settings underneath.

import { useEffect, useState } from 'preact/hooks';
import {
  parseHostMessage,
  type SettingItem,
  type SettingValue,
  type SettingsState,
  type SettingsTarget,
} from '../src/webview/protocol.js';
import { post, RoleFields, Seg, useTheme } from './ui.js';

const SCOPE = { user: '[ UTENTE ]', workspace: '[ CARTELLA ]' } as const;

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
      class="ta"
      aria-label={item.label}
      value={text}
      onInput={(event) => {
        setText((event.target as HTMLTextAreaElement).value);
      }}
      onBlur={commit}
    />
  ) : (
    <input
      class="inp"
      type="text"
      aria-label={item.label}
      value={text}
      placeholder={list ? 'valori separati da virgole' : ''}
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

function Row({ item, target }: { item: SettingItem; target: SettingsTarget }) {
  // A setting that never comes from a folder is always written for the user.
  const where: SettingsTarget = item.userOnly ? 'user' : target;
  const write = (value: SettingValue) => {
    post({ type: 'setSetting', key: item.key, value, target: where });
  };
  const resettable =
    item.scope !== 'default' && (item.scope === 'workspace') === (where === 'workspace');
  let control;
  switch (item.kind) {
    case 'boolean':
      control = (
        <Seg
          label={item.label}
          value={item.value ? 'yes' : 'no'}
          options={[
            { value: 'yes', label: 'SÌ' },
            { value: 'no', label: 'NO' },
          ]}
          onChange={(value) => {
            write(value === 'yes');
          }}
        />
      );
      break;
    case 'enum':
      control = (
        <Seg
          label={item.label}
          value={String(item.value)}
          options={(item.options ?? []).map((o) => ({
            value: o.value,
            label: o.label.toUpperCase(),
          }))}
          onChange={write}
        />
      );
      break;
    case 'number':
      control = (
        <input
          class="inp"
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
      );
      break;
    default:
      control = <TextField item={item} multiline={item.kind === 'text'} write={write} />;
  }
  return (
    <div class="srow">
      <div class="srow__n">
        <b>{item.label}</b>
        <span>{item.description}</span>
      </div>
      <div>{control}</div>
      <div class="srow__o">
        {item.userOnly && <span class="cn-tag">SOLO UTENTE</span>}
        {item.scope === 'default' ? (
          <span class="cn-tag">PREDEFINITO</span>
        ) : (
          <span class="cn-tag cn-tag--ink">{SCOPE[item.scope]}</span>
        )}
        {resettable && (
          <button
            class="cn-btn cn-btn--text"
            type="button"
            title="Toglie il valore da qui: vale quello dell’utente o il predefinito"
            onClick={() => {
              post({ type: 'setSetting', key: item.key, target: where });
            }}
          >
            <span class="cn-btn__label">RIPRISTINA</span>
          </button>
        )}
      </div>
    </div>
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
        <p class="hint" style={{ padding: '24px' }}>
          Lettura delle impostazioni…
        </p>
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

  return (
    <div class="cn app app--page" data-theme={theme}>
      <div class="st">
        <aside class="rail">
          <div class="mark">Only/One</div>
          <nav class="nav" aria-label="Sezioni">
            {sections.map((section, index) => (
              <a
                key={section.id}
                href={`#${section.id}`}
                class={current === section.id ? 'cn-accent' : ''}
                aria-current={current === section.id}
                onClick={(event) => {
                  event.preventDefault();
                  go(section.id);
                }}
              >
                {section.title} <span>{String(index + 1).padStart(2, '0')}</span>
              </a>
            ))}
          </nav>
          <div class="rail__s">
            <span class="cn-tag">SALVA PER</span>
            <div class="seg" role="group" aria-label="Salva per">
              <button
                type="button"
                class={target === 'user' ? 'cn-accent' : ''}
                aria-pressed={target === 'user'}
                onClick={() => {
                  setTarget('user');
                }}
              >
                UTENTE
              </button>
              <button
                type="button"
                class={target === 'workspace' ? 'cn-accent' : ''}
                aria-pressed={target === 'workspace'}
                disabled={!state.hasWorkspace}
                onClick={() => {
                  setTarget('workspace');
                }}
              >
                CARTELLA
              </button>
            </div>
            {!state.hasWorkspace && <span class="t-data mut">Nessuna cartella aperta</span>}
          </div>
        </aside>
        <div class="smain">
          <header class="bar">
            <span class="crumb">
              IMPOSTAZIONI /{' '}
              <b>{(sections.find((s) => s.id === current)?.title ?? '').toUpperCase()}</b>
            </span>
            <label class="cn-field hide-m" style={{ flex: '1', maxWidth: '420px' }}>
              <span class="sr">Cerca un’impostazione</span>
              <span class="cn-field__box" data-prompt="/" style={{ height: '36px' }}>
                <input
                  placeholder="Cerca un’impostazione"
                  value={query}
                  onInput={(event) => {
                    setQuery((event.target as HTMLInputElement).value);
                  }}
                />
              </span>
            </label>
            <div class="bar__r">
              <button
                class="cn-btn cn-btn--text"
                type="button"
                onClick={() => {
                  post({ type: 'openNativeSettings' });
                }}
              >
                <span class="cn-btn__label">APRI IN VS CODE ↗</span>
              </button>
              <button
                class="cn-btn cn-btn--outline cn-btn--sm"
                type="button"
                onClick={() => {
                  post({ type: 'showChat' });
                }}
              >
                <span class="cn-btn__label">← CHAT</span>
              </button>
            </div>
          </header>
          <div class="sbody">
            {state.roles.fake && (
              <section
                class="cn-slab"
                data-theme={theme === 'dark' ? 'light' : 'dark'}
                style={{
                  padding: '24px',
                  display: 'flex',
                  flexWrap: 'wrap',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  gap: '16px',
                }}
              >
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  <span class="cn-tag">
                    <b>▲</b> CLI FINTI ATTIVI
                  </span>
                  <h2 class="t-title">Le chat non parlano con modelli veri.</h2>
                </div>
                {providers && (
                  <button
                    class="cn-btn cn-btn--sm"
                    type="button"
                    onClick={() => {
                      go(providers.id);
                    }}
                  >
                    <span class="cn-btn__label">VAI A PROVIDER</span>
                    <span class="cn-btn__icon">→</span>
                  </button>
                )}
              </section>
            )}
            {(q === '' || 'ruoli modello reasoning permessi provider'.includes(q)) && (
              <section class="sec" id="ruoli">
                <div class="sec__h">
                  <span class="cn-tag">
                    <b>01/</b>
                  </span>
                  <h2 class="t-title">Ruoli</h2>
                  <span class="hint" style={{ marginLeft: 'auto' }}>
                    VALORI PER LE PROSSIME CHAT
                  </span>
                </div>
                <div class="roles">
                  {(['leader', 'implementer'] as const).map((role) => (
                    <section key={role} class="cn-frame" aria-label={`Ruolo ${role}`}>
                      <header class="cn-frame__head">
                        <span class="cn-tag">
                          <b>{role === 'leader' ? 'LEADER' : 'IMPLEMENTATORE'}</b>
                        </span>
                      </header>
                      <div class="cn-frame__body" style={{ padding: '8px 24px 16px' }}>
                        <RoleFields
                          role={role}
                          info={state.roles.roles[role]}
                          catalog={state.roles.catalog}
                          providerNote={
                            role === 'leader'
                              ? 'NELLA CHAT IL MODELLO SI BLOCCA AL PRIMO MESSAGGIO'
                              : 'IN CHAT, UN ALTRO PROVIDER VALE DALLA CHAT SUCCESSIVA'
                          }
                        />
                      </div>
                    </section>
                  ))}
                </div>
              </section>
            )}
            {state.sections.map((section, index) => {
              const rows = section.items.filter(
                (item) =>
                  q === '' ||
                  item.label.toLowerCase().includes(q) ||
                  item.description.toLowerCase().includes(q),
              );
              if (rows.length === 0) return null;
              return (
                <section key={section.title} class="sec" id={slug(section.title)}>
                  <div class="sec__h">
                    <span class="cn-tag">
                      <b>{String(index + 2).padStart(2, '0')}/</b>
                    </span>
                    <h2 class="t-title">{section.title}</h2>
                  </div>
                  {rows.map((item) => (
                    <Row key={item.key} item={item} target={target} />
                  ))}
                </section>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
