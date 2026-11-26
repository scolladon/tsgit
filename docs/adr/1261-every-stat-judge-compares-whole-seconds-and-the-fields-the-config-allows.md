---
subjects:
  - src/application/primitives/internal/is-entry-stat-clean.ts
  - src/application/primitives/compare-working-tree-entry.ts
---
# 1261 — Every stat judge compares whole seconds and the fields the config allows

- **Status:** accepted
- **Date:** 2026-11-25
- **Design:** docs/design/whole-second-stat-match.md (G-a, G-b, R1) · **Supersedes/Refines:** applies DOCTRINE(D-2), DOCTRINE(D-5), ADR-226

## Context

`matchesContentStat` compares mtime and ctime to the nanosecond, with uid, gid, inode and size,
whatever the configuration says. git's `match_stat_data`, built without `USE_NSEC`, compares
mtime seconds and size always, ctime seconds only under `core.trustCtime` and `core.checkStat`,
and uid, gid and inode only while `core.checkStat` is not `minimal`.

A `chmod` in the second a file was staged therefore makes `checkout -- f`, a forced switch and
`reset --hard` rewrite a clean file where git leaves it (rows A1, A2, A4). `core.trustCtime=false`
and `core.checkStat=minimal` are honoured only on the assume-unchanged path (rows C2, C3, L2).

## Options considered

1. **One compare, `matchesStatData(entry, stat, check)`, used by every judge** (recommended).
2. Drop the nanoseconds and keep the configuration on the assume-unchanged path only.
3. Keep the nanoseconds, as a `USE_NSEC` build would.

## Decision

**Adopted-as-recommended (no user judgment)** — DOCTRINE(D-2) and DOCTRINE(D-5): the brief's fix
is the shared compare, and the configuration gap is proven in the function the change edits.
Option 1.

Refused: option 2 leaves rows C2, C3 and L2 red. Option 3 models a build no platform default
enables; the local binary is measured without it (row A1).

## Consequences

### Positive

- A clean file whose stat moved inside one second is left untouched by `checkout -- f`, a forced
  switch and `reset --hard`.
- Divergence-ledger row 32.90 is removed.

### Negative

- A clean file whose ctime moved by a whole second is still rewritten (row C1), as git rewrites it.
- The stat compare no longer sees a change inside one second. The racy test of ADR-1262 covers
  that window.
