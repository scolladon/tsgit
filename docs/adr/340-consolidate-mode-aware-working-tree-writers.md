# ADR-340: Consolidate the mode-aware working-tree writers into one shared helper

## Status

Accepted

- **Date:** 2026-06-15
- **Design:** [design/checkout-replace-symlink-with-file.md](../design/checkout-replace-symlink-with-file.md)

## Context

Backlog 24.9p is a scoped bug: `checkout` cannot replace an occupying symlink with a
regular file. `apply-changeset.ts`'s `writeFileEntry` writes the regular payload without
unlinking first, so the node adapter's `'creation'` containment throws `PERMISSION_DENIED`
when a symlink squats the path (the design pins this against git 2.54.0).

The minimal fix is one statement. But the design's writer survey (design §"Sibling
writers") found the bug is one instance of a duplicated pattern — there are **four**
near-identical working-tree writers, each handling the symlink-squat differently:

| Writer | File | Symlink branch rms? | Regular branch rms? |
|---|---|---|---|
| `writeFileEntry` | `apply-changeset.ts` | yes | **no — this bug** |
| `writeWorkingTreeEntry` | `internal/write-working-tree-file.ts` | yes | **no — twin latent gap** |
| `writeWorkingTreeFile` (merge-local) | `merge.ts` | n/a (regular-only) | yes |
| `writeWorkingTreeFile` (primitive) | `internal/write-working-tree-file.ts` | n/a (regular-only) | **no** |

`writeWorkingTreeEntry` carries the identical latent gap in its regular branch, and
`merge.ts` keeps a private copy of the same regular writer the primitive layer already
exposes. The duplication is the root cause: the fix had to be re-derived per writer, and
two writers still carry the unpinned gap.

The design posed the scope as a load-bearing decision candidate (local fix vs. fix the
twin vs. consolidate now), recommending the local fix and deferring consolidation to the
refactor phase. The user chose to consolidate now.

## Options considered

1. **Local fix to `writeFileEntry` only** *(design recommendation)* — add `rmIfExists`
   to the one writer with a verified reproduction; pin; note the twin gap for the
   refactor phase. Minimal and fully pinned; cons: leaves the duplication and the twin
   gap in place.
2. **Local fix + fix `writeWorkingTreeEntry`'s twin gap** — fixes both gap-bearing
   writers; cons: the twin has no failing test (an unpinned change) and the duplication
   itself survives.
3. **(chosen) Consolidate all four writers into one shared mode-aware helper now** —
   collapse the duplication into a single working-tree writer that all consumers
   (`checkout`/`apply-changeset`, `merge`, `apply-merge-to-worktree`, `stash`) call; the
   24.9p bug and the twin gap both vanish as a property of the one helper. Cons: a
   structural change wider than the bug, touching merge-side consumers — must be
   behaviour-preserving and is covered by the review phase's feature-scoped pass.

## Decision

Consolidate the duplicated mode-aware working-tree writers into a **single shared
helper** as part of 24.9p. The shared helper is the one place that decides
symlink/gitlink/regular handling and the unlink-before-write rule; every working-tree
write site delegates to it. `writeFileEntry`, `writeWorkingTreeEntry`, and the two
`writeWorkingTreeFile` copies collapse into (or delegate to) this helper. The 24.9p
symlink→file checkout bug and the `writeWorkingTreeEntry` twin gap are both fixed as a
consequence — there is no longer a per-writer regular-branch to forget. The precise
shape (helper location, signature, which call sites delegate vs. fold) is worked out in
the revised design; this ADR fixes only that consolidation happens now, in this change,
rather than deferring to the refactor phase. The consolidation is behaviour-preserving
for every existing consumer except the 24.9p path it fixes, and is pinned by the new
checkout interop matrix plus the existing merge/stash interop suites.

## Consequences

### Positive

- One writer, one unlink-before-write rule: the 24.9p bug class cannot recur in a new
  call site, and the `writeWorkingTreeEntry` twin gap is closed without a separate change.
- `merge.ts` stops carrying a private copy of a primitive-layer writer; the duplication
  the design surfaced is removed (DRY).

### Negative

- Wider blast radius than the one-line bug fix: merge-side and stash consumers change
  their call to the shared helper. Mitigated by behaviour-preservation + the existing
  interop suites and a feature-scoped review pass over the consolidation diff.

### Neutral

- The consolidation overlaps work the engine's dedicated refactor phase would otherwise
  do; folding it into the implementation here means the refactor phase re-reviews the
  consolidated shape rather than performing it.
- No public surface change — all four writers are internal; `repository`/command surfaces
  are untouched (ADR-249 unaffected).
