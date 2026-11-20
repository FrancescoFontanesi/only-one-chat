# 0028. Groups and standalone nodes on the dial, Squad in the composer

Status: Accepted (iteration 3). Supersedes item 5 of ADR 0027 on the grouped recipient dial.

## Context

- **The left ring combined group and role selection.** It listed the leader–implementer pair, nodes, and individual roles. User-chosen names need more than the three letters used by provider abbreviations on the right dial.
- **The chat currently has one group** with the leader and implementer, plus standalone nodes. Custom groups require delegation to nodes, which is deferred.

## Decision

1. **Separate controls for groups and roles.**
   - Select a group or standalone node with the label at the top of the left dial, above the reasoning control. The label shows the alias and adds ↕ when other options exist. Click or scroll to cycle through the group and nodes, with removed nodes last.
   - Select a role on the ring, which shows only the selected group's roles (LDR, IMP). A standalone node has one role, so its ring is empty.
   - The dial retains its name, reasoning control, model, delivery, and permissions.
2. **Names.** A standalone node defaults to its provider name. The leader–implementer group defaults to the leader's provider name. Changing a node's provider updates an automatic name and preserves a custom alias.
3. **Set aliases in Squad.** For either the leader or implementer, edit "Group", stored in `onlyOneChat.team.name`. For a node, edit "Name". Clear the field to restore the default.
4. **The leader and implementer remain the only group for now.** Custom node groups, each with a role per node and a delegation cycle, are deferred until node delegation.
5. **SQUAD sits in the center of the composer**, between CTX and SEND, with the pending request count. In narrow panels it follows CTX.

## Consequences

- LDR and IMP fit on the ring. Group labels support up to 40 characters, truncated with "…" where space is limited.
- The Squad board shows individual cards. The "Group" alias identifies the pair.
