# ADR-347: Valueless `merge.<driver>.driver`/`name` — guard lazily at the content-merge-table load

## Status

Accepted — **amended** by the M4 re-pin during the design revision (see Decision / Amendment). The original placement (`namedChoice`, attribute-gated) was superseded before any code landed.

## Context

Pinned M1/M2 (git 2.54.0): when a `.gitattributes` rule resolves `merge=<driver>` and the `[merge "<driver>"]` section has a valueless `driver` (or `name`), git dies `missing value for 'merge.<driver>.driver'` at the merge — exit 128. Pinned M3: this is **lazy** — git does not die in `git_default_config`; the read happens only when a real 3-way content merge runs (not on `status`/`log`/`add`/`diff`, nor on a fast-forward / no-content-merge merge). tsgit's `resolve-merge-driver.ts` `namedChoice` currently reads the driver and, when `driver` is `undefined`, returns the built-in `text` 3-way merge — a benign fallback, no refusal.

The design recommended deferring (the guard converts a harmless fallback into a hard refusal). The user chose to guard now.

**Amendment trigger (M4, re-pinned during the design revision):** git dies on a valueless `merge.*.driver`/`name` during **any** real 3-way content merge of a path — even when (a) **no** `.gitattributes` references the named driver, and (b) the merge **auto-resolves** with no conflict. git loads the **whole `[merge *]` table** at content-merge time and dies on the first valueless `driver`/`name` by file line, independent of attribute resolution. `merge-tree --write-tree` (no worktree) dies identically. M4b is the control (remove the valueless driver → normal conflict, exit 1). The original `namedChoice` placement is attribute-gated, so it would miss every M4 case — unfaithful to the faithful-maximal scope this guard is accepted under.

## Decision

Guard at the **content-merge-table load** in `buildContentMerger` (the shared point where every 3-way consumer materialises the driver table for a merge), **once-lazily** the first time any path enters 3-way content merge: scan **all** `[merge *]` subsections and refuse on the first valueless `driver`/`name` by config-file line via the subsection-wildcard scan (`assertNoValuelessInSection`, the new primitive shared with the `branch` eager guard). This reproduces M1/M2/M4 exactly — the trigger is "a path enters content merge", not "an attribute resolves a named driver" and not "a conflict occurs".

It stays **lazy** (M3): no die on `status`/`log`/`add`/`diff`, nor on a fast-forward or a merge where no path is content-merged. A `[merge "x"]` that is never reached because no content merge runs stays inert.

Both `driver` and `name` are in the key set (M2 pins git dying on a valueless `name` too); file-line order decides which is reported (`findFirstValuelessInSection`'s wildcard scan, first-by-line).

### Amendment note

The original Decision named `namedChoice` (attribute-gated, resolved-subsection). M4 (not in the matrix when ADR-347 was first accepted) proves that placement unfaithful; the user confirmed amending to the content-merge-table load. No code shipped under the original placement, so this is a pure design-phase correction, not a behaviour change to ship.

## Consequences

### Positive

- Faithful to git's die at content-merge time (M1/M2/M4), reusing the subsection-wildcard scan + `CONFIG_MISSING_VALUE` error — one additive call at the shared table load.
- Stays lazy (M3): clean/fast-forward/no-content-merge merges and every non-merge command are untouched; only a real 3-way content merge with a valueless `[merge *]` key refuses.

### Negative

- Converts tsgit's previously-benign "valueless driver → built-in text" fallback into a refusal — a behaviour change for repos that (mis)configured a valueless `[merge *]` driver/name and relied on the silent fallback. Blast radius is every 3-way content merge (not only attribute-resolved paths, per M4), accepted under ADR-346's faithful-maximal scope.

### Neutral

- Every 3-way consumer (merge/cherry-pick/revert/rebase/stash) inherits the guard for free via the shared `buildContentMerger` table load; the interop matrix pins `merge` (conflicting AND auto-resolving, with and without an attribute), with the others covered by the shared code path.
- Shares the new subsection-wildcard scan primitive with the `branch` eager guard (ADR-349) — same "any subsection, first valueless by line" need, different call site + key set.
