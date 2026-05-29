# Multi-base `mergeBase` — `--all` and `--octopus`

## Goal

Extend the merge-base primitive beyond "one best common ancestor of two commits" to cover the two multi-base modes Git exposes:

- **`--all`** — return *every* best common ancestor of two commits (the full set of lowest common ancestors, LCAs). In criss-cross histories there can be more than one.
- **`--octopus`** — compute the merge base(s) of *N* commits for an octopus merge, via Git's iterative pairwise fold.

Both unlock later phases: `--all` is what a future `recursive` merge strategy consumes (a virtual base built from multiple LCAs); `--octopus` underpins n-way merges.

## Current state

`src/application/primitives/merge-base.ts` exposes:

```ts
mergeBase(ctx: Context, a: ObjectId, b: ObjectId): Promise<ObjectId | undefined>
```

It runs a bidirectional layered BFS over commit parents and returns the lexicographically smallest oid of the *first* layer where the two visited sets intersect, or `undefined` for unrelated histories.

Two known limitations of that approach:

1. **First-intersection ≠ best base.** In a criss-cross merge the first layer to intersect can surface a common ancestor that is itself an *ancestor* of a deeper, better base — i.e. a non-optimal (redundant) base. The current docstring acknowledges this ("criss-cross merges may yield non-optimal bases").
2. **Single result only.** It cannot return the multiple LCAs a recursive merge needs.

This phase fixes (1) for the two-commit case and adds the multi-result/n-commit surface.

## Git semantics (the contract we replicate)

Git defines a *merge base* of commits as a best common ancestor: a common ancestor that is **not reachable from any other common ancestor**. The set of best common ancestors is the set of LCAs under the reachability partial order.

- `git merge-base A B` → one best common ancestor (Git's choice among ties is date-driven; we pick the lexicographically smallest oid — see ADR on tie-breaking). Exit 1 / no output when unrelated.
- `git merge-base --all A B` → all best common ancestors.
- `git merge-base --octopus C1 C2 … Cn` → fold: start with `{C1}`; for each subsequent `Ci`, replace the accumulator with the union of `merge-base --all (Ci, r)` over every `r` in the accumulator; finally remove redundant entries. Print the first (or all, with `--all`). Empty when the commits share no common ancestor.

`--independent`, `--is-ancestor`, and `--fork-point` are **out of scope** (not in the backlog item).

### Worked criss-cross example (why `--all` matters)

```
      A
     / \
    B   C
    |\ /|
    | X |
    |/ \|
    D   E
```

`D` has parents `{B, C}`; `E` has parents `{C, B}`. Common ancestors of `D` and `E` are `{B, C, A}`. `A` is reachable from both `B` and `C`, so `A` is redundant. The best common ancestors are **`{B, C}`** — two LCAs. `git merge-base --all D E` prints both; plain `git merge-base D E` prints one.

## Algorithm

We compute *all* best common ancestors with a two-step, reachability-based method:

1. **Collect common ancestors.** For the two-commit case, `commonAncestors = ancestors(a) ∩ ancestors(b)`, where `ancestors(x)` is the set of commits reachable from `x` including `x` itself (walk parents, skip non-commits, dedupe via a visited `Set`).
2. **Remove redundant.** A common ancestor `x` is redundant when some *other* common ancestor `y` reaches `x` (i.e. `x ∈ ancestors(y)`). The survivors — the maximal elements under reachability — are the merge bases.

`remove-redundant` operates on the deduped common-ancestor set and is implemented by walking each common ancestor's **parent chain** (strict ancestors — the start commit itself is never marked) and marking every *other* common ancestor it reaches as redundant; the unmarked commons are returned, sorted lexicographically for deterministic output.

The `a === b` fast-path in the legacy `mergeBase` becomes unnecessary: `mergeBases(a, a)` intersects `ancestors(a)` with itself, and `removeRedundant` keeps only `a` (every other ancestor is reachable from `a`'s parent chain). The self-base result falls out of the reduce, so the explicit shortcut is dropped.

This is **results-faithful** to Git (same set of best common ancestors) while diverging from Git's internal *mechanism* (Git uses a commit-date priority queue with `STALE` flag propagation for early termination). The divergence and its performance consequence are captured in an ADR. Rationale for the simpler mechanism: tsgit has no commit-date priority-queue infrastructure today, the existing `mergeBase` already walks ancestry without dates, and full-reachability + reduce is far easier to drive to 100% coverage and zero surviving mutants.

### Octopus fold

```
octopusMergeBases(commits):
  acc = [commits[0]]
  for c in commits[1..]:
    acc = flatten( allMergeBases(c, r) for r in acc )
  return removeRedundant(acc)          // dedupe + drop ancestors-of-others
```

Matches Git's `get_octopus_merge_bases` followed by `reduce_heads`. Folding pairwise `allMergeBases` keeps a single core routine.

## API surface

> The exact shape is the load-bearing decision of this phase and is settled by ADR before implementation. The design records the **recommended** shape; if the user's ADR choice differs, this section is revised to match before planning.

**Recommended (Option A):** keep the existing entry point, add two siblings.

```ts
// unchanged — single best base of two commits (now computed via the
// reduce algorithm, so it is correct in criss-cross cases too)
mergeBase(ctx: Context, a: ObjectId, b: ObjectId): Promise<ObjectId | undefined>

// all best common ancestors of two commits (`--all`)
mergeBases(ctx: Context, a: ObjectId, b: ObjectId): Promise<readonly ObjectId[]>

// octopus base(s) of N commits (`--octopus`), all reduced bases
octopusMergeBases(ctx: Context, commits: readonly ObjectId[]): Promise<readonly ObjectId[]>
```

- `mergeBase` is refactored to delegate to the shared core: `mergeBases(a,b)` then lexicographically-smallest or `undefined`. This *fixes* its criss-cross non-optimality as a side effect; existing linear/diamond tests (single LCA) are unaffected.
- `mergeBases` returns `[]` for unrelated histories.
- `octopusMergeBases([])` is rejected with `invalidWalkInput` (Git errors on no commits). `octopusMergeBases([c])` returns `[c]` (octopus of a single commit is itself). `octopusMergeBases([a,b])` equals `mergeBases(a,b)`.
- Callers wanting Git's "octopus prints first" take `result[0]`.

Return type is `readonly ObjectId[]` (immutable), sorted lexicographically for determinism.

### `repository.ts` binding

Bind the two new primitives under `repo.primitives.*` alongside the existing `mergeBase`, following the established `BindCtx<typeof primitives.X>` + `guard()` pattern:

```ts
readonly mergeBases: BindCtx<typeof primitives.mergeBases>;
readonly octopusMergeBases: BindCtx<typeof primitives.octopusMergeBases>;
```

Export both from `src/application/primitives/index.ts`.

## Module structure

Single file `src/application/primitives/merge-base.ts` grows three internal helpers and two new exports:

- `collectAncestors(ctx, root): Promise<Set<ObjectId>>` — reachable-set walk (extracted; reused by the existing frontier logic and the new reduce).
- `removeRedundant(ctx, commits): Promise<readonly ObjectId[]>` — drop commits reachable from another in the set; operates over a `Set` so it also collapses duplicate oids accumulated across octopus fold steps.
- `allMergeBases(ctx, a, b): Promise<readonly ObjectId[]>` — intersect ancestor sets, then `removeRedundant`. Backing routine for both public exports.
- Public `mergeBase` (delegates), `mergeBases` (= `allMergeBases`), `octopusMergeBases` (fold + reduce).

Each function stays under the 20-line ceiling; deep nesting avoided via early returns and `Set`/array helpers.

## Testing strategy

### Example unit tests (`merge-base.test.ts`, extended)

Reuse the existing `buildLinear` / `buildDiamond` / `commitWith` fixtures. New cases:

- **`mergeBases` — linear**: `mergeBases(C, A)` → `[A]` (single LCA still a one-element array).
- **`mergeBases` — diamond**: `mergeBases(B, C)` → `[A]`.
- **`mergeBases` — criss-cross**: build the D/E figure above → `[B, C]` sorted; assert both present and `A` absent (kills the "forgot to remove redundant" mutant and the "returns only one" mutant).
- **`mergeBases` — unrelated**: → `[]`.
- **`mergeBase` still correct**: re-assert the existing single-base cases now route through the new core (no behavior change on linear/diamond); add a criss-cross case proving `mergeBase` returns a best base (one of `{B,C}`, the lex-min), not the redundant `A`.
- **`octopusMergeBases` — three linear branches** off a shared root → the shared base.
- **`octopusMergeBases` — single commit** `[c]` → `[c]`.
- **`octopusMergeBases` — empty** `[]` → throws `invalidWalkInput`, asserting `.data.code === 'INVALID_WALK_INPUT'` and the `reason` string (specific assertion per mutation-resistance rules).
- **`octopusMergeBases` — unrelated** → `[]`.
- **`octopusMergeBases` reduces** — three commits whose pairwise bases include a redundant ancestor; assert the redundant one is dropped.

Error assertions use try/catch + direct `.data` inspection (not bare `toThrow(Class)`), per the mutation-resistant patterns in `CLAUDE.md`. Guard clauses (empty-input, non-commit skip) get isolated tests.

### Property-based tests (`merge-base.properties.test.ts`)

merge-base is a **compositional aggregator over a DAG** — lens 2 ("compositional matcher/aggregator") and lens 3 ("total function over a grammar") of the property-testing checklist apply. Properties over arbitrary small random DAGs (generated via a `fast-check` arbitrary that emits a topologically-ordered list of commits with random in-DAG parents):

1. **Symmetry**: `mergeBases(a, b)` as a set equals `mergeBases(b, a)`.
2. **Self**: `mergeBases(a, a)` = `[a]`.
3. **Common-ancestor soundness**: every returned base is an ancestor of both inputs.
4. **Maximality (no redundancy)**: no returned base is an ancestor of another returned base.
5. **Completeness vs. brute force**: the result set equals an independent O(V²) oracle (all-common-ancestors minus any reachable-from-another) — the oracle is structurally different from the production walk (it materializes full ancestor sets per node up-front), so it is not a tautology.
6. **Octopus reduces to pairwise**: `octopusMergeBases([a, b])` as a set equals `mergeBases(a, b)`.
7. **Octopus membership**: every octopus base is a common ancestor of *all* inputs.

`numRuns`: 100 (composition/invariant tier) for 1–5; 50 for the filter-heavy octopus properties 6–7. Per-family DAG arbitrary lives in `arbitraries.ts` in the same directory. No committed seed.

The example tests stay (they pin literal small topologies and the error contract); the properties prove the grammar-level invariants the examples can't enumerate.

### Coverage & mutation

- 100% line/branch/function/statement.
- Target 0 surviving mutants. Anticipated equivalent-mutant risk: loop bounds in the ancestor walk where out-of-range yields `undefined` — documented inline only if proven equivalent.

## Key design decisions (→ ADRs)

1. **API surface shape** — Option A (two new fns + unchanged `mergeBase`) vs. Option B (one array fn with an `octopus` option) vs. Option C (breaking: single `mergeBase(commits, opts)` returning an array). *Recommendation: A.*
2. **Algorithm mechanism** — full-reachability + remove-redundant (simple, no early termination) vs. Git's date-ordered paint-down-to-common (faithful mechanism, early termination, materially more code). *Recommendation: full-reachability + remove-redundant; results stay Git-faithful.*
3. **Refactor `mergeBase` to delegate** — yes (fixes criss-cross non-optimality, DRY) vs. leave the legacy BFS in place for its early-termination fast path. *Recommendation: delegate.*

Tie-breaking (lex-min for the singular `mergeBase`) inherits the existing decision and is not re-litigated.

## Alternatives considered

- **Date-ordered priority queue (Git's real mechanism).** Rejected for now: no PQ/date infra, much harder to reach zero mutants on the date/STALE logic. Captured as an ADR alternative; can be revisited under the v2 perf phase if merge-base shows up in profiles.
- **`get_merge_bases_many` (asymmetric one-vs-rest) for non-octopus N>2.** Rejected: surprising semantics, not requested by the backlog. The two useful operations are two-commit `--all` and octopus.
