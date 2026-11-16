---
subjects:
  - src/domain/working-tree-path.ts
  - src/application/primitives/walk-working-tree.ts
---
# 1192 — Working-tree paths are not refused for their length

- **Status:** accepted
- **Date:** 2026-11-16
- **Design:** docs/design/long-pathspec-refusals.md (D2) · **Supersedes/Refines:** refines ADR-226

## Context

`validateWorkingTreePath`, `validateWorkingTreePathOn` and `validateWalkedEntryPath` refused a path
over 4096 bytes or a component over 255 UTF-8 bytes with `PATHSPEC_OUTSIDE_REPO`. A component of
100 CJK characters (300 UTF-8 bytes) is a legal name on APFS and NTFS (255 UTF-16 units), and git
2.56 stages, removes, moves, restores, greps, reports and blames it. tsgit refused it in `add`,
`add .`, `rm`, `mv`, `checkout --`, `grep --`, `status` and worktree `blame`. A name no host can
carry ends in git's no-match outcome, never an outside-repository refusal.

## Options considered

1. **Remove both caps from all three validators** (recommended).
2. **Remove them for pathspec bodies only** — the walk, `status`, `mv` and `blame` keep refusing a
   real name on a well-formed repository.
3. **Host-derived caps through a new port method** — duplicates what the OS already decides.

## Decision

**adopted-as-recommended (no user judgment)** — ADR-226 (refusal conditions follow git). The
total and component byte caps, and the machinery only they used, are deleted from all three
validators; every other rule and the error stay. Length is decided by the adapter: the node
adapter's OS raises `PATH_TOO_LONG`, the memory adapter has no limit. The walk's depth is bounded
by `maxDepth` (`TREE_DEPTH_EXCEEDED`) and by the OS refusing a `readdir`.

## Consequences

### Neutral

- `docs/use/primitives/walk-working-tree.md` no longer claims the 4096-byte cap fires before
  `maxDepth`.
