import { useEffect, useState } from 'preact/hooks';
import {
  parseHostMessage,
  type SettingItem,
  type SettingValue,
  type SettingsState,
  type SettingsTarget,
  type WebviewToHostMessage,
} from '../src/webview/protocol.js';
import { RolesBlock } from './Roles.js';
import { vscodeApi } from './vscodeApi.js';

const post = (message: WebviewToHostMessage) => {
  vscodeApi.postMessage(message);
};

const SCOPE = { default: 'PREDEFINITO', user: 'UTENTE', workspace: 'CARTELLA' } as const;

/** A text field written when it loses focus, not at each key. */
function TextField({
  item,
  multiline,
  write,
}: {
  item: SettingItem;
  multiline: boolean;
  write: (value: SettingValue) => void;
}) {
  const shown = Array.isArray(item.value) ? item.value.join('\n') : String(item.value);
  const [text, setText] = useState(shown);
  useEffect(() => {
    setText(shown);
  }, [shown]);
  const commit = () => {
    if (text === shown) return;
    write(
      item.kind === 'list'
        ? text
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean)
        : text,
    );
  };
  return multiline ? (
    <textarea
      class="editor"
      rows={item.kind === 'list' ? 3 : 5}
      value={text}
      placeholder={item.kind === 'list' ? 'un valore per riga' : ''}
      onInput={(event) => {
        setText((event.target as HTMLTextAreaElement).value);
      }}
      onBlur={commit}
    />
  ) : (
    <input
      class="editor"
      value={text}
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

function Setting({ item, target }: { item: SettingItem; target: SettingsTarget }) {
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
        <input
          type="checkbox"
          checked={item.value === true}
          onChange={(event) => {
            write((event.target as HTMLInputElement).checked);
          }}
        />
      );
      break;
    case 'enum':
      control = (
        <select
          class="select"
          value={String(item.value)}
          onChange={(event) => {
            write((event.target as HTMLSelectElement).value);
          }}
        >
          {item.options?.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      );
      break;
    case 'number':
      control = (
        <input
          class="editor narrow"
          type="number"
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
      control = (
        <TextField
          item={item}
          multiline={item.kind === 'text' || item.kind === 'list'}
          write={write}
        />
      );
  }
  return (
    <div class="setting">
      <div class="setting-head">
        <span class="data">{item.label}</span>
        <span class={item.scope === 'default' ? 'tag' : 'tag tag-strong'}>{SCOPE[item.scope]}</span>
        {item.userOnly && <span class="tag">SOLO UTENTE</span>}
        {resettable && (
          <button
            type="button"
            class="seg"
            title="Torna al valore predefinito o a quello dell’utente"
            onClick={() => {
              post({ type: 'setSetting', key: item.key, target: where });
            }}
          >
            RIPRISTINA
          </button>
        )}
      </div>
      {control}
      {item.description && <p class="data muted">{item.description}</p>}
    </div>
  );
}

/** The settings page (ADR 0013): VS Code's own settings, grouped, with where each value comes from. */
export function SettingsApp() {
  const [state, setState] = useState<SettingsState>();
  const [target, setTarget] = useState<SettingsTarget>('user');

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

  if (!state) return <p class="data muted side">Lettura delle impostazioni…</p>;
  return (
    <div class="settings">
      <header class="bar">
        <div class="bar-row">
          <span class="chat-title">Impostazioni</span>
          <span class="label">SALVA PER</span>
          <span class="seg-group" role="group" aria-label="Dove salvare">
            <button
              type="button"
              class={target === 'user' ? 'seg on' : 'seg'}
              onClick={() => {
                setTarget('user');
              }}
            >
              UTENTE
            </button>
            <button
              type="button"
              class={target === 'workspace' ? 'seg on' : 'seg'}
              disabled={!state.hasWorkspace}
              onClick={() => {
                setTarget('workspace');
              }}
            >
              CARTELLA
            </button>
          </span>
          <button
            type="button"
            class="seg"
            onClick={() => {
              post({ type: 'openNativeSettings' });
            }}
          >
            APRI IN VS CODE
          </button>
        </div>
      </header>
      <section class="settings-section">
        <h2 class="label">RUOLI</h2>
        <RolesBlock state={state.roles} />
      </section>
      {state.sections.map((section) => (
        <section key={section.title} class="settings-section">
          <h2 class="label">{section.title.toUpperCase()}</h2>
          {section.items.map((item) => (
            <Setting key={item.key} item={item} target={target} />
          ))}
        </section>
      ))}
    </div>
  );
}
