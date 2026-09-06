---
subjects:
  - src/adapters/node/node-file-system.ts
---
# 825 — The Windows replace arm removes the empty destination first and maps its errno

- **Status:** accepted
- **Date:** 2026-09-06
- **Design:** docs/design/memory-write-exclusive-directory.md (DC-L) · **Supersedes/Refines:** none

## Context

On Windows the node adapter emulates the POSIX rule that a directory renamed onto an empty
directory replaces it and onto a non-empty one is refused. The arm must tell the two apart before
it removes anything. The design's recommendation to read the directory first rested on an
unmeasured fact: which errno node reports on Windows for `rmdir` of a non-empty directory. The
user ruled that the measurement decides. It was taken on `windows-latest` with node v24.19: `rmdir`
on a non-empty directory rejects with `ENOTEMPTY`, the same errno as on linux and darwin.

## Options considered

1. **`readdir` the destination, refuse when it has entries, then `rmdir` and `rename`** —
   pros: depends on no platform errno / cons: one extra syscall on the arm.
2. **`rmdir` the destination first and let the errno map translate a failure** — git's own
   compatibility-layer sequence — pros: one syscall cheaper, and the refusal code comes from the
   same errno mapping every other refusal uses / cons: rests on the errno now measured.
3. **Option 2 with a `readdir` re-classification when the errno is not the non-empty one** —
   cons: two code paths for one verdict.

## Decision

**Ratified by the user through the rule "the measurement decides": option 2.** After both
`lstat` probes prove a directory source and a directory destination, the arm removes the
destination with `rmdir` inside the same errno-mapped operation as the rename and renames on
success. A non-empty destination fails the `rmdir` with `ENOTEMPTY`, which maps to
`DIRECTORY_NOT_EMPTY` carrying the source path; any other `rmdir` errno passes through the same
map. `readdir` is never called.

## Consequences

The directory-onto-directory arm costs two `lstat` calls and one `rmdir` on Windows and nothing
on POSIX. The dependency-injected unit rows pin an `rmdir` rejecting `ENOTEMPTY` as
`DIRECTORY_NOT_EMPTY` with no rename issued, and an `rmdir` that resolves as the removal followed
by the rename in that order. The sequence is the one git's compatibility layer performs.
