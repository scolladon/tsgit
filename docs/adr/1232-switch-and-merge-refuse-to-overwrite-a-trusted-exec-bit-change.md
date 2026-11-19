---
subjects:
  - src/application/primitives/apply-changeset.ts
---
<!-- cspell:ignore filemode -->
# 1232 — Switch and merge refuse to overwrite a trusted exec-bit change

- **Status:** accepted
- **Date:** 2026-11-19
- **Design:** docs/design/core-filemode-false.md (D-B, R9) · **Supersedes/Refines:** applies DOCTRINE D-2 and D-3

## Context

Under git's default `core.fileMode = true`, git refuses a switch or merge that would overwrite a
file whose only local change is its exec bit ("Your local changes … would be overwritten",
pinned rows K1t, K3t, K4t, M1t). `verify_uptodate` runs `ie_match_stat`, which counts the exec bit
as a change only when it is trusted. tsgit's `evaluateChangedPath` compares content only, so it
switches or merges and silently resets the user's bit. Under `false` both tools switch (K1, K3,
K4, M1).

## Options considered

1. **Fold: a mode test in `evaluateChangedPath`, honouring the policy; breaking `!`**
   (recommended).
2. Fix only the `false` side and file the `true` side as a backlog item.
3. Record K1t/K3t/K4t/M1t in `docs/known-divergences.md`.

## Decision

Option 1, ratified by the user. The check derives the mode with `indexModeFromStat(stat,
previousMode, trust)` from the `lstat` the occupant classification already takes, and refuses with
the existing `CHECKOUT_OVERWRITE_DIRTY` (merge maps it to `WORKING_TREE_DIRTY`) when it differs
from a regular `previousMode`. The commit is marked breaking.

## Consequences

### Negative

- A switch or merge that succeeded on the default configuration now throws when a file it rewrites
  has an exec-bit-only local change, as git does.

### Positive

- The user's exec bit is never silently reset.
