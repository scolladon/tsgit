# ADR-069: Sparse checkout is built on the skip-worktree bit via index v3

## Status

Accepted (at `c85927a`)

## Context

Sparse checkout materialises only a subset of a repository's tracked files.
Two mechanisms could implement "this path is intentionally absent from the
working tree":

1. **Drop the entry from `.git/index`.** Only in-pattern paths get index
   entries; out-of-pattern paths are simply not recorded.
2. **Keep every entry, mark it.** The index records the *whole* tree; a
   per-entry **skip-worktree** bit records which paths are absent from disk.

git uses (2). The skip-worktree bit lives in the **extended flags** field of
an index entry, which only exists in index format **version 3+**. tsgit's
index parser/writer today support **only v2**: `IndexEntryFlags` is
`{ assumeValid, extended, stage }`, the parser *rejects* any entry with the
`extended` (`0x4000`) bit set, and the writer always emits version 2.

So implementing sparse checkout faithfully forces an index-format decision.

## Decision

Implement sparse checkout on the **skip-worktree bit**, and therefore add
**index v3** support to the parser and writer.

- `IndexEntryFlags` becomes `{ assumeValid, stage, skipWorktree, intentToAdd }`.
  The old `extended` field is **removed** — its value is fully determined by
  `skipWorktree || intentToAdd`, so storing it invites an invariant bug. The
  parser computes `extended` locally to decide whether to read the extra
  16-bit field; the writer computes it locally to decide whether to emit it.
- `intent-to-add` (the other extended-flags bit) is modelled even though tsgit
  never *sets* it — so that reading a git-written v3 index containing
  `git add -N` entries and writing it back round-trips faithfully instead of
  silently dropping the bit.
- `serializeIndex` **derives** the on-disk version from the entries: v3 iff any
  entry has `skipWorktree || intentToAdd`, else v2. git writes the minimum
  representable version; tsgit matches that. A non-sparse repo's index stays
  byte-identical to today.
- `GitIndex.version` widens from the literal `2` to `2 | 3`. v4
  (path-prefix compression) remains rejected.

Approach (1) — dropping entries — is **rejected**: the next `commit` would
serialise a tree missing those paths (silent, history-wide data loss),
`disable` could never restore them, and the index would not match the tree it
claims to stage. It is not git-faithful and is unsafe.

## Consequences

### Positive

- Git-faithful: a tsgit sparse repo's index is readable by canonical git
  (`git ls-files -t` shows the `S` flag) and vice versa.
- `commit` needs no change — skip-worktree entries keep their `id`/`mode`, so
  the committed tree always contains every path.
- Removing the derived `extended` field eliminates a class of invariant bug.
- Non-sparse repos see zero change: `serializeIndex` still emits v2,
  byte-identical output.

### Negative

- A breaking shape change to the exported `IndexEntryFlags` type and to
  `GitIndex.version`. Every `IndexEntry` construction site must migrate to the
  new flags shape (compiler-enforced, mechanical — `STAGE0_FLAGS` is provided).
- The parser/writer gain v3 branches: extended-flags read/write, a widened
  per-entry truncation guard, dynamic version selection.

### Neutral

- 17.x targets v2.0, so a breaking domain-type change is in-window.
- Old (v2) indexes parse unchanged — no runtime migration.
- The git **sparse-index** optimization (collapsing an excluded subtree to one
  index entry) is *not* adopted; tsgit's index keeps one entry per file. Only
  index size is affected, not the visible sparse-checkout behaviour.
