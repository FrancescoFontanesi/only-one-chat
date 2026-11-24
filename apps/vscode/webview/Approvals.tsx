// The approvals kept "for the session" (ADR 0050): a count on the usage dial
// while there are any, which opens to the list, each with its revocation, and
// one for them all. A revoked request is asked again; the session goes on.

import { useState } from 'preact/hooks';
import type { SessionApproval } from '../src/shared/approvals.js';
import { post } from './ui.js';

export function Approvals({ approvals }: { approvals: readonly SessionApproval[] }) {
  const [open, setOpen] = useState(false);
  if (approvals.length === 0) return null;
  const count = approvals.length;
  return (
    <div class="approvals">
      <button
        class="cn-btn cn-btn--text"
        type="button"
        aria-expanded={open}
        onClick={() => {
          setOpen(!open);
        }}
      >
        <span class="cn-btn__label">▲ {String(count)} allowed for session</span>
      </button>
      {open && (
        <ul class="approvals__list" aria-label="Requests allowed for the session">
          {approvals.map((approval) => (
            <li
              key={`${approval.ownerKind}\n${approval.owner}\n${approval.key}`}
              class="approvals__item"
            >
              <span>
                {approval.label} · <code class="t-data">{approval.summary}</code>
              </span>
              <button
                class="cn-btn cn-btn--text"
                type="button"
                aria-label={`Revoke: ${approval.summary}`}
                onClick={() => {
                  post({
                    type: 'revokeApproval',
                    ownerKind: approval.ownerKind,
                    owner: approval.owner,
                    key: approval.key,
                  });
                }}
              >
                <span class="cn-btn__label">Revoke</span>
              </button>
            </li>
          ))}
          <li>
            <button
              class="cn-btn cn-btn--text"
              type="button"
              onClick={() => {
                post({ type: 'revokeApproval' });
              }}
            >
              <span class="cn-btn__label">Revoke all</span>
            </button>
          </li>
        </ul>
      )}
    </div>
  );
}
