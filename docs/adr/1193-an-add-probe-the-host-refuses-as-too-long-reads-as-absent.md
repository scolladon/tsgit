---
subjects:
  - src/application/commands/add.ts
---
# 1193 — An add probe the host refuses as too long reads as absent

- **Status:** accepted
- **Date:** 2026-11-16
- **Design:** docs/design/long-pathspec-refusals.md (D3) · **Supersedes/Refines:** refines ADR-1035

## Context

With the caps gone (ADR-1192), `add` of a name no host can carry (`S300`, `S300/x`, a 4999-byte
path) leaks the disk probe's `PATH_TOO_LONG`, where git's `file_exists` / `lstat` reads any failure
as "not there" and says `pathspec '<p>' did not match any files`. The probe helpers are shared with
tracked-entry stats: folding inside `lstatOrMissing` would make `presentOnDisk` report an
un-stat-able tracked entry absent and `add .` stage a deletion git does not make.

## Options considered

1. **Read it as absent, folded on the pathspec probes only** (recommended) — a new
   `lstatPathspecBody` for `literalStats`, `namesOnDisk`, `namesDiskPath`, plus a fold at `add`'s
   call of `assertNoSymlinkedLeadingPath`.
2. **Surface `PATH_TOO_LONG`** — eight `add` rows stay unfaithful.
3. **Fold inside `lstatOrBeneathFile` and the scanner's `lstatPrefix`** — widens tracked-entry
   callers and 16 scanner consumers on no pinned row.

## Decision

**adopted-as-recommended (no user judgment)** — ADR-226 and the pinned matrix (rows C1, C3, C4,
C6). Tracked-entry stats (`presentOnDisk`, `renormalizeOne`, `hiddenWalkEntryOf`,
`movedGitlinkOf`) and the other scanner consumers keep propagating `PATH_TOO_LONG`.

## Consequences

### Neutral

- git's `warning: could not open directory` comes from its directory walk, not this probe; it has
  no structured analogue here.
