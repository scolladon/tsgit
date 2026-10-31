---
subjects:
  - src/application/commands/internal/fsck/types.ts
  - src/application/commands/internal/fsck/refs-verify.ts
  - src/application/primitives/ref-store.ts
---
# 1138 — fsck reports a refs root it cannot open as `refs-walk-failed`

- **Status:** accepted
- **Date:** 2026-10-31
- **Design:** docs/design/fsck-broken-ref-chain-unreadable.md · **Supersedes/Refines:** refines ADR-1127 and ADR-1137

## Context

Probed on git 2.56.0: when a `refs` root itself cannot be opened (a linked worktree's own
`worktrees/<id>/refs` at mode 000, or `refs/` at 0300), `git fsck` prints
`warning: error opening directory '<root>/'` and then `error: failed to iterate over '<root>'`,
and exits 8. A directory below a root only warns (exit 0). Under ADR-1137 the walk skips such a
root, so tsgit printed the warning and exited 0. The second line is not an fsck msg-id.

## Options considered

1. **A new path-keyed `FsckFinding` arm `{ type: 'refs-walk-failed'; path }`, bit 8, gated by
   `checkReferences`, emitted right after the root's `unreadable-ref-path`** — pros: the
   `unreadable-ref-path` precedent (ADR-1127), git's exit bit / cons: one more arm.
2. **Reuse `unreadable-ref-path` with an extra flag** — cons: one finding for two git lines with
   different severities and exit bits.

## Decision

**Adopted-as-recommended (no user judgment): option 1.** A refs root the walk cannot open adds a
`refs-walk-failed` finding with the root's absolute `path`, severity error, bit 8, gated by
`checkReferences`, after that root's `unreadable-ref-path`. A directory below a root reports only
`unreadable-ref-path`.

## Consequences

- `FsckFinding` gains one public arm; `docs/use/commands/fsck.md` lists it.
- ADR-1137's "fsck exactly as git" holds for an unreadable refs root.
