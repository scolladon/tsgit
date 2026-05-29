# Plan — Multi-base `mergeBase` (`--all`, `--octopus`)

Implements `docs/design/phase-20-7-multi-base-merge-base.md` under ADRs 189–191.

## Files

| File | Change |
|---|---|
| `src/application/primitives/merge-base.ts` | Full rewrite: paint-down-to-common core + unified `mergeBase(commits, opts)` |
| `test/unit/application/primitives/merge-base.test.ts` | Rewrite to the array API + new `--all`/octopus/guard cases |
| `src/application/commands/merge.ts` | Migrate consumer to `const [base] = await mergeBase(ctx, [ourId, theirId])` |
| `src/repository.ts` | Rewrite the `repo.primitives.mergeBase` binding to the new signature |
| `test/unit/application/primitives/arbitraries.ts` | Add a random-DAG arbitrary (shared, may already exist for other families) |
| `test/unit/application/primitives/merge-base.properties.test.ts` | New property suite (8 properties) |

`src/application/primitives/index.ts` re-exports the symbol unchanged — no edit needed.

## Dependency graph

```
Slice 1 (core + API + consumers + example tests)  ── atomic; the signature change
                                                      must land with merge.ts +
                                                      repository.ts or typecheck breaks
   └─> Slice 2 (property tests)                    ── additive, depends on Slice 1 API
```

Slices are sequential (Slice 2 needs the Slice 1 API). No parallel-safe split — the breaking signature forces Slice 1 to be one commit.

---

## Slice 1 — Core algorithm, unified API, consumer migration

**Commit:** `feat(merge-base): multi-base mergeBase (--all, --octopus)`

### Red

Rewrite `merge-base.test.ts`:

1. Keep `buildLinear` / `buildDiamond` / `commitWith` / `buildChildAfterParent` fixtures; add `buildCrissCross(ctx)` returning `{ a, b, c, d, e }` where `d` has parents `[b, c]` and `e` has parents `[c, b]` (both over root `a`).
2. Rewrite every existing assertion from `mergeBase(ctx, x, y)` (oid) to `mergeBase(ctx, [x, y])` (one-element array).
3. Add the new cases from the design's testing list: default self/single/linear/diamond/child-after-parent/criss-cross-truncate; `all:true` criss-cross + linear; unrelated (both forms); empty-input throw (try/catch on `.data.code` + `reason`); non-commit oid; octopus three-branch/single/two/all-truncation/unrelated; STALE-pruning isolation; date-ordering isolation.

Run `npx vitest run test/unit/application/primitives/merge-base.test.ts` → **fails** (old impl returns an oid, not an array; new options/cases unsupported).

### Green

Rewrite `merge-base.ts`:

- Constants: `const PARENT1 = 1, PARENT2 = 2, STALE = 4, RESULT = 8;`
- `type ReadCommit = (id: ObjectId) => Promise<Commit | undefined>` plus a factory `makeReadCommit(ctx): ReadCommit` closing over a `Map<ObjectId, Commit | undefined>` cache; reads via `readObject`, returns the object when `type === 'commit'`, else caches `undefined`.
- Priority queue helper over `{ id: ObjectId; date: number }`: `enqueue` inserts keeping date-desc / oid-asc order; `dequeue` shifts the front; `hasNonStale(queue, flags)` scans for a queued id whose flag-map entry lacks `STALE`.
- `paintDownToCommon(read, one, twos): Promise<ObjectId[]>` — creates its own fresh `flags: Map<ObjectId, number>` and queue (each paint is isolated, ADR-190):
  - set `flags[one] |= PARENT1`; for each two set `|= PARENT2`; enqueue all (date from `commit.data.committer.timestamp`, `0` if non-commit so it sorts last).
  - if `twos.length === 0` return `[one]`.
  - loop while a non-stale id is queued: dequeue newest; compute `f = flags & (PARENT1|PARENT2|STALE)`; if `f === (PARENT1|PARENT2)` and not `RESULT`, push to results, set `RESULT`, `f |= STALE`; for each parent (read commit), if `(flags[parent] & f) !== f` then `flags[parent] |= f` and enqueue.
  - return results.
- `removeRedundant(read, commits): Promise<readonly ObjectId[]>`: dedupe via `Set`; if ≤1, return sorted; else for each candidate run a fresh `paintDownToCommon(candidate, others)` and apply Git's reachability test (candidate flagged `PARENT2` ⇒ redundant; any other flagged `PARENT1` ⇒ redundant); return survivors sorted.
- `mergeBasesMany(read, one, twos)`: `paintDownToCommon` → if >1 result, `removeRedundant`, else return as-is.
- `octopusMergeBases(read, commits)`: fold per the design; `removeRedundant` at the end.
- Public `mergeBase(ctx, commits, options?)`:
  - `if (commits.length === 0) throw invalidWalkInput('mergeBase requires at least one commit')`.
  - build `read`; `const bases = options?.octopus ? await octopusMergeBases(read, commits) : await mergeBasesMany(read, commits[0]!, commits.slice(1))`.
  - `const sorted = [...bases].sort()`; `return options?.all ? sorted : sorted.slice(0, 1)`.

Keep each function < 20 lines (extract the queue and the parent-relaxation into helpers as needed). No `any`; narrow `readObject` result by `type`.

Migrate `merge.ts` (line ~109): `const [base] = await mergeBase(ctx, [ourId, theirId]);`. The `ourId === theirId` early return above already covers self; remove the now-stale Stryker comment referencing the old mergeBase self-equivalence only if it no longer applies (re-evaluate during the mutation phase).

Rewrite the `repository.ts` binding (line ~494) to `(commits, options) => { guard(); return primitives.mergeBase(ctx, commits, options); }`.

Run `npx vitest run test/unit/application/primitives/merge-base.test.ts` → **passes**. Then `npm run validate`.

### Verify

- `git grep -n "mergeBase(" src test` — confirm no remaining 2-arg call sites (browser specs, parity scenarios, e2e). Migrate any found in this commit.
- `npm run validate` green (lint, types, unit, coverage).

---

## Slice 2 — Property-based tests

**Commit:** `test(merge-base): property-based DAG invariants`

### Red

Add the DAG arbitrary to `arbitraries.ts` (or create it): generate `n` commits in topological order, each with a random subset of earlier commits as parents and a random committer timestamp; build them in the seeded context and return the oid list plus a parent-map for the oracle.

Write `merge-base.properties.test.ts` with the 8 properties from the design (symmetry, self, soundness, maximality, completeness-vs-oracle, octopus↔pairwise, octopus membership, date-order invariance). The oracle computes transitive-closure ancestor sets independently.

Run the file → it must execute (and pass once the arbitrary + oracle are correct); if a property fails, it reveals a real bug — fix the impl, not the property.

### Green

Tune the arbitrary bounds (commit count 1–8, parent fan-in ≤3) so runs are fast; set `numRuns` per tier (100 for 1–5/8, 50 for 6–7). No committed seed.

### Verify

`npx vitest run test/unit/application/primitives/merge-base.properties.test.ts` then `npm run validate` green.

---

## Post-implementation (workflow Steps 6–8)

- **Review ×3** (typescript / security / tests) on `git diff main...HEAD`.
- **Mutation**: `npm run test:mutation` scoped to the merge-base module; kill survivors or annotate provably-equivalent ones inline (loop bounds, queue tie-break ordering).
- **Docs + PR**: flip `docs/BACKLOG.md` 20.7, update the merge-base mentions in `docs/use/` / `docs/understand/` and `README.md` if it lists primitives; PR with summary + test plan.
