---
subjects:
  - src/domain/diff/rename-detect.ts
---
# 893 — The exact rename pass transcribes git's `find_identical_files`

- **Status:** accepted
- **Date:** 2026-09-25
- **Design:** docs/design/rename-exact-one-shot-delete.md (§2–§4.1, D1) · **Supersedes/Refines:** refines ADR-370

## Context

`detectRenames` folds an add into a same-id delete only when the id group holds exactly one
delete, and never removes a folded delete from its group. Two adds sharing one id therefore
both fold the same delete (issue #300 part A): two renames share one source and an add
vanishes. Multi-delete groups are left to the similarity pass, which has no basename
preference and is skipped over the rename limit — so six further `-M` rows diverge from
git 2.55.0, two of them against ADR-370's "exact pairing is never limited".

## Options considered

1. **Minimal one-shot** — drop a folded id from the map; keep the one-delete refusal. Fixes the
   reported rows, leaves #4, #7, #8, #12, #17, #18 wrong.
2. **Faithful `-M` port of `find_identical_files`** — *recommended by the design.*
3. **Option 2 plus copy-aware exact pairing under `-C`** — moves copy semantics into the
   domain pass; needs its own pin matrix.

## Decision

**Option 2 — ratified by the user.** Adds are visited in path order. Each takes, among the
unused deletes of the same id, the first mode-compatible candidate maximising
`1 + basenameSame` (score 2 stops the scan), within git's examined-candidate cap. A
consumed delete is never offered again. Mode-compatible means both sides are regular files,
or both modes are equal. The pass is never gated by the rename limit.

## Consequences

- One delete is the source of at most one exact rename; every input path survives.
- Identical-content renames prefer a basename match, which also resolves the identical-blob
  repro reported in #300 part B; part B narrows to inexact ties.
- `-C` fan-out (rows #9/#10) stays divergent — follow-up.
