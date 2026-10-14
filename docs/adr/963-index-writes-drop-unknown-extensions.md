---
subjects:
  - src/domain/git-index/carry-extensions.ts
  - src/application/primitives/internal/index-lock.ts
---
<!-- cspell:ignore EOIE IEOT FSMN -->
# 963 — Index writes drop unknown extensions

- **Status:** accepted
- **Date:** 2026-10-14
- **Design:** docs/design/status-refresh-index-extensions.md · **Supersedes/Refines:** refines ADR-226

## Context

The backlog's starting point was to forward unknown optional extensions verbatim. Pinned against git
2.55, every index write — refresh-only writes included — drops an optional extension git does not
understand (`ignoring ZZZZ extension` on read, absent after any write; §D1.4–§D1.5 of the design). git
also regenerates `EOIE`/`IEOT`/`FSMN` from configuration rather than forwarding them.

## Options considered

1. **Drop on every write, as git does** (recommended).
2. **Forward verbatim.** Cons: an index git itself never writes; a forwarded stale `EOIE`/`IEOT` would
   describe entries that no longer exist.
3. **Forward on refresh writes only.**

## Decision

**Adopted-as-recommended (no user judgment) — option 1.** Every tsgit index write drops optional
extensions it does not carry by rule (`TREE`, `REUC`, `UNTR`), and drops `EOIE`, `IEOT` and `FSMN`, which
tsgit does not write. Mandatory unknown extensions are still refused at read. Aligns with ADR-226.

## Consequences

- The carry rules are a closed list; adding one is a new decision, not a default.
