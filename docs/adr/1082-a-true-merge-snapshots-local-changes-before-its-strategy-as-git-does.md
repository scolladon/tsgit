---
subjects:
  - src/application/commands/merge.ts
---
# 1082 — A true merge snapshots local changes before its strategy, as git does

- **Status:** accepted
- **Date:** 2026-10-25
- **Design:** docs/design/forced-checkout-displace-occupant.md (DC8, P9) · **Supersedes/Refines:** refines ADR-226

## Context

After a merge-strategy refusal, git 2.55 restores the work tree from a snapshot of the local
changes. Re-pinned on a successful non-fast-forward merge with one modified tracked file, git
2.55 wrote that snapshot even though nothing was refused: two commits, one tree and one blob,
unreachable from any ref. A clean work tree writes no snapshot. The design recommended taking the
snapshot only after a refusal, which is cheaper and gives the same work tree and refs. It leaves
a different object store.

## Options considered

1. **Snapshot only on refusal**, plus an up-front beyond-symlink scan of every tracked path. The
   work tree and refs match git; the object store does not.
2. **git's order:** snapshot the local changes before every true-merge strategy when the work tree
   is dirty.
3. **Snapshot only on refusal, without the scan.** This diverges on the beyond-symlink rows.

## Decision

**Option 2, by the user's standing faithfulness rule, which deviates from the design's
recommendation.** Faithfulness covers residue: on-disk state git leaves behind is part of the
observable behaviour. The design names this cost: the snapshot hashes every modified file before
each dirty true merge. git pays the same cost. The up-front beyond-symlink exit 128 is pinned as
git does it.

## Consequences

- The interop rows compare the loose objects a dirty merge leaves, not just the work tree and refs.
- A clean work tree takes no snapshot, so clean merges gain no cost.
