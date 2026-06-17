# ADR-357: A dedicated module owns the one working-tree-write `joinPath`

## Status

Accepted

- **Date:** 2026-06-17
- **Design:** [design/unify-sparse-checkout-joinpath.md](../design/unify-sparse-checkout-joinpath.md)

## Context

Backlog 24.9u closes the "exactly ONE working-tree-write `joinPath`" north star that
ADR-340 opened. After ADR-340 consolidated the working-tree writers, one shared
trailing-slash-**collapsing** `joinPath` lives in
`primitives/internal/write-working-tree-file.ts:35` and is imported cross-file by the
sibling primitive `apply-changeset.ts`. Two copies of the same workdir-onto-relative
join still bypass it:

| Copy | Site | Collapses trailing slash? |
|---|---|---|
| sparse | `commands/internal/apply-sparse-checkout.ts:59` | **no** — deliberate doubled-`//` tolerance |
| inline | `primitives/internal/write-working-tree-file.ts:96` (`removeWorkingTreeFile`) | **no** — bypasses the helper in its own file |

The design proved the collapse difference is **harmless** (the precondition the backlog
mandated): the sparse `joinPath` output feeds only `ctx.fs.exists` / `isWorkingTreeDirty`
(pure FS probes), never the `SparseMatcher` (which matches the index-relative
`entry.path`), so pathspec matching is structurally decoupled from the join; and both
adapters normalise `//`→`/` (memory `normalizePath` skips empty segments; node routes
through `node:path`). The only diverging input — a `workDir` ending in `/` — is
unreachable from production adapters. So routing both copies through the collapsing
helper is observationally byte-identical. Harmlessness being proven, keeping either copy
is no longer load-bearing.

Two load-bearing choices remained for the user (design Decision candidates):

- **D1 — where the single `joinPath` lives.** The shared helper currently sits inside
  `write-working-tree-file.ts`; a path util imported from a file named after file-writing
  reads awkward once a *second* unrelated command (`apply-sparse-checkout`) depends on it.
- **D2 — whether to also fold the inline 4th copy** in `removeWorkingTreeFile` (same file
  as the canonical helper) in this change.

## Options considered

**D1 — home of the unified `joinPath`:**

1. **Import the existing shared `joinPath` from `write-working-tree-file.ts` as-is**
   *(design recommendation)* — minimal diff (`−1` helper, `+1` import), follows the
   precedent `apply-changeset.ts` already set. Cons: cements a generic path util as a
   member of a file named for working-tree *writing*; a third importer deepens the
   misnomer.
2. **(chosen) Extract `joinPath` into its own dedicated module**
   (`primitives/internal/join-working-tree-path.ts`) that every working-tree-write join
   site imports — `write-working-tree-file.ts`, `apply-changeset.ts`, and
   `apply-sparse-checkout.ts`. Cohesively correct single home; cons: churns the two
   existing importers' import lines for a naming improvement.
3. **No-op** — keep the sparse private copy. Ruled out: harmlessness is proven, so the
   divergence is not load-bearing, and the item exists to close the north star.

**D2 — the inline 4th copy in `removeWorkingTreeFile`:**

1. **(chosen) Fold it now** *(design recommendation)* — route `removeWorkingTreeFile`
   through the shared `joinPath` in the same change. One line, same file, already-covered
   call site, identical harmlessness proof (`removeWorkingTreeFile`'s path only reaches
   `rmIfExists` → `lstat`/`rm`).
2. **Record a follow-up** — leave it, track a dependency-ordered backlog entry.
3. **Leave it, no follow-up.**

## Decision

Establish **one dedicated module — `primitives/internal/join-working-tree-path.ts` — as
the single home of the working-tree-write `joinPath`** (D1 → option 2), and **route every
copy through it, including the inline 4th copy in `removeWorkingTreeFile`** (D2 → option
1). The collapsing helper definition moves out of `write-working-tree-file.ts` into the
new module; `write-working-tree-file.ts` (for `writeWorkingTreeFile` /
`writeWorkingTreeEntry` / `removeWorkingTreeFile`), `apply-changeset.ts`, and
`apply-sparse-checkout.ts` all import it from there. The sparse private copy and the
`removeWorkingTreeFile` inline are both deleted. After this change there is **exactly one**
`joinPath` for the workdir-onto-relative absolute-path join, with a single, self-naming
home.

The precise import wiring and slice order are worked out in the revised design; this ADR
fixes that the home is a dedicated module and that all four copies converge on it now. The
change is behaviour-preserving for every consumer (the harmlessness proof), pinned by the
existing sparse-checkout unit + interop suites and the merge/stash interop suites — no new
git behaviour, no public surface, no on-disk-state change (ADR-249/226 unaffected).

The three other `joinPath` definitions (`walk-submodules.ts`, `walk-working-tree.ts`,
`mv.ts`) are a **different** join (path-segment → repo-relative `FilePath`) and are
explicitly out of scope.

## Consequences

### Positive

- Exactly one `joinPath` for working-tree-write joins, in a module named for what it does
  — the north star ADR-340 opened is closed; a future call site has one obvious place to
  import from, with no misnomer.
- The canonical helper's own file no longer bypasses it (`removeWorkingTreeFile` folded),
  so the file is internally self-consistent.

### Negative

- Wider diff than importing as-is: a new file plus repointing two existing importers'
  import lines. Mitigated — pure import churn, no logic moves; the symbol and its
  behaviour are unchanged.

### Neutral

- All sites are `internal/`; no public surface, command, refusal, reflog, or structured
  output changes (ADR-249 unaffected).
- The deleted non-collapsing branches *reduce* the mutation surface; the surviving
  collapse branch stays covered by the existing trailing-slash unit test (sparse) and the
  helper's own slash/non-slash unit tests.
