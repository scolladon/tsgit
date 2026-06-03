# ADR-255: `status` promotes type-change and mode-only change to first-class `ChangeKind` values across both columns

## Status

Accepted (at `4e9f9433`) — supersedes [ADR-254](254-status-staged-column-coarse-changekind.md)

## Context

[ADR-254](254-status-staged-column-coarse-changekind.md) wired the staged column
but deliberately collapsed `diffIndexAgainstTree`'s `type-change` into
`ChangeKind.modified`, "matching the working-tree column's existing projection".
That ADR's own "Negative" consequence recorded the cost: `status`'s structured
output cannot reconstruct git porcelain `T`. It explicitly left "a faithful
`type-change` (and mode-only) `ChangeKind`, applied to **both** columns together"
to a logged follow-up — this is that follow-up.

Grounded against real `git` (isolated env, signing off), git's status **XY**
distinguishes exactly two states inside the modify family:

- **`T`** — a *kind* change (`file` ↔ `symlink` ↔ `gitlink`), both columns.
- **`M`** — a content change **or** a mode-only change (exec-bit flip, same
  blob), both columns. Porcelain **v2** additionally surfaces the old/new modes,
  so the content-vs-mode distinction is real data git's diff machinery carries —
  just not rendered as a distinct XY letter.

Today both columns flatten all three onto `modified`:

```ts
type ChangeKind = 'modified' | 'added' | 'deleted' | 'untracked';
```

- Staged: the `DiffChange → ChangeKind` projection maps `type-change` → `modified`
  and never inspects a `modify`'s `oldId`/`newId` (so a mode-only change is
  indistinguishable from a content change).
- Working tree: `compareWorkingTreeEntry` returns `'modified'` the instant the
  derived working mode differs, *without* hashing — so it cannot separate a
  type-change from a mode-only change from a content change either.

The prime directive favours byte-for-byte data faithfulness; the
"structured output, not cosmetics" rule ([ADR-249](249-describe-structured-data-only.md))
says the library carries the underlying fields and the caller renders. Under both
rules the coarsening is a gap: a consumer cannot reconstruct git's `T`, nor the
content-vs-mode distinction git's diff exposes.

Counter-force considered: git's XY renders mode-only as `M`, identical to a
content change — so a `mode-changed` kind is *finer* than porcelain v1 needs. The
choice is whether the structured surface should carry that finer, real
distinction or stop at porcelain-v1 fidelity (`T` vs `M`).

Options weighed:

- **A. Add `type-changed` + `mode-changed`.** Both columns carry the full
  distinction; `mode-changed` reconstructs to `M`, `type-changed` to `T`. Honors
  the backlog's literal "both" and the structured-output ethos.
- **B. Add `type-changed` only.** Faithful to porcelain v1 (`M` vs `T`), leaner
  surface, but drops the content-vs-mode distinction — mode-only stays `modified`.

## Decision

Adopt **A**. `ChangeKind` gains two values, applied symmetrically to both columns:

```ts
type ChangeKind =
  | 'modified' | 'added' | 'deleted' | 'untracked'
  | 'type-changed'   // git T  — kind change (file↔symlink↔gitlink)
  | 'mode-changed';  // git M  — same blob, mode (exec bit) differs
```

- **Staged** (`toStagedChange`): `type-change → type-changed`; `modify` with
  `oldId === newId → mode-changed`; `modify` with `oldId !== newId → modified`.
- **Working tree** (`compareWorkingTreeEntry`): hash before deciding, so a same-
  kind entry resolves to `modified` (content differs), else `mode-changed` (mode
  differs, content identical), else `unchanged`; a kind mismatch is `type-changed`
  (no hash). Content-change dominates mode-change, matching git's `M` when both
  differ — `mode-changed` is emitted only when the blob hash is identical.

The dirty-valve consumers (`rm`, `apply-merge-to-worktree`) widen from
`=== 'modified'` to a shared `isWorkingTreeModified` predicate (any
modified-variant), so a type/mode change is treated as a local modification git
refuses to clobber — fixing a latent gap, not just preserving behaviour.

Faithfulness pinning: the `status-interop` reconstruction maps `type-changed → T`
and `mode-changed → M`; the prior ADR-254 carve-out (type-change excluded from XY
reconstruction, pinned by a unit test instead) is removed — the staged + worktree
type-change and mode-change cases are now full byte-equal interop cases (the
mode-change case under `core.fileMode = true`, matching tsgit's unconditional mode
derivation).

## Consequences

### Positive

- `status`'s structured output reconstructs git porcelain `T` and the
  content-vs-mode distinction across both columns — the ADR-254 gap is closed.
- One shared `isWorkingTreeModified` predicate; the local-modification valve now
  refuses to clobber type/mode changes (previously it under-detected them).
- Symmetric vocabulary — both columns share one enriched `ChangeKind`.

### Negative

- `mode-changed` is finer than git porcelain v1 (which renders it `M`, like a
  content change). Callers reconstructing v1 must map `mode-changed → M`
  themselves — but that *is* the structured-output contract (the library emits
  data, not the letter).
- `compareWorkingTreeEntry` now hashes a same-kind mode-mismatch entry it
  previously short-circuited on the mode check — a small extra read for the
  (rare) exec-bit-only case, to distinguish mode-only from content+mode.

### Neutral

- No exhaustive `ChangeKind` switch exists in the codebase, so adding values is
  non-breaking for internal consumers; `describe`'s `kind !== 'untracked'` dirty
  test already subsumes the new values.
- The lossless distinction was always available through the `diff` surface; this
  brings the `status` summary up to the same fidelity.
