---
subjects:
  - src/application/primitives/ref-store.ts
  - src/application/commands/internal/fsck/types.ts
  - src/application/commands/internal/fsck/refs-verify.ts
---
# 1154 — a store gitdir whose root refs cannot be listed is its own finding

- **Status:** accepted
- **Date:** 2026-11-07
- **Design:** docs/design/fsck-worktree-private-refs.md · **Supersedes/Refines:** refines ADR-249

## Context

`for_each_root_ref` opens the store gitdir to find its root refs. When that directory open fails it
returns -1 and prints nothing, and `files_fsck` reports failure: a linked admin directory at
mode 0300 makes `git fsck` exit 8 with no line at all (pin H, twice). ADR-249 wants the data
behind every exit bit. The exit table has one precedent for a bit with no finding (the
cache-tree pointer), which the design calls a gap rather than a model.

## Options considered

1. **A new arm `{ type: 'unreadable-root-refs', path, reason: 'PERMISSION_DENIED' }`, bit 8,
   gated by `checkReferences`, rendered as no line** — pros: every bit has its datum / cons: a
   finding git never prints. The designer's recommendation.
2. **Bit 8 with no finding** — cons: an exit code no finding explains.
3. **Map it onto `refs-walk-failed`** — cons: the interop would render
   `failed to iterate over`, which git never prints here.

## Decision

**Adopted-as-recommended (no user judgment) — basis ADR-249: option 1.** The store walk pushes
a `rootRefsUnreadable` integrity finding when the store gitdir cannot be listed for its root refs;
`refs-verify.ts` maps it to the `unreadable-root-refs` arm, counts it in `failsRefsVerify`, and
the interop renders it as no line.

## Consequences

- `docs/use/commands/fsck.md` gains the arm and its exit row.
- The arm is reachable only on POSIX file systems with a mode the user can set; the interop
  rows are gated like the other `chmod` rows.
