# ADR-321: conflict writes are mode-aware repo-wide — ours'/merged mode, exec bit included

## Status

Accepted (at `<sha-after-merge>`)

## Context

Git materialises every conflicted path in the worktree with the merged/ours
**file mode** — symlinks are re-created as symlinks, and the executable bit is
preserved on marker files (verified against git 2.54.0: a content conflict on
a 100755 file leaves a 755 marker file on disk).

tsgit's conflict writes diverge in two tiers:

1. **Kind:** the take-ours fallback (`writeConflictToTree` in merge,
   `writeMarkedConflict` in apply) only honoured `ourMode` for `add-add`
   conflicts — a `type-change` whose ours side is a symlink wrote the link's
   target bytes as a regular file.
2. **Exec bit:** the `conflictContent` (marker-bytes) path writes through
   `writeWorkingTreeFile` with no mode — a pre-existing, repo-wide gap for any
   content conflict on an executable file, merely re-surfaced by this item.

The alternative was fixing only tier 1 here and deferring the exec-bit fix to
a backlog follow-up (it touches every existing conflict write path).

## Decision

Fold the whole class in now: both conflict writers use **ours'/merged mode
whenever `ourMode` is defined**, for every conflict type —

- bare take-ours conflicts re-create ours' kind (symlink ⇒ `fs.symlink`,
  regular ⇒ file with ours' mode);
- marker-bytes (`conflictContent`) writes carry the resolved/ours mode, so
  exec bits survive conflict materialisation;
- `modify-delete` keeps its existing survivor logic (its present side is by
  definition the unchanged kind already on disk).

Interop assertions for this item pin worktree **bytes, kinds, and modes**.

## Consequences

### Positive

- One rule fixes the symlink-bytes-as-file bug *and* the exec-bit gap for
  every current and future conflict type — no second sweep needed.

### Negative

- Wider blast radius than the item's literal brief: every existing conflict
  write path changes and must be re-pinned (interop + unit).

### Neutral

- Equivalence comments asserting "take-ours reproduces bytes already on disk"
  become false where a base exists (content can change side) and must be
  re-derived, not kept.
