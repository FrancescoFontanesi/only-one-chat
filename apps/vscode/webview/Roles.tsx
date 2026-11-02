import { useEffect, useState } from 'preact/hooks';
import {
  EFFORTS,
  effortFor,
  parseHostMessage,
  type Cli,
  type PermissionLevel,
  type ProviderCatalog,
  type RoleInfo,
  type RoleName,
  type RolesState,
  type WebviewToHostMessage,
} from '../src/webview/protocol.js';
import { vscodeApi } from './vscodeApi.js';

const post = (message: WebviewToHostMessage) => {
  vscodeApi.postMessage(message);
};

const PROVIDER: Record<Cli, string> = { codex: 'Codex', claude: 'Claude' };

const PERMISSIONS: readonly { value: PermissionLevel; label: string }[] = [
  { value: 'read-only', label: 'sola lettura' },
  { value: 'ask', label: 'chiede prima di agire' },
  { value: 'auto', label: 'automatico nella cartella' },
];

export const ROLES: readonly { name: RoleName; title: string }[] = [
  { name: 'leader', title: 'LEADER' },
  { name: 'implementer', title: 'IMPLEMENTATORE' },
];

export function Role({
  name,
  title,
  info,
  chat,
  catalog,
}: {
  name: RoleName;
  title: string;
  info: RoleInfo;
  chat: RoleInfo | undefined;
  catalog: readonly ProviderCatalog[];
}) {
  const set = (change: Partial<Pick<RoleInfo, 'cli' | 'model' | 'effort' | 'permission'>>) => {
    const next = {
      cli: info.cli,
      model: info.model,
      effort: info.effort,
      permission: info.permission,
      ...change,
    };
    post({ type: 'setRole', role: name, ...next });
  };
  const provider = catalog.find((c) => c.cli === info.cli);
  const model = provider?.models.find((m) => m.id === info.model);
  const efforts: readonly string[] = model ? model.efforts : EFFORTS;
  return (
    <section class="card role-card">
      <div class="card-head">
        <span class="label">{title}</span>
      </div>
      <label class="field">
        <span class="label">MODELLO</span>
        <select
          class="select"
          value={`${info.cli}|${info.model}`}
          onChange={(event) => {
            const [cli, id] = (event.target as HTMLSelectElement).value.split('|') as [Cli, string];
            const option = catalog.find((c) => c.cli === cli)?.models.find((m) => m.id === id);
            set({ cli, model: id, effort: effortFor(option, info.effort) });
          }}
        >
          {catalog.map((c) => (
            <optgroup key={c.cli} label={PROVIDER[c.cli]}>
              {c.status === 'loading' && (
                <option disabled value="">
                  lettura dei modelli…
                </option>
              )}
              {c.status === 'unavailable' && (
                <option disabled value="">
                  non disponibile
                </option>
              )}
              {c.cli === info.cli && !model && (
                <option value={`${info.cli}|${info.model}`}>{info.model}</option>
              )}
              {c.models.map((m) => (
                <option key={m.id} value={`${c.cli}|${m.id}`}>
                  {m.name}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </label>
      <label class="field">
        <span class="label">REASONING</span>
        <select
          class="select"
          value={info.effort}
          disabled={efforts.length === 0}
          onChange={(event) => {
            set({ effort: (event.target as HTMLSelectElement).value });
          }}
        >
          {efforts.length === 0 && <option value="">—</option>}
          {efforts.map((effort) => (
            <option key={effort} value={effort}>
              {effort}
            </option>
          ))}
        </select>
      </label>
      <label class="field">
        <span class="label">PERMESSI</span>
        <select
          class="select"
          value={info.permission}
          onChange={(event) => {
            set({ permission: (event.target as HTMLSelectElement).value as PermissionLevel });
          }}
        >
          {PERMISSIONS.map((p) => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
        </select>
      </label>
      {chat && chat.cli !== info.cli && (
        <p class="data muted">
          ▲ Questa chat resta su {PROVIDER[chat.cli]} · {chat.modelName}: il provider cambia dalla
          prossima chat.
        </p>
      )}
    </section>
  );
}

/** Roles, models and reasoning (ADR 0012): the models come from the CLIs, grouped by provider. */
export function RolesApp() {
  const [state, setState] = useState<RolesState>();

  useEffect(() => {
    const onMessage = (event: MessageEvent<unknown>) => {
      const message = parseHostMessage(event.data);
      if (message?.type === 'roles') setState(message.roles);
    };
    window.addEventListener('message', onMessage);
    post({ type: 'ready' });
    return () => {
      window.removeEventListener('message', onMessage);
    };
  }, []);

  if (!state) return <p class="data muted side">Lettura dei ruoli…</p>;
  return (
    <div class="side">
      <RolesBlock state={state} />
    </div>
  );
}

/** The roles with the providers' state: in the roles view and on the settings page. */
export function RolesBlock({ state }: { state: RolesState }) {
  const missing = state.catalog.filter((c) => c.status === 'unavailable');
  return (
    <>
      {state.fake && (
        <p class="data">
          <span class="tag tag-strong">FAKE</span> CLI finti attivi (onlyOneChat.fake): i modelli
          sono quelli dei CLI di prova, non dei tuoi abbonamenti.
        </p>
      )}
      {ROLES.map((role) => (
        <Role
          key={role.name}
          name={role.name}
          title={role.title}
          info={state.roles[role.name]}
          chat={state.chat?.[role.name]}
          catalog={state.catalog}
        />
      ))}
      {missing.map((c) => (
        <p key={c.cli} class="data muted">
          × {PROVIDER[c.cli]}: {c.note ?? 'modelli non disponibili'}
        </p>
      ))}
      <p class="data muted">
        Modello, reasoning e permessi valgono dal prossimo turno del ruolo, nella stessa sessione.
        Un altro provider vale dalla prossima chat.
      </p>
    </>
  );
}
