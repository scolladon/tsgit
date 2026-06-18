# ADR-358: Codebase-wide consolidation of the two path-join families

## Status

Accepted

- **Date:** 2026-06-17
- **Design:** [design/unify-sparse-checkout-joinpath.md](../design/unify-sparse-checkout-joinpath.md) (§ Scope expansion)
- **Extends:** [ADR-357](357-dedicated-working-tree-join-module.md)

## Context

ADR-357 unified the working-tree-write join ("family A": `workDir` + relative →
absolute disk path) for the four sites the 24.9u sweep reached, into the collapsing
`joinPath` in `primitives/internal/join-working-tree-path.ts`. A subsequent exhaustive
sweep (`grep 'layout.workDir}/' src`) revealed family A is **not** four sites but **~26
logical sites across 16 files** — the named twins `repoPath`/`workPath`, ~18 inline
`${ctx.layout.workDir}/${path}` FS-path constructions (status/blame/stash/add/submodule/
snapshot/find-would-overwrite/compare-working-tree-entry/walk-working-tree), and a
handful of variants (the empty-guarded `directoryPath`, `run-hook`'s `hooksPath` join,
the conditional `read-gitignore`/`read-gitattributes` paths, and `submodule-context`'s
child-`workDir` construction). Separately, a second join family ("family B":
repo-relative `prefix` + `leaf` → repo-relative path) has three copies
(`walk-submodules`/`walk-working-tree`/`mv`), each a local `joinPath` with an
empty-prefix guard (`mv`'s omitted, but its `dir` is provably never empty).

Folding only the originally-spotted `repoPath` would have been an incoherent cherry-pick
(its identical twin `workPath` and ~20 inline siblings would remain). The user, given the
full ~26-site inventory, chose the **complete sweep in this PR** rather than deferring it
to a separate item — closing the "exactly ONE join per family" north star outright.

## Options considered

1. **Family B only; defer family A to its own item** — smallest, keeps 24.9u tiny; cons:
   leaves ~26 family-A copies and the north star open.
2. **Fold the named family-A twins (`repoPath`/`workPath`) + family B; inline sites as a
   follow-up** — coherent middle; cons: ~20 inline sites remain, north star still open.
3. **(chosen) Full family-A sweep (all ~26 sites) + family B, in this PR** — closes both
   north stars; cons: large (16 files), variant sites need bespoke harmlessness, and the
   landed `joinPath` signature must widen. Mitigated by behaviour-preservation + the
   existing suites + a feature-scoped review pass + scoped mutation per slice.

## Decision

Consolidate **both** join families codebase-wide in this change:

- **Family A** — every workDir-onto-relative join routes through the one collapsing
  `joinPath` (`primitives/internal/join-working-tree-path.ts`). Its signature **widens**
  from `(workDir: string, path: FilePath)` to `(workDir: string, path: string)` (return
  unchanged `string`) so all sites — `FilePath`s, filenames, `hooksPath`, `GITMODULES_FILE`,
  constructed suffixes — pass without a cast; the widening is strictly more permissive, so
  the three already-landed callers (which pass `FilePath ⊂ string`) are unaffected. The
  named twins `repoPath`/`workPath` become **thin wrappers** that delegate to `joinPath`
  (call sites unchanged, the `ctx`→`workDir` projection sugar retained) — D-TWINS resolved
  to the wrapper form for both, for consistency. Variant sites keep their own guards but
  route their join *logic* through `joinPath`: `directoryPath` folds **only its non-empty
  branch** (`prefix === '' ? workDir : joinPath(workDir, prefix)`); the conditional
  `read-gitignore`/`read-gitattributes` paths become
  `joinPath(workDir, dir === '' ? '.gitX' : `${dir}/.gitX`)`. `submodule-context`'s
  child-`workDir` construction routes through `joinPath` (byte-identical; flagged for the
  reviewer as a layout-field construction, not an FS access).

- **Family B** — the three path-segment joins unify into one shared
  **`joinPathSegment`** (`primitives/internal/join-path-segment.ts`,
  `(prefix: string, leaf: string): string => prefix === '' ? leaf : `${prefix}/${leaf}``).
  It is **deliberately named distinctly** from family A's `joinPath` so the two genuinely
  different joins are never conflated. `mv`'s fold is behaviour-preserving because its
  `dir` (`destDir`) is provably never empty (`validateWorkingTreePath` rejects `''` and
  leading-`/`), so the guard's empty-branch is unreachable for `mv`.

The change is behaviour-preserving for every site (no SHA / ref / reflog / state-file /
refusal / structured-output / working-tree-path change; pinned by the existing suites and
per-slice scoped mutation). No public surface, option, or `api.json` change (ADR-249/226
unaffected).

**Suppression discipline:** `read-gitignore.ts:19` carries a pre-existing
`// Stryker disable next-line ConditionalExpression,StringLiteral`. The rewrite must NOT
blindly preserve it: re-validate in the scoped mutation run and keep only the minimal
provably-equivalent token (the `ConditionalExpression` half stays equivalent via `//`
normalisation; the `StringLiteral` half is killable after the rewrite and its token is
dropped). `read-gitattributes` carries no disable today and the rewrite must add none. No
new suppression directive is introduced anywhere.

## Consequences

### Positive

- Exactly one definition per join family (`joinPath` for workDir→absolute,
  `joinPathSegment` for prefix+leaf), each distinctly named — the duplication that
  motivated 24.9u/ADR-357 is closed codebase-wide, and a future call site has one obvious,
  unambiguous helper to import.
- The pre-existing `read-gitignore` mutation suppression **narrows** (a net reduction in
  suppressed surface), rather than propagating.

### Negative

- Large blast radius (16 files across many commands/primitives). Mitigated by strict
  behaviour-preservation, the existing suites as the regression authority, a feature-scoped
  review pass over the sweep diff, and per-slice scoped mutation (0 survivors).
- The widened `joinPath` signature accepts any `string` second argument, losing the
  `FilePath` brand as a call-site hint. Accepted: the join is pure concatenation; the
  brand never constrained its behaviour, and the breadth of legitimate second arguments
  (filenames, config-dir paths, constructed suffixes) makes `string` the honest type.

### Neutral

- All sites are internal; no public surface / command / refusal / reflog / structured
  output change (ADR-249 unaffected).
- `moveNode`'s absolute-fragment join (`working-tree.ts:130`) and any non-workDir join are
  out of scope — neither family.
