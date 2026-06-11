# ADR-319: symlink/symlink pairs are bare `content` conflicts — link targets are never merged

## Status

Accepted (at `<sha-after-merge>`)

## Context

When **both sides are symlinks** with different targets (both changed relative
to the base), git keeps ours' symlink in the worktree and reports a plain
`CONFLICT (content)` with three stages at the path — it **never content-merges
link targets**, regardless of the base's kind. Verified against git 2.54.0 ort
for both a symlink base and a kind-changed (regular-file) base.

tsgit today diverges twice:

1. With a symlink base, it **content-merges the target bytes** and writes the
   merged/markered bytes **as a regular file** — wrong content semantics *and*
   wrong file kind on disk.
2. The conflict was typed `type-change` (take-ours), whose name misdescribes a
   pair where no side changed kind relative to the other.

The brief literally covered only the kind-changed-base case; the alternatives
were keeping the `type-change` label (minimal surface change) and scoping the
fix to kind-changed bases only (leaving divergence 1 in place).

## Decision

- Ours-symlink/theirs-symlink both-changed pairs — **regardless of base kind**
  — emit a bare take-ours conflict typed **`content`**, carrying all three
  stage fields, with **no `conflictContent`** and no merger invocation.
- The worktree write is mode-aware: ours' symlink is re-created (never its
  target bytes as a regular file), per ADR-321's generalised take-ours write.
- `content` matches git's display family (`CONFLICT (content)`, `UU`
  porcelain); the absence of `conflictContent` tells consumers no merged bytes
  exist — the worktree holds ours' side verbatim.

## Consequences

### Positive

- Removes the symlink-target content-merge divergence in the same guard that
  the brief's case needs — one rule, both base kinds, pinned by interop.
- Structured type aligns with the porcelain family git assigns these pairs.

### Negative

- `content`-typed conflicts no longer always carry `conflictContent`;
  consumers reconstructing displays must handle the bare shape.

### Neutral

- Symlink pairs where only one side changed stay trivially resolved (take the
  changed side) — unaffected, already faithful.
