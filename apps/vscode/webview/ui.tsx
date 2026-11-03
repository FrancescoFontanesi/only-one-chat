// Pieces shared by the chat, the Squad panel and the settings page (ADR 0016):
// the theme from VS Code's, number formats, the segmented control, and the
// fields of a role.

import { useEffect, useState } from 'preact/hooks';
import {
  EFFORTS,
  effortFor,
  type Cli,
  type PermissionLevel,
  type ProviderCatalog,
  type RoleInfo,
  type RoleName,
  type WebviewToHostMessage,
} from '../src/webview/protocol.js';
import { vscodeApi } from './vscodeApi.js';

export const post = (message: WebviewToHostMessage) => {
  vscodeApi.postMessage(message);
};

/** Print when VS Code's theme is light, Signal otherwise; it follows a change of theme. */
export function useTheme(): 'dark' | 'light' {
  const read = () =>
    document.body.classList.contains('vscode-light') ||
    document.body.classList.contains('vscode-high-contrast-light')
      ? 'light'
      : 'dark';
  const [theme, setTheme] = useState<'dark' | 'light'>(read);
  useEffect(() => {
    const observer = new MutationObserver(() => {
      setTheme(read());
    });
    observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    return () => {
      observer.disconnect();
    };
  }, []);
  return theme;
}

/** 18,4K, as the canvas writes token counts. */
export function kilo(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(1).replace('.', ',')}K` : String(value);
}

/** 02:13 */
export function duration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

export function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export const PROVIDER: Record<Cli, string> = { codex: 'Codex', claude: 'Claude' };
export const ROLE: Record<RoleName, string> = { leader: 'Leader', implementer: 'Implementatore' };

export const PERMISSIONS: readonly { value: PermissionLevel; label: string; short: string }[] = [
  { value: 'read-only', label: 'Sola lettura', short: 'Lettura' },
  { value: 'ask', label: 'Chiede prima di agire', short: 'Chiede' },
  { value: 'auto', label: 'Automatico nella cartella', short: 'Auto' },
];

export function Meter({ value }: { value: number }) {
  return (
    <span class="cn-meter" style={{ '--v': String(Math.max(0, Math.min(1, value))) }}>
      <i />
    </span>
  );
}

/**
 * A segmented control: the options side by side, the chosen one inverted
 * (the design system's "pressed = inversion held"). In place of a select.
 */
export function Seg<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled,
  small,
}: {
  label: string;
  value: T;
  options: readonly { value: T; label: string; title?: string }[];
  onChange: (value: T) => void;
  disabled?: boolean;
  small?: boolean;
}) {
  return (
    <div class={small ? 'seg seg--sm' : 'seg'} role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={option.value === value}
          disabled={disabled}
          title={option.title}
          onClick={() => {
            if (option.value !== value) onChange(option.value);
          }}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/**
 * The fields of a role: provider, model (from the models the CLI offers),
 * reasoning (the model's levels), permissions. `locked` keeps the model as it
 * is (the leader during a chat); `providerFixed` shows the provider as text.
 */
export function RoleFields({
  role,
  info,
  catalog,
  locked,
  providerFixed,
  providerNote,
}: {
  role: RoleName;
  info: RoleInfo;
  catalog: readonly ProviderCatalog[];
  locked?: boolean;
  providerFixed?: boolean;
  providerNote?: string;
}) {
  const set = (change: Partial<Pick<RoleInfo, 'cli' | 'model' | 'effort' | 'permission'>>) => {
    post({
      type: 'setRole',
      role,
      cli: info.cli,
      model: info.model,
      effort: info.effort,
      permission: info.permission,
      ...change,
    });
  };
  const provider = catalog.find((c) => c.cli === info.cli);
  const model = provider?.models.find((m) => m.id === info.model);
  const efforts: readonly string[] = model ? model.efforts : EFFORTS;
  const models = [
    ...(model ? [] : [{ value: info.model, label: info.modelName.toUpperCase() }]),
    ...(provider?.models.map((m) => ({ value: m.id, label: m.name.toUpperCase() })) ?? []),
  ];
  return (
    <div>
      <div class="rset">
        <span>PROVIDER</span>
        <div class="rset__v">
          {providerFixed ? (
            <span class="t-data">{PROVIDER[info.cli]}</span>
          ) : (
            <Seg
              label={`Provider: ${ROLE[role]}`}
              value={info.cli}
              options={[
                { value: 'codex', label: 'CODEX' },
                { value: 'claude', label: 'CLAUDE' },
              ]}
              onChange={(cli: Cli) => {
                const first = catalog.find((c) => c.cli === cli)?.models[0];
                set({
                  cli,
                  model: first?.id ?? info.model,
                  effort: effortFor(first, info.effort),
                });
              }}
            />
          )}
          {providerNote && <span class="tiny">{providerNote}</span>}
        </div>
      </div>
      <div class="rset">
        <span>MODELLO</span>
        <div class="rset__v">
          {locked ? (
            <span class="sel sel--full sel--lock" aria-disabled="true">
              {info.modelName.toUpperCase()} <small>BLOCCATO</small>
            </span>
          ) : (
            <Seg
              label={`Modello: ${ROLE[role]}`}
              value={info.model}
              options={models}
              onChange={(id) => {
                const option = provider?.models.find((m) => m.id === id);
                set({ model: id, effort: effortFor(option, info.effort) });
              }}
            />
          )}
          {locked && <span class="tiny">UN CAMBIO VALE DALLA PROSSIMA CHAT</span>}
          {provider?.status === 'loading' && <span class="tiny">LETTURA DEI MODELLI…</span>}
          {provider?.status === 'unavailable' && (
            <span class="tiny">× {provider.note ?? 'MODELLI NON DISPONIBILI'}</span>
          )}
        </div>
      </div>
      <div class="rset">
        <span>REASONING</span>
        <div class="rset__v">
          {efforts.length === 0 ? (
            <span class="sel sel--full sel--lock" aria-disabled="true">
              NESSUNO
            </span>
          ) : (
            <Seg
              label={`Reasoning: ${ROLE[role]}`}
              value={info.effort}
              options={efforts.map((effort) => ({ value: effort, label: effort.toUpperCase() }))}
              onChange={(effort) => {
                set({ effort });
              }}
            />
          )}
        </div>
      </div>
      <div class="rset">
        <span>PERMESSI</span>
        <div class="rset__v">
          <Seg
            label={`Permessi: ${ROLE[role]}`}
            value={info.permission}
            options={PERMISSIONS.map((p) => ({
              value: p.value,
              label: p.short.toUpperCase(),
              title: p.label,
            }))}
            onChange={(permission) => {
              set({ permission });
            }}
          />
          <span class="tiny">
            {PERMISSIONS.find((p) => p.value === info.permission)?.label.toUpperCase()} · VALE DAL
            TURNO SUCCESSIVO
          </span>
        </div>
      </div>
    </div>
  );
}
