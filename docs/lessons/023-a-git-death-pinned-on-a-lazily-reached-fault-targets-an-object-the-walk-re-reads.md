---
subjects:
  - test/integration/midx-fsck-interop.test.ts
  - test/integration/midx-fixture-helpers.ts
  - test/integration/fsck-pack-accessibility-interop.test.ts
phases: [implementation, review]
kind: trap
trigger: pinning that git dies on a fault its enumeration reports but its walk reaches only for some objects
evidence:
  - test/integration/midx-fsck-interop.test.ts
  - test/integration/midx-fixture-helpers.ts
source: { run: fsck-pack-entry-crc-git-256, phase: review, date: 2026-10-29 }
status: active
supersedes: []
last-verified: 2026-10-29
---
# 023 — A git death pinned on a lazily-reached fault targets an object the walk re-reads

## Context

The multi-pack-index rows plant an out-of-range large-offset indirection and pin `git fsck`'s
exit. The helper always poisoned OOFF entry 0, the lowest object id in the index. The fixture's
commits carry unpinned dates, so the lowest id was a tree in some runs and a commit or blob in
others; git's parent exited 128 or 1 accordingly, and a review round "tightened" the row from a
set of exits to 128 on a sample of six green runs. The next reviewer saw it fail two runs in
four. A probe over three fresh fixtures, poisoning every entry in turn, gave 128 for every tree,
1 for every blob and a mix for commits.

## Lesson

`git fsck` frees every tree buffer during its pack pass and parses a reachable tree again,
through the multi-pack-index, when its connectivity walk descends into it; a parsed commit keeps
its parents and a blob is never re-read. A fault git's verify child always reports therefore kills
git's parent only when the poisoned entry is an object the walk re-reads. A pin on that death is
deterministic only when the row chooses such an object; a pin on "whatever sorts first" is a
coin toss whose weight depends on the fixture's dates.

## How to apply

Before pinning an exit that depends on git's walk reaching a planted fault, name the object the
fault sits on and show git re-reads it: a reachable tree (HEAD's root is one every fixture has),
never "entry 0" or "the first row".
Give the crafting helper an explicit entry or oid parameter; a helper fixed on position 0 hides the choice.
Prove the pin with repeated runs on fresh fixtures; when it still varies, probe every candidate
object once to learn which class git re-reads, then choose from that class.

## Evidence

`test/integration/midx-fsck-interop.test.ts` — `headTreeOf` and `midxEntryOf` pick HEAD's root
tree for the out-of-range large-offset row; five consecutive runs at git 128, tsgit 3.
`test/integration/midx-fixture-helpers.ts` — `craftLoffMidx` takes the OOFF `entry` to poison;
the in-range rows pass entry 0 explicitly.
