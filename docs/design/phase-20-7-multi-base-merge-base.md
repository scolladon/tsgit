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

- `git merge-base A B` → one best common ancestor (Git's choice among ties is date-driven; we pick the lexicographically smallest oid for determinism, inheriting the prior implementation's tie-break). Exit 1 / no output when unrelated.
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

## Algorithm (per ADR-190)

We implement Git's **paint-down-to-common** mechanism faithfully — date-ordered priority queue, flag painting, `STALE` pruning, then `remove_redundant`.

### `paintDownToCommon(read, one, twos) → ObjectId[]`

- Flags live in a per-call `Map<ObjectId, number>` with bits `PARENT1=1`, `PARENT2=2`, `STALE=4`, `RESULT=8` — no global object-flag mutation, so each paint is isolated and needs no mark-clearing.
- A priority queue ordered by **committer timestamp descending** (newest first), oid ascending as a deterministic tie-break. Implemented as an insertion-sorted array (`pop` = shift front); a binary heap is a behaviour-preserving swap deferred to the v2 perf phase.
- Paint `one` with `PARENT1` and every `twos[i]` with `PARENT2`; enqueue all. With `twos` empty, return `[one]` immediately (single-commit base = itself).
- While the queue holds a **non-stale** commit: pop the newest; let `flags = its (PARENT1|PARENT2|STALE)`. If `flags === (PARENT1|PARENT2)` and not yet `RESULT`, record it as a result and OR `STALE` into `flags`. For each parent, if it does not already carry all bits in `flags`, OR them in and enqueue it.
- Return the recorded result oids (common ancestors; possibly still redundant in criss-cross).

### `removeRedundant(read, commits) → ObjectId[]`

Operates over the deduped set. For each candidate `i`, re-paint `i` as `PARENT1` and the remaining candidates as `PARENT2` down to common (a bounded paint): if candidate `i` ends up flagged `PARENT2` it is reachable from another and is redundant; any other candidate flagged `PARENT1` is reachable from `i` and is redundant. Survivors — the maximal elements under reachability — are returned, sorted lexicographically.

### `mergeBasesMany(read, one, twos) → ObjectId[]`

`paintDownToCommon`, then `removeRedundant` only when more than one result (matches Git's `get_merge_bases_many_0`). Handles both the two-commit case (`twos = [b]`) and the non-octopus n-commit case (`twos = commits[1..]`, all painted `PARENT2` together) — the latter falls out for free now that the faithful paint accepts a `twos` array.

### Octopus fold

```
octopusMergeBases(read, commits):
  acc = [commits[0]]
  for c in commits[1..]:
    acc = flatten( mergeBasesMany(read, c, [r]) for r in acc )
  return removeRedundant(read, acc)     // collapse dups + drop ancestors-of-others
```

Matches Git's `get_octopus_merge_bases` followed by `reduce_heads`. `removeRedundant` works over a `Set`, so duplicate oids accumulated across fold steps collapse.

### Commit reads

Reads are memoized in a per-invocation `Map<ObjectId, Commit | undefined>` (`undefined` = parsed-but-not-a-commit) so the repeated paints in `removeRedundant` and the octopus fold never re-read an object. Non-commit oids contribute no parents and are never enqueued past themselves.

The `a === b` self-base shortcut is dropped: `mergeBase([a, a])` reduces to `{a}` through the core, so the special case is redundant (ADR-191).

## API surface (per ADR-189)

A single, breaking, array-returning function whose two flags mirror the Git CLI:

```ts
mergeBase(
  ctx: Context,
  commits: readonly ObjectId[],
  options?: { readonly all?: boolean; readonly octopus?: boolean },
): Promise<readonly ObjectId[]>
```

Behaviour:

- Empty `commits` → throws `invalidWalkInput` (Git errors with no commits).
- `commits[0]` is `one`, `commits[1..]` the others.
- **Default** (`all` falsy, no octopus): `mergeBasesMany(one, rest)`, truncated to the lexicographically smallest single base — `[]` or `[base]`. Mirrors `git merge-base` printing the first.
- **`all: true`**: the full reduced LCA set, sorted lexicographically (`git merge-base --all`).
- **`octopus: true`**: iterative fold over all commits (`git merge-base --octopus`); `all` controls truncation as above.
- `mergeBase([a, a])` → `[a]`; `mergeBase([c])` → `[c]`; unrelated histories → `[]`.
- Return is always `readonly ObjectId[]`, sorted lexicographically for determinism.

The single consumer, `application/commands/merge.ts`, migrates to:

```ts
const [base] = await mergeBase(ctx, [ourId, theirId]); // base: ObjectId | undefined
```

`base` stays `ObjectId | undefined`, so the downstream `=== ourId` / `=== theirId` branches are untouched.

### `repository.ts` binding

The existing `repo.primitives.mergeBase` binding is rewritten to the new signature (same `BindCtx<typeof primitives.mergeBase>` + `guard()` pattern); no new entries are added to the primitives surface.

```ts
mergeBase: ((commits, options) => {
  guard();
  return primitives.mergeBase(ctx, commits, options);
}) as Repository['primitives']['mergeBase'],
```

## Module structure

Single file `src/application/primitives/merge-base.ts`, fully rewritten around the faithful core:

- Flag constants `PARENT1 / PARENT2 / STALE / RESULT`.
- `readCommit(ctx, cache, id): Promise<Commit | undefined>` — memoized read; `undefined` for non-commits.
- An insertion-sorted priority queue (date-desc, oid-asc tie-break) — small local helper, not exported.
- `paintDownToCommon(read, one, twos): Promise<ObjectId[]>`.
- `removeRedundant(read, commits): Promise<readonly ObjectId[]>`.
- `mergeBasesMany(read, one, twos): Promise<readonly ObjectId[]>` — paint + conditional reduce.
- `octopusMergeBases(read, commits): Promise<readonly ObjectId[]>` — fold + reduce.
- Public `mergeBase` — validate, build the read cache, dispatch octopus vs many, sort, truncate per `all`.

The legacy `advanceFrontier` / `intersection` helpers and the `a === b` shortcut are deleted (ADR-191). Each function stays under the 20-line ceiling via early returns and array/`Set`/`Map` helpers.

## Testing strategy

### Example unit tests (`merge-base.test.ts`, extended)

Reuse the existing `buildLinear` / `buildDiamond` / `commitWith` fixtures; add a `buildCrissCross` fixture for the D/E figure. All cases call the unified `mergeBase(ctx, commits, opts?)`. Existing single-base cases are rewritten from `mergeBase(ctx, a, b)` to `mergeBase(ctx, [a, b])` asserting a one-element array.

- **default — self**: `mergeBase([a, a])` → `[a]`.
- **default — single commit**: `mergeBase([c])` → `[c]`.
- **default — linear**: `mergeBase([C, A])` → `[A]`; `mergeBase([D, B])` → `[B]`.
- **default — diamond**: `mergeBase([B, C])` → `[A]`.
- **default — child-after-parent self-base**: the existing lex-smaller-parent case → `[child]`, not `[parent]` (proves the reduce keeps the maximal element).
- **default — criss-cross truncates**: `mergeBase([D, E])` → `[min(B, C)]` (single, lex-min — proves default truncation past the redundant `A`).
- **`all: true` — criss-cross**: `mergeBase([D, E], { all: true })` → `[B, C]` sorted; assert both present and `A` absent (kills "forgot remove-redundant" and "returns only one").
- **`all: true` — linear**: `mergeBase([C, A], { all: true })` → `[A]`.
- **unrelated**: `mergeBase([x, y])` → `[]`; same with `{ all: true }` → `[]` (both-frontiers-stale exit).
- **empty input**: `mergeBase([])` → throws; try/catch asserting `.data.code === 'INVALID_WALK_INPUT'` and the `reason` string.
- **non-commit oid**: an input oid pointing at a blob contributes no parents → no spurious base.
- **octopus — three branches** off a shared root: `mergeBase([a, b, c], { octopus: true })` → `[root]`.
- **octopus — single / two**: `mergeBase([c], { octopus: true })` → `[c]`; `mergeBase([a, b], { octopus: true })` equals the two-commit default-`all` set.
- **octopus — `all` truncation**: octopus over commits with >1 base → default returns lex-min single, `{ all: true }` returns all.
- **octopus — unrelated**: → `[]`.
- **STALE-pruning isolation**: a topology where a deeper common ancestor must be pruned via `STALE` (e.g. base + its parent both common) → only the lower base returned, proving the `STALE`-propagation guard.
- **date-ordering isolation**: two candidate bases with distinct committer timestamps where pop-order matters for early termination — asserts the same result regardless, and that the queue exits via `queue_has_nonstale`.

Error assertions use try/catch + direct `.data` inspection (not bare `toThrow(Class)`). Guard clauses (empty-input, non-commit skip, `STALE` propagation, the `(flags & f) === f` parent skip, the `RESULT`-already-set skip) each get an isolated test so no single guard's mutant survives.

### Property-based tests (`merge-base.properties.test.ts`)

merge-base is a **compositional aggregator over a DAG** — lens 2 ("compositional matcher/aggregator") and lens 3 ("total function over a grammar") of the property-testing checklist apply. Properties run against arbitrary small random DAGs (a `fast-check` arbitrary emits a topologically-ordered list of commits with random in-DAG parents and assorted committer timestamps). All use the `{ all: true }` set form unless noted:

1. **Symmetry**: `mergeBase([a, b], { all: true })` as a set equals `mergeBase([b, a], { all: true })`.
2. **Self**: `mergeBase([a, a], { all: true })` = `[a]`.
3. **Common-ancestor soundness**: every returned base is an ancestor of both inputs.
4. **Maximality (no redundancy)**: no returned base is an ancestor of another returned base.
5. **Completeness vs. independent oracle**: the result set equals a brute-force oracle that materializes the full transitive-closure ancestor matrix per node and selects the maximal common elements. The oracle's mechanism (precomputed closure matrix) is structurally distinct from the production date-PQ paint, so it is not a tautology; properties 1–4 are pure invariants and carry the load if 5 is ever weakened.
6. **Octopus reduces to pairwise**: `mergeBase([a, b], { octopus: true, all: true })` as a set equals `mergeBase([a, b], { all: true })`.
7. **Octopus membership**: every octopus base is a common ancestor of *all* inputs.
8. **Date-order invariance**: shuffling input committer timestamps (re-minting commits with permuted dates but identical topology) leaves the result set unchanged — proves the PQ ordering is a performance device, not a correctness dependency.

`numRuns`: 100 (composition/invariant tier) for 1–5, 8; 50 for the filter-heavy octopus properties 6–7. Per-family DAG arbitrary lives in `arbitraries.ts` in the same directory. No committed seed.

The example tests stay (they pin literal small topologies and the error contract); the properties prove the grammar-level invariants the examples can't enumerate.

### Coverage & mutation

- 100% line/branch/function/statement.
- Target 0 surviving mutants. Anticipated equivalent-mutant risk: loop bounds in the ancestor walk where out-of-range yields `undefined` — documented inline only if proven equivalent.

## Key design decisions (settled by ADR)

1. **API surface shape** — single breaking `mergeBase(commits, opts)` returning an array (ADR-189; option C chosen over the non-breaking A/B).
2. **Algorithm mechanism** — Git's date-ordered paint-down-to-common + `remove_redundant`, faithful to mechanism, not just results (ADR-190, chosen over full-reachability+reduce).
3. **Single-base path** — routed through the one unified core; legacy bidirectional BFS and the `a === b` shortcut deleted (ADR-191).

Tie-breaking (lex-min for the truncated single-base case) inherits the prior implementation and is not re-litigated.

## Alternatives considered

- **Full-reachability + remove-redundant.** Simpler and results-faithful, but no early termination. Rejected (ADR-190) in favour of Git's actual mechanism.
- **Non-breaking API (A/B).** Rejected (ADR-189) — option C gives a single function with a 1:1 flag map and the array return is honest about multiplicity.
- **Binary-heap priority queue.** Deferred to the v2 perf phase; an insertion-sorted array gives identical pop order and results, with fewer branches to drive to zero mutants.
