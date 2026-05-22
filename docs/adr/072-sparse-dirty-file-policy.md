# ADR-072: Narrowing retains dirty files instead of discarding their changes

## Status

Accepted (at `c85927a`)

## Context

When sparse patterns *narrow* (a file that was in the working tree moves out
of pattern), the file must be deleted from disk and its index entry marked
skip-worktree. But the file may carry **uncommitted local modifications**.
Three policies are possible:

1. **Delete unconditionally** — silently discards the user's work.
2. **Abort the whole operation** — `set`/`reapply` fail; nothing changes.
3. **Retain the dirty file** — leave it on disk, do *not* set its
   skip-worktree bit, apply the rest, and report which files were retained.

git uses (3) for `git sparse-checkout`: it prints "the following files have
modifications and were not removed" and leaves them, keeping skip-worktree
clear so the file stays visible.

## Decision

The `sparseCheckout` command (`applySparseCheckout` engine) uses policy **3**.

- Before deleting any to-be-excluded file, hash-compare it against its index
  `id` (the shared `isWorkingTreeDirty` helper — the same compare the
  `checkout` dirty guard already trusts).
- A dirty file with `force` falsy is **retained**: not deleted, its index
  entry keeps `skipWorktree: false`, and its path is collected into
  `ApplySparseCheckoutResult.retained`.
- `force: true` overrides — the dirty file is removed like any other.

The **`checkout` command keeps its own, different dirty policy** — policy 2.
A branch switch that would exclude a dirty file hits `checkout`'s existing
whole-operation guard and throws `CHECKOUT_OVERWRITE_DIRTY`. Each command
keeps the dirty semantics it already established; they are not unified.

## Consequences

### Positive

- Git-faithful for `sparse-checkout`; uncommitted work is never silently lost.
- `result.retained` gives the caller a precise, programmatic signal that
  patterns did not fully take effect.
- Reuses the existing hash-compare — no new dirty-detection logic.

### Negative

- The two commands (`sparseCheckout` retain, `checkout` abort) treat a dirty
  excludee differently. Documented, deliberate — but a caller must know which
  command they are using to predict the outcome.

### Neutral

- `force: true` is the single, explicit override for both commands.
- A retained file is left with `skipWorktree: false`, so a later `reapply`
  (once the file is committed or reverted) completes the narrowing.
