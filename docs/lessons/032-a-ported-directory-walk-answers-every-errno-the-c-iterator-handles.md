---
subjects:
  - src/application/primitives/ref-store.ts
  - src/application/commands/internal/fsck/**
  - test/unit/application/primitives/ref-store.test.ts
phases: [design, review]
kind: trap
trigger: a review round finds a ported directory walk throwing on a stat or readdir failure code that git's iterator skips or warns about
evidence:
  - src/application/primitives/ref-store.ts
  - test/unit/application/primitives/ref-store.test.ts
  - docs/design/fsck-worktree-private-refs.md
source: { run: fsck-worktree-private-refs, phase: review, date: 2026-11-08 }
status: active
supersedes: []
last-verified: 2026-11-08
---
# 032 — A ported directory walk answers every errno the C iterator handles, not the ones the fixtures reach

## Context

The ref-content walk was ported from git's `files_fsck_refs_dir`, which iterates with
`dir_iterator`: an `lstat` on every entry, `warning: failed to stat` on any errno but `ENOENT`,
`warning: error opening directory` on any directory-open errno but `ENOENT`, and the entry or level
skipped in both cases. The port handled the one code the fixtures could stage, `EACCES`, and
rethrew everything else. Three review rounds then each found another code on the same walk:
`ENAMETOOLONG` from a link too long to resolve (a hang-free refusal git does not have),
`ENOENT` from an entry or directory removed between the listing and its stat (a crash on a
race `git branch -D a/b` produces), and `ENOTDIR` from a component that turned into a file
(a crash where git warns). Each round cost a fix commit, new unit rows and a fresh fix-delta
review, for a table git's source had spelled out from the start.

## Lesson

A walk that mirrors a C iterator inherits the iterator's whole errno table, including the
codes no fixture can stage against the binary. The design row for such a code is pinned from
the C source (`dir-iterator.c` `prepare_next_entry_data` and `push_level`), the unit row fakes
the adapter call that fails, and the verdict is one of three: pass over in silence (`ENOENT`),
warn and skip (`EACCES`, `ENOTDIR`), or refuse (nothing — the iterator never does). Deferring
the `lstat` of a safe regular file to its read is an optimisation the port may keep, but then
every failure of that read must reconstruct the stat verdict git would have given.

## How to apply

When porting a walk, read the C iterator's error handling first and list every errno it names, with git's verdict for each.
Give each errno a design row whose source is the C file and line when the binary cannot stage it, and a unit row faking the failing adapter call.
Map the adapter codes once: `FILE_NOT_FOUND` silent, `PERMISSION_DENIED` and `NOT_A_DIRECTORY` warned, `PATH_TOO_LONG` and `SYMLINK_LOOP` unreachable.
Where a stat is deferred to the read, every read failure code reconstructs the stat verdict; a rethrow is a decision, never a default.
Expect the reviewer's hostile-input pass to probe exactly these codes: a rethrow it reaches is a HIGH.

## Evidence

`src/application/primitives/ref-store.ts` — `statSkipsEntry`, `warnedPathReasonOf`, `readdirForIntegrity` and `readLooseContentOrRefusal` carry the mapped table; `UNRESOLVABLE_LINK_CODES` names the unreachable-target codes.
`test/unit/application/primitives/ref-store.test.ts` — the describes "an entry gone by the time the walk stats it" and "the walk meets a path that changed under it" fake each failing call and pin the verdict.
`docs/design/fsck-worktree-private-refs.md` — matrix rows V1, V2 and V6 to V9, pinned from `dir-iterator.c` where the race cannot be staged.
