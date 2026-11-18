// The dock of the Chat board (ADR 0016): what waits for the user takes the
// composer's place (Requests.tsx), else the composer (Composer.tsx). On a wide
// panel, beside it, the two dials (Hud.tsx): who you talk to, and the
// providers' usage.

import { useContext } from 'preact/hooks';
import type {
  MonitorState,
  ProviderUsage,
  RolesState,
  SessionInfo,
  TurnRole,
} from '../src/webview/protocol.js';
import { RoleHud, UsageHud } from './Hud.js';
import { Composer, setMode } from './Composer.js';
import { ApprovalFrame, QuestionFrame, PermissionSlab, type Item } from './Requests.js';
import type { ThreadItem } from './state.js';
import { post, ShownNode, useWho } from './ui.js';

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
        class="cn-btn--bare cn-btn cn-btn--outline cn-btn--sm"
        type="button"
        onClick={() => {
          post({ type: noFolder ? 'openFolder' : 'manageTrust' });
        }}
      >
        <span class="cn-btn__label">{noFolder ? 'APRI CARTELLA' : 'GESTISCI ATTENDIBILITÀ'}</span>
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
  waiting,
  to,
  setTo,
  select,
}: {
  session: SessionInfo | undefined;
  items: readonly ThreadItem[];
  numbers: ReadonlyMap<string, string>;
  theme: 'dark' | 'light';
  roles: RolesState | undefined;
  monitor: MonitorState;
  usage: readonly ProviderUsage[];
  openSquad: () => void;
  /** Requests waiting for you, in the chat and its nodes: the badge on SQUAD (ADR 0021). */
  waiting: number;
  /** Who the composer writes to; choosing a role shows the chat's thread again. */
  to: TurnRole;
  setTo: (to: TurnRole) => void;
  /** Chooses who you talk to from the dial: a role, or a node by id (ADR 0023). */
  select: (target: string) => void;
}) {
  const permission = items.find(
    (i): i is Item<'permission'> => i.kind === 'permission' && !i.closed,
  );
  const approval = items.find((i): i is Item<'approval'> => i.kind === 'approval' && !i.closed);
  const question = items.find((i): i is Item<'question'> => i.kind === 'question' && !i.closed);
  const node = useContext(ShownNode);
  const recipient =
    node ??
    (!roles
      ? undefined
      : to === 'reviewer'
        ? roles.reviewer
        : (roles.chat?.[to] ?? roles.roles[to]));
  const waitingWho = useWho(permission?.role ?? 'leader');
  return (
    <footer class="dock">
      <div class="dock__in">
        <aside class="dock__side" aria-label="Parli con">
          <RoleHud
            roles={roles}
            monitor={monitor}
            to={to}
            node={node}
            removedNodes={session?.removedNodes ?? []}
            select={select}
            mode={session?.mode ?? 'manual'}
            setMode={setMode}
            busy={node ? (session?.busyNodes ?? []).includes(node.id) : (session?.busy ?? false)}
          />
        </aside>
        <div class="colw">
          {permission ? (
            <>
              <PermissionSlab item={permission} theme={theme} />
              <div class="below">
                <span class="hint">
                  {node
                    ? waitingWho
                    : permission.role === 'leader'
                      ? 'IL LEADER'
                      : permission.role === 'reviewer'
                        ? 'IL REVISORE'
                        : 'L’IMPLEMENTATORE'}{' '}
                  ASPETTA LA TUA RISPOSTA · L’INVIO RIPRENDE DOPO
                </span>
                <button
                  class="cn-btn cn-btn--outline cn-btn--sm"
                  type="button"
                  aria-label="Ferma tutto e nega le richieste in attesa"
                  onClick={() => {
                    post(node ? { type: 'stop', node: node.id } : { type: 'stop' });
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
              waiting={waiting}
              to={to}
              setTo={setTo}
              cli={node || to === 'reviewer' ? undefined : recipient?.cli}
              reviewerOn={roles?.reviewer.enabled ?? false}
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
