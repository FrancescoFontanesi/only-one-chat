// Pieces shared by the chat, the Squad panel and the settings page (ADR 0016):
// the theme from VS Code's, number formats,
// the options as words and the level meter, and the fields of a role.

import { Fragment, type JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import {
  EFFORTS,
  effortFor,
  type Cli,
  type PermissionLevel,
  type ProviderCatalog,
  type RoleInfo,
  type RoleName,
  type RolesState,
  type WebviewToHostMessage,
} from '../src/webview/protocol.js';
import { Decode } from './motion.js';
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

export interface Option<T extends string> {
  readonly value: T;
  readonly label: string;
  readonly title?: string;
  readonly disabled?: boolean;
}

/**
 * Options as words, as the design system writes a text button: the chosen one
 * in ink between brackets, the others muted; the pointer inverts the word.
 */
export function Opts<T extends string>({
  label,
  value,
  options,
  onChange,
  lead,
  disabled,
}: {
  label: string;
  value: T;
  options: readonly Option<T>[];
  onChange: (value: T) => void;
  /** A mono label before the options. */
  lead?: string;
  disabled?: boolean;
}) {
  return (
    <div class="opts" role="radiogroup" aria-label={label}>
      {lead && <span class="opts__lead">{lead}</span>}
      {options.map((option) => (
        <button
          key={option.value}
          class="opt"
          type="button"
          role="radio"
          aria-checked={option.value === value}
          disabled={disabled === true || option.disabled === true}
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
 * An ordered choice as a level meter: one cell per step, solid up to the
 * chosen one. Under the pointer the steps it would add show the 1-bit half
 * tone, those it would drop go hollow, and the name settles beside it.
 */
export function Scale<T extends string>({
  label,
  value,
  options,
  onChange,
  still,
}: {
  label: string;
  value: T;
  options: readonly Option<T>[];
  onChange: (value: T) => void;
  /** The name changes without Decode (the settings page has no motion). */
  still?: boolean;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const chosen = options.findIndex((option) => option.value === value);
  const shown = hover ?? chosen;
  return (
    <div
      class="scale"
      role="radiogroup"
      aria-label={label}
      onMouseLeave={() => {
        setHover(null);
      }}
    >
      <span class="scale__cells">
        {options.map((option, index) => {
          const state =
            index <= Math.min(chosen, shown)
              ? 'on'
              : index <= shown
                ? 'add'
                : index <= chosen
                  ? 'drop'
                  : 'off';
          return (
            <button
              key={option.value}
              class={`scale__c scale__c--${state}`}
              type="button"
              role="radio"
              aria-checked={index === chosen}
              aria-label={option.label}
              title={option.title ?? option.label}
              disabled={option.disabled === true}
              onMouseEnter={() => {
                setHover(index);
              }}
              onFocus={() => {
                setHover(index);
              }}
              onBlur={() => {
                setHover(null);
              }}
              onClick={() => {
                if (option.value !== value) onChange(option.value);
              }}
            />
          );
        })}
      </span>
      {still ? (
        <span class="scale__v">{options[shown]?.label ?? '—'}</span>
      ) : (
        <Decode class="scale__v" text={options[shown]?.label ?? '—'} />
      )}
      <span class="scale__n">
        {String(shown + 1).padStart(2, '0')}/{String(options.length).padStart(2, '0')}
      </span>
    </div>
  );
}

/** A value that cannot be chosen here: the value, and why. */
function Fixed({ value, tag }: { value: string; tag: string }) {
  return (
    <span class="fixed">
      <span class="t-data">{value}</span>
      <span class="cn-tag">{tag}</span>
    </span>
  );
}

/**
 * The fields of a role as a stacked spec list: provider and model as words,
 * reasoning (the model's levels) and permissions as level meters, each with
 * its note. `locked` keeps the model as it is (the leader during a chat);
 * `providerFixed` shows the provider without a choice.
 */
export function RoleFields({
  role,
  info,
  catalog,
  locked,
  providerFixed,
  providerNote,
  still,
  only,
}: {
  role: RoleName;
  info: RoleInfo;
  catalog: readonly ProviderCatalog[];
  locked?: boolean;
  providerFixed?: boolean;
  providerNote?: string;
  /** Without motion, for the settings page. */
  still?: boolean;
  /** Only these fields, by name (Provider, Modello, Reasoning, Permessi). */
  only?: readonly string[];
}) {
  const set = (change: RoleChange) => {
    writeRole(role, info, change);
  };
  const provider = catalog.find((c) => c.cli === info.cli);
  const model = provider?.models.find((m) => m.id === info.model);
  const efforts: readonly string[] = model ? model.efforts : EFFORTS;
  const models = [
    ...(model ? [] : [{ value: info.model, label: info.modelName.toUpperCase() }]),
    ...(provider?.models.map((m) => ({ value: m.id, label: m.name.toUpperCase() })) ?? []),
  ];
  const modelNote = locked
    ? 'UN CAMBIO VALE DALLA PROSSIMA CHAT'
    : provider?.status === 'loading'
      ? 'LETTURA DEI MODELLI…'
      : provider?.status === 'unavailable'
        ? `× ${provider.note ?? 'MODELLI NON DISPONIBILI'}`
        : undefined;
  const fields: { name: string; note: string | undefined; control: JSX.Element }[] = [
    {
      name: 'Provider',
      note: providerNote,
      control: providerFixed ? (
        <Fixed value={PROVIDER[info.cli].toUpperCase()} tag="■ BLOCCATO" />
      ) : (
        <Opts
          label={`Provider: ${ROLE[role]}`}
          value={info.cli}
          options={[
            { value: 'codex', label: 'CODEX' },
            { value: 'claude', label: 'CLAUDE' },
          ]}
          onChange={(cli: Cli) => {
            const first = catalog.find((c) => c.cli === cli)?.models[0];
            set({ cli, model: first?.id ?? info.model, effort: effortFor(first, info.effort) });
          }}
        />
      ),
    },
    {
      name: 'Modello',
      note: modelNote,
      control: locked ? (
        <Fixed value={info.modelName.toUpperCase()} tag="■ BLOCCATO" />
      ) : (
        <Opts
          label={`Modello: ${ROLE[role]}`}
          value={info.model}
          options={models}
          onChange={(id) => {
            const option = provider?.models.find((m) => m.id === id);
            set({ model: id, effort: effortFor(option, info.effort) });
          }}
        />
      ),
    },
    {
      name: 'Reasoning',
      note: undefined,
      control:
        efforts.length === 0 ? (
          <Fixed value="NESSUNO" tag="IL MODELLO NON HA LIVELLI" />
        ) : (
          <Scale
            still={still === true}
            label={`Reasoning: ${ROLE[role]}`}
            value={info.effort}
            options={efforts.map((effort) => ({ value: effort, label: effort.toUpperCase() }))}
            onChange={(effort) => {
              set({ effort });
            }}
          />
        ),
    },
    {
      name: 'Permessi',
      note: 'VALE DAL TURNO SUCCESSIVO',
      control: (
        <Scale
          still={still === true}
          label={`Permessi: ${ROLE[role]}`}
          value={info.permission}
          options={PERMISSIONS.map((p) => ({
            value: p.value,
            label: p.label.toUpperCase(),
          }))}
          onChange={(value) => {
            set({ permission: value });
          }}
        />
      ),
    },
  ];
  return (
    <dl class="cn-spec cn-spec--stack rf">
      {fields
        .filter((field) => !only || only.includes(field.name))
        .map((field) => (
          <Fragment key={field.name}>
            <dt>{field.name}</dt>
            <dd>
              {field.control}
              {field.note && <span class="tiny">{field.note}</span>}
            </dd>
          </Fragment>
        ))}
    </dl>
  );
}

type RoleChange = Partial<Pick<RoleInfo, 'cli' | 'model' | 'effort' | 'permission'>>;

/** Writes a role's settings: `info` as it stands, with `change` over it. */
export function writeRole(role: RoleName, info: RoleInfo, change: RoleChange) {
  post({
    type: 'setRole',
    role,
    cli: info.cli,
    model: info.model,
    effort: info.effort,
    permission: info.permission,
    ...change,
  });
}

/**
 * A role as the chat lets it change: once the chat has run, the leader keeps
 * the chat's model and provider (another applies from the next chat); the
 * rest are the settings they write. `info` is what a change starts from.
 */
export function editableRole(role: RoleName, roles: RolesState) {
  const started = roles.chat !== null;
  const current = roles.chat?.[role] ?? roles.roles[role];
  const next = roles.roles[role];
  const pinned = role === 'leader' && started;
  return {
    started,
    pinned,
    current,
    info: pinned ? { ...next, model: current.model, modelName: current.modelName } : next,
  };
}

/** The fields of a role as the chat lets them change (see `editableRole`). */
export function RoleEditor({
  role,
  roles,
  only,
}: {
  role: RoleName;
  roles: RolesState;
  only?: readonly string[];
}) {
  const { started, pinned, current: info, info: edited } = editableRole(role, roles);
  const next = roles.roles[role];
  return (
    <RoleFields
      role={role}
      info={edited}
      catalog={roles.catalog}
      locked={pinned}
      providerFixed={pinned}
      {...(only ? { only } : {})}
      {...(started && next.cli !== info.cli
        ? {
            providerNote: `QUESTA CHAT RESTA SU ${PROVIDER[info.cli].toUpperCase()}: IL PROVIDER VALE DALLA PROSSIMA CHAT`,
          }
        : role === 'implementer' && started
          ? { providerNote: 'UN CAMBIO DI PROVIDER VALE DALLA PROSSIMA CHAT' }
          : {})}
    />
  );
}

/**
 * A choice that shows only what is chosen: a key, one tick per option (the
 * chosen one solid) and the chosen name. Under the pointer a tick turns to
 * the 1-bit half tone and the name decodes to that option's, and `preview`
 * tells the caller which one is looked at; a click on a tick chooses it, a
 * click on the name moves to the next, the arrows move along. What is chosen
 * flashes once, inverted.
 */
export function Pick<T extends string>({
  label,
  short,
  compact,
  value,
  options,
  onChange,
  disabled,
  preview,
}: {
  label: string;
  /** The key before the ticks: A, DELEGHE. */
  short?: string;
  /** Only the name: the ticks open above it under the pointer or the focus. */
  compact?: boolean;
  value: T;
  options: readonly Option<T>[];
  onChange: (value: T) => void;
  disabled?: boolean;
  preview?: (option: Option<T> | null) => void;
}) {
  const [hover, setHover] = useState<number | null>(null);
  // What was chosen when it showed: a later choice flashes, the first does not.
  const initial = useRef(value);
  const changed = value !== initial.current;
  const chosen = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  );
  const shown = options[hover ?? chosen] ?? options[0];
  const look = (index: number | null) => {
    setHover(index);
    preview?.(index === null ? null : (options[index] ?? null));
  };
  const choose = (index: number) => {
    const option = options[(index + options.length) % options.length];
    if (option && !option.disabled && option.value !== value) onChange(option.value);
  };
  return (
    <div
      class={['pk', compact ? 'pk--compact' : '', disabled ? 'pk--off' : ''].join(' ').trim()}
      role="radiogroup"
      aria-label={label}
      onMouseLeave={() => {
        look(null);
      }}
      onKeyDown={(event) => {
        if (disabled) return;
        const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
        if (step === undefined) return;
        event.preventDefault();
        choose(chosen + step);
      }}
    >
      {short && <span class="pk__k">{short}</span>}
      <span class="pk__ticks">
        {options.map((option, index) => (
          <button
            key={option.value}
            class={
              index === chosen ? 'pk__t pk__t--on' : index === hover ? 'pk__t pk__t--look' : 'pk__t'
            }
            type="button"
            role="radio"
            aria-checked={index === chosen}
            aria-label={option.label}
            title={option.title ?? option.label}
            tabIndex={index === chosen ? 0 : -1}
            disabled={disabled === true || option.disabled === true}
            onMouseEnter={() => {
              look(index);
            }}
            onFocus={() => {
              look(index);
            }}
            onBlur={() => {
              look(null);
            }}
            onClick={() => {
              choose(index);
            }}
          />
        ))}
      </span>
      <button
        key={value}
        class={changed ? 'pk__v pk__v--set' : 'pk__v'}
        type="button"
        tabIndex={-1}
        aria-hidden="true"
        disabled={disabled}
        onClick={() => {
          choose(chosen + 1);
        }}
      >
        <Decode initial={changed} text={shown?.label ?? ''} />
      </button>
    </div>
  );
}
