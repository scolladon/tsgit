---
subjects:
  - src/application/primitives/reflog-store.ts
  - src/application/primitives/internal/record-ref-update.ts
  - src/application/primitives/path-layout.ts
---
# 1168 — reflog reads through a prefixed name use the same locator as writes

- **Status:** accepted
- **Date:** 2026-11-08
- **Design:** docs/design/fsck-worktree-private-refs.md · **Supersedes/Refines:** refines ADR-1164

## Context

git's `files_reflog_path` routes a reflog through the same worktree selection as
`files_ref_path`: `git reflog main-worktree/HEAD` from a linked worktree shows the main
worktree's HEAD log, `worktrees/wt/HEAD` from the main one shows `<common>/worktrees/wt/logs/
HEAD` (W35, W36), and every write through a prefix appends to that log (W2, W9, W11, W17).
tsgit reads and writes `<common>/logs/worktrees/wt/HEAD`, a path git never uses, so the reads
return nothing and the writes log nowhere git looks. ADR-1164 names the writes; the reads are
the other half of the same path rule.

## Options considered

1. **One locator for both: `refReflogPath(ctx, name)` serves reads and writes** — it runs
   the one `parseWorktreeRef` and selects the same store as `refLocation`, so ref and log
   cannot route apart —
   pros: the read/write split ADR-1164 removed for refs does not come back for logs. The
   designer's recommendation.
2. **Writes only, with a second reflog locator for reads** — cons: reintroduces the split and
   leaves W35 and W36 red.

## Decision

**Adopted-as-recommended (no user judgment) — basis DOCTRINE(D-2) and ADR-1164, pinned by
W35, W36, W2, W9, W11 and W17: option 1.** `reflog-store.ts` and `record-ref-update.ts` take
the reflog path from `refReflogPath`, beside `refLocation` in `path-layout.ts`; the auto-create gate keeps judging the full name as
git's `log_ref_setup` does.

## Consequences

- Reflog reads through `main-worktree/<pw>` and `worktrees/<id>/<pw>` return the target
  worktree's log; writes through them append where git appends.
