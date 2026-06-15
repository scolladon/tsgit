# ADR-341: Always unlink before a regular-file working-tree write

## Status

Accepted

- **Date:** 2026-06-15
- **Design:** [design/checkout-replace-symlink-with-file.md](../design/checkout-replace-symlink-with-file.md)

## Context

The shared working-tree writer ([ADR-340](340-consolidate-mode-aware-working-tree-writers.md))
must decide, before writing a regular file, whether to remove an entry that already
occupies the path. Two forms are possible: unlink unconditionally, or unlink only when an
`lstat` shows a symlink squatting the path.

The design pinned the relevant facts: the node adapter's `'creation'` containment rejects
a regular write only when the leaf is a **symlink** (a regular file at the path is
overwritten in place); git itself rewrites the path unconditionally on a kind change. The
memory adapter's `write` overwrites a symlink-squat path by setting a `files` entry
**without deleting the stale `symlinks` entry**, leaving both maps populated at one path.
The merge-side `writeWorkingTreeFile` already shipped the unconditional form (ADR-reviewed).

## Options considered

1. **(chosen) Always `rmIfExists` before the regular write** *(design recommendation)* —
   verbatim the shipped `merge.ts` idiom. Simpler, matches the precedent byte-for-byte,
   and clears the memory adapter's stale `symlinks` entry so a symlink→file write leaves a
   single correct entry on every adapter.
2. **Guard: `rmIfExists` only when an `lstat` shows a symlink** — a micro-optimisation
   (skips an `rm` when overwriting a regular file). Cons: diverges from the precedent,
   adds a branch + an extra `lstat`, buys nothing observable, and leaves the memory
   adapter's dual-entry corruption unfixed.

## Decision

The shared writer always calls `rmIfExists(ctx, path)` before a regular-file write — no
symlink guard. `rmIfExists` is `lstat`-probing (no symlink follow), so it is a no-op when
the path is empty and removes a dangling symlink too. This is the existing idiom in
`merge.ts` and in `writeFileEntry`'s own SYMLINK branch; the consolidation makes it the
single rule for both the regular and symlink branches of the one helper.

## Consequences

### Positive

- Cross-adapter-correct: a symlink→file write leaves exactly one entry on the node *and*
  memory adapters (the stale `symlinks` entry is cleared).
- One uniform rule (always unlink-then-write) — no per-branch leaf-state assumptions to
  reason about or mutate.

### Negative

- A regular-over-regular write now does a redundant `rm` the node adapter did not strictly
  require. The cost is one extra `lstat`+`unlink` syscall pair per write; negligible, and
  the merge side already pays it.

### Neutral

- Faithful to git, which rewrites the path unconditionally on a kind change; the extra
  unlink changes no observable on-disk state, only the syscall sequence.
