---
subjects:
  - src/domain/fsck/msg-ids.ts
  - src/domain/fsck/severity.ts
  - src/domain/fsck/validate-tree.ts
---
# 755 — The empty-name fsck message id is removed

- **Status:** accepted
- **Date:** 2026-08-30
- **Design:** docs/design/tree-entry-byte-sensitivity.md (D8) · **Supersedes/Refines:** none

## Context

ADR-754 moves the empty-name fault into the parse tier, where git reports it as
`badTree`. That leaves the `emptyName` message id with no emitter: `validate-tree.ts`
and the severity table are its only referents, and neither can produce it any more.

## Options considered

1. **Delete the id and its severity row** — pros: the repo's no-dead-code rule is unqualified / cons: the message-id catalogue stops being a complete mirror of upstream's list.
2. **Keep both, unreferenced, as documentation of git's id space** — cons: needs an explicit exemption from the no-dead-code rule, and the catalogue's own header claims it is cross-checked *behaviourally*, which a constant no behaviour can produce does not satisfy.
3. **Do not adopt the empty-name half of ADR-754** — cons: keeps the id alive but wrong; git reports `badTree:error` where tsgit would keep reporting `emptyName:warning`, so even the exit code diverges.

## Decision

**Adopted as recommended (no user judgment) — aligns with the repo's standing no-dead-code
rule.** The `emptyName` message id and its severity row are removed. The fault it named
is still reported, as `badTree`, which is what git reports.

## Consequences

The catalogue is a behavioural mirror of git's message ids, not a textual one: an id is
present when tsgit can emit it. Anyone adding an id from upstream's list adds the
behaviour that emits it in the same change.
