# 633 — `walkWorkingTree` derives entry kinds from readdir and fetches stats lazily

- **Status:** accepted (ratified by user)
- **Date:** 2026-08-13
- **Design:** docs/design/git-parity-containment.md (DC-11 / P9) · **Supersedes/Refines:** —

## Context

`walkWorkingTree` pays a full `lstat` plus a second `joinPath` for every entry, even
though the parent's `readdir` already returned the entry's file/directory/symlink kind
bits, and `status`'s untracked pass reads only `{ path }` off each yielded entry — the
stat is pure cost there. This is a walker concern, not a containment one; the user opted
it into this change's scope (the acceptance signal of both is `status:clean`).

## Options considered

1. Out of scope — leaves a measurable `status` cost on the table.
2. **Reuse the `readdir` `DirEntry` kind bits; make the `FileStat` lazily fetched per
   consumer** (design recommendation).
3. A separate stat-free walk shape for path-only consumers — duplicates the walker.

## Decision

**Ratified by the user: option 2.** The walker derives is-file/is-dir/is-symlink from
the `readdir` batch and exposes the full `FileStat` as a lazy per-entry fetch; consumers
that need it (add's stage path) pay it, consumers that don't (status's untracked pass)
don't.

## Consequences

- One `lstat` + one `joinPath` saved per walked entry on stat-free consumers —
  a direct `status:clean` contribution.
- Walker consumers are audited once for which side of the laziness they need;
  behaviour (yielded paths, skip rules, symlinked-dir non-traversal) is unchanged.
