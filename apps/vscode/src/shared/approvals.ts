// The approvals kept "for the session" (ADR 0050): what the panel lists, and the
// message that revokes one or all. Apart from protocol.ts for its line ceiling.

/** Roles and nodes are owners of their own kind: a node may be named like a role. */
export type OwnerKind = 'role' | 'node';

/** A request approved for the session, by a role or a node of the chat. */
export interface SessionApproval {
  readonly ownerKind: OwnerKind;
  /** The role's name, or the node's id. */
  readonly owner: string;
  /** Who it is, as the panel names it. */
  readonly label: string;
  /** The bridge's key of the request: the tool and its whole input. */
  readonly key: string;
  readonly summary: string;
}

/** Revokes one approval of an owner; with no owner, all of them. */
export interface RevokeApproval {
  readonly type: 'revokeApproval';
  readonly ownerKind?: OwnerKind;
  readonly owner?: string;
  readonly key?: string;
}

const OWNER = /^[a-z0-9-]{1,64}$/;
/** A key is a tool name and its JSON input; the webview message limit bounds it too. */
const MAX_KEY = 40_000;
const isKind = (value: unknown): value is OwnerKind => value === 'role' || value === 'node';

/** Validates a revocation from the webview; anything else is dropped. */
export function parseRevoke(msg: Readonly<Record<string, unknown>>): RevokeApproval | undefined {
  const { ownerKind, owner, key } = msg;
  if (ownerKind === undefined && owner === undefined && key === undefined) {
    return { type: 'revokeApproval' };
  }
  return isKind(ownerKind) &&
    typeof owner === 'string' &&
    OWNER.test(owner) &&
    typeof key === 'string' &&
    key.length > 0 &&
    key.length <= MAX_KEY
    ? { type: 'revokeApproval', ownerKind, owner, key }
    : undefined;
}

/** The approvals list from the host, as the webview reads it. */
export function parseApprovals(value: unknown): SessionApproval[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const ok = value.every((a: unknown) => {
    if (typeof a !== 'object' || a === null) return false;
    const fields = a as Record<string, unknown>;
    return (
      isKind(fields['ownerKind']) &&
      ['owner', 'label', 'key', 'summary'].every((field) => typeof fields[field] === 'string')
    );
  });
  return ok ? (value as SessionApproval[]) : undefined;
}

/** What keeps approvals for one owner: a role's bridge, or a node's. */
export interface ApprovalHolder {
  readonly ownerKind: OwnerKind;
  readonly owner: string;
  revoke(key: string): unknown;
  clear(): void;
}

/** Applies a revocation: all holders without an owner, else only the one of that kind and name. */
export function revokeIn(holders: Iterable<ApprovalHolder>, message: RevokeApproval): void {
  for (const holder of holders) {
    if (message.owner === undefined) holder.clear();
    else if (
      message.ownerKind === holder.ownerKind &&
      message.owner === holder.owner &&
      message.key !== undefined
    ) {
      holder.revoke(message.key);
    }
  }
}
