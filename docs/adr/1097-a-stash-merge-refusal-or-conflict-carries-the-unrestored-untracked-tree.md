---
subjects:
  - src/application/commands/stash.ts
  - src/domain/commands/error.ts
---
# 1097 — A stash merge refusal or conflict carries the unrestored untracked tree

- **Status:** accepted
- **Date:** 2026-10-27
- **Design:** docs/design/stash-apply-dir-file-replacement.md (DC2, F3, F4) · **Supersedes/Refines:** refines ADR-212, ADR-1096

## Context

git restores the stash's untracked files whatever the merge's outcome. When the merge refuses ("Your local changes
… would be overwritten") or conflicts, and the untracked restore then also leaves something unwritten, git prints
both the merge outcome and the restore's errors and exits 1 (A.3 FU dirty-f-untr-u, conflict-f-untr-u). tsgit has
to carry two outcomes in one structured result: the refusal is a thrown `STASH_APPLY_WOULD_OVERWRITE`, the conflict
is a `{ kind: 'conflict' }` result (ADR-212), and ADR-1096 defines the restore's own data shape.

## Options considered

1. **An optional `untrackedNotRestored` on the refusal's data and on the `conflict` result** (designer's
   recommendation) — pros: both outcomes stay in structured data; a caller can rebuild git's full stderr (ADR-249)
   / cons: one optional field on a public result type and on an error's data.
2. **Report the merge outcome only** — pros: no surface change / cons: the restore failure is visible on disk only;
   a caller cannot rebuild git's output.
3. **The untracked error wins** — pros: one outcome / cons: hides a conflict the caller must resolve, and turns a
   result kind into a throw.

## Decision

**User-ratified: option 1.** When the untracked restore reports something, `STASH_APPLY_WOULD_OVERWRITE`'s data and
the `{ kind: 'conflict' }` result carry an optional `untrackedNotRestored: { existing, blockedAt? }`, the same shape
ADR-1096 defines. The field is absent when every untracked file was restored or the stash has none.

## Consequences

- `StashApplyResult` / `StashPopResult`'s `conflict` variant and the refusal's error data gain one optional field
  (`reports/api.json`, additive).
- The merge outcome keeps its kind: a refusal still throws, a conflict still returns, `pop` still keeps the stash.
- Interop rows reconstruct git's stderr as the merge block followed by the restore lines, from the two parts of the
  data.
