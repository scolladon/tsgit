---
subjects:
  - src/application/commands/stash.ts
---
# 1106 — `stash push` keeps the index id of a same-gitlink type change that leads its diff

- **Status:** accepted
- **Date:** 2026-10-28
- **Design:** docs/design/stash-apply-dir-file-replacement.md (fold of impact I2, outside the design's matrix) · **Supersedes/Refines:** refines ADR-226

## Context

`stash push` records every index gitlink as unchanged in the W tree, so a regular file or a symlink standing at a
gitlink's path was dropped from the stash and its bytes lost on the reset, where git records the occupant and
`apply` restores it. Folding that gap exposed a position-dependent behaviour of git, verified on 2.55.0 and 2.56.0
with scrubbed throwaways: when HEAD and the index hold the same gitlink and a regular file or a symlink stands at
its path, `stash push` records the occupant (100644 / 120000) in every position except when that path is the first
changed path in index order, where W keeps the 160000 index id and the reset discards the occupant. A deletion, a
lost-HEAD gitlink or a staged blob→gitlink type change in first position is recorded. A hand replay of git's own
`update-index -z --add --remove --stdin` step converts the gitlink in every order, so the drop happens in stash's
working-tree diff step. Two correct probes disagreed only because one seeded the gitlink last and the other first.

## Options considered

1. **Replicate git byte-for-byte** — pros: identical W trees and on-disk outcomes in both tools, including the
   first slot (ADR-226) / cons: tsgit reproduces a slot where the user's occupant is lost on the reset, as in git.
2. **Record the occupant at every position behind an ADR** — pros: no data loss in the first slot / cons: a
   recorded divergence of the W tree in that slot; the twin asserts a documented difference against git's output.
3. **Keep the index id at every position behind an ADR** — pros: simplest rule / cons: diverges from git in every
   position but the first, and the occupant is always lost.

## Decision

**User-ratified: option 1.** A gitlink that HEAD and the index hold alike, with a regular file or a symlink
standing at its path, rides on its index id when it sorts before every listed non-gitlink changed path (a tracked
non-gitlink entry whose state is not unchanged or that differs from the base, or a non-gitlink path HEAD holds and
the index lost); once such a path precedes it, the occupant is recorded. Deleted gitlinks, lost-HEAD gitlinks and
untracked files are not listed paths, so they neither end nor start the leading run; a deletion, a lost-HEAD
gitlink or a staged type change at a gitlink is recorded in any position. Probed on git 2.55.0: `T a, T b, M z`
keeps `a` and `b`; `T a1, M a15, T a2` keeps `a1` and records `a15` and `a2`; `d a1, T a2, M z1` keeps `a2`. A
gitlink path's work-tree state never counts as a local change on its own, as git's `check_changes` with
`--ignore-submodules` never counts it.

## Consequences

- The W projection of a gitlink entry depends on the index order of the changed set; the classifier computes it
  once over the sorted changed paths.
- Interop twins pin the same shapes with the gitlink sorting first and last, so a fixture's position can no longer
  hide the behaviour.
- The rule is observable git behaviour on 2.55.0 and 2.56.0; if a later git records the first slot too, this ADR is
  the one to supersede.
