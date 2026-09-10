# Design — closure and history walks (31.1)

> Brief: `.claude/perf-31-1-closure-walks-prompt.md` (main checkout, untracked) — backlog **31.1**,
> the Phase 31 opener. Two review findings (`.claude/perf-review-2026-09-10.md` F1 + F12): the
> walk-tier object closure re-walks every commit's whole tree (39.3 s on the medium fixture where
> `git rev-list --objects` takes 0.11 s) and re-`stat`s `.git/config` once per `walkTree`; the
> history walks around it (`walkCommits`, merge-base, bisect, name-rev, blame `-L`, the date walk,
> `whatchanged`, `range-diff`) each carry one avoidable O(n) or O(n²) term. Plus the harness parts
> that make the closure numbers quotable. Behaviour-preserving everywhere except where a pin below
> says otherwise.
> Status: draft → self-reviewed ×3

---

## Context

### Where this comes from

Worktree `tsgit-closure-history-walks`, branch `perf/closure-history-walks`, HEAD `3bcbdb99`
(Part 0: the Phase 31 backlog section + refreshed `docs/perf/baseline.*`; **no `src/` change**), on
top of `main@1f84254c`. Every line anchor the brief and the review took on `1f84254c` was
re-verified here; the ones that were wrong are listed under [Brief corrections](#brief-corrections)
and carried corrected inline.

Environment for every number below: Apple M3 Pro, macOS, Node 22.22.3, `git version 2.55.0`. The
brief's closure baseline (iteration 1 **39 298 ms**, iteration 2 **38 505 ms**, `stat=10010`, real
git `rev-list --objects HEAD` **0.11 s**) was measured on this tree's parent and is **not re-run**
here (the brief forbids the 39 s oracle at design time). The medium bench fixture cache is present:
`~/.cache/tsgit-bench/` holds `medium-v1/v2/v3`, `medium-commit-graph-v2/v3`, `delta-chain-v1/v2/v3`,
`deep-ancestry-{small,medium}-v2/v3`, `header-cache-v3`, `large-v1`, `loose-only-v3`,
`many-pack-v3`, `many-pack-no-midx-v3`, `single-pack-v3`, `small-fat-blob-v3`, `small-v2/v3`;
`medium-v3/meta.json` = `{ headCommitId: 87723053c29f07c840c0d69d2c60ac7d7f0b4407, commits: 5000,
blobs: 20000, blobBytes: 2560 }`.

### What exists today (the subsystems touched)

| Subsystem | File | What it does today |
|---|---|---|
| Closure engine | `src/application/primitives/internal/closure-engine.ts` (308 lines) | `computeClosure(ctx, request)` — bitmap tier or walk tier. Walk tier: `markNotSide` → `resolveWants` → `emitCommitSeeds`. `emitTree` (`:121-140`) runs a **full** `walkTree` per commit; `walkAndEmitCommits` (`:204-228`) buffers whole `Commit`s (`:211-220`) then emits (`:224-227`). Dedup only at emission: `tryEmit` (`object-emit.ts:16-31`) over `state.emitted` (`:245`). |
| Not side | `src/application/primitives/internal/closure-not-marks.ts` | `markTree` prunes on `seenTrees` (`:60-61`); resolves `core.maxTreeDepth` **once** into `NotMarks.maxDepth` (`:157`, `:161`). |
| Tree walk | `src/application/primitives/walk-tree.ts` | Explicit-stack pre-order walk; `resolveWalkConfig` (`:125-137`) calls `resolveMaxTreeDepth(ctx)` when `options.maxDepth` is absent — one `readConfig` (+ `findLastInvalidMaxTreeDepth`) per call, hence the 10 010 stats. Descent decision at `:264-269`, **after** the `yield` at `:263`. |
| Commit walk | `src/application/primitives/walk-commits.ts` | FIFO frontier drained with `queue.shift()` (`:110`), pushed at `:156`, overflow guard `state.queue.length >= MAX_WALK_QUEUE_SIZE` (`:153`, `MAX_WALK_QUEUE_SIZE = 65 536`, `types.ts:30`). `until` built as `new Set(options.until ?? [])` (`:48`). |
| Push enumerator | `src/application/primitives/enumerate-push-objects.ts` | Its own weaker engine: `walkCommits(until: haves)` then a full `walkTree` per commit (`:70`); **no** not-side tree marking, so every tree/blob reachable from a pushed commit is sent unless already emitted in this push. Consumed only by `push.ts:460` (`collectObjects`). Public export (`primitives/index.ts:45`, 10 hits in `reports/api.json`). |
| Commit-graph reader | `src/application/primitives/internal/read-commit-graph.ts` | `commitHeader(ctx, id)` → `{ rootTree, parents, committerDate, generation }` (`:33-38`, `:286-317`); `generation` produced (`:303`) and **never read** by any consumer. Two callers: `walk-commits.ts:80`, `commit-date-walk.ts:176`. Graph gated off on `.git/shallow` presence (`:180-181`, ADR-544). |
| merge-base | `src/application/primitives/merge-base.ts` | `makeReadCommit` (`:24-38`) reads + parses full commits and awaits `loadShallowSet` per read; `paint` (`:57-90`) is git's `paint_down_to_common` over a **date-ordered** heap. Default result = lexicographically smallest reduced base (ADR-191). |
| bisect | `src/application/primitives/bisect-midpoint.ts` | `readCommitEntry` (`:17-22`) full read per commit; head-cursor BFS already (`:33-36`). |
| name-rev | `src/application/commands/name-rev.ts` | Target read `:55`; refs serial `:58-60`; LIFO flood `:68-84`; `expandParents` (`:112-133`) reads parents serially and awaits `loadShallowSet` per expanded commit (`:119`). Date cutoff only (ADRs 461–463). |
| blame | `src/application/commands/blame.ts` | Seeds the whole file (`:292`, `:197-199`), walks, then `applyRange` filters (`:169`, `:256-271`). |
| Date walk | `src/application/primitives/internal/commit-date-walk.ts` | Per-pop step object + `frontier` closure (`:114-118`); `enqueueParents` (`:145-162`) `Promise.allSettled` fan-out even for one parent. `walk-commits-by-date.ts:49-67` projects `.commit`. `describe.ts:281,289` is the only `frontier`/`frontierEmpty` consumer. |
| whatchanged / range-diff | `src/application/commands/whatchanged.ts:54-71`, `src/application/commands/range-diff.ts:66-104` | Tree diff awaited inside the walk loop; `hydrate` keeps `PatchFile.oldContent/newContent` for every commit of both series until `rangeDiffEntries` renders. |
| Bench | `test/bench/closure.bench.ts:72-96` | Two rows read as a tier comparison; they price `revList` (commits-only walk) vs `packObjects` (closure + deltify + pack write). |

### Constraints this design lives under

- **ADR-226** git-faithfulness (data and on-disk state, not stdout) and **ADR-249** structured
  output — nothing here adds a rendering option or a rendered string.
- **ADR-618** tier selection is per command (`rev-list` walks, `pack-objects` prefers a bitmap);
  **ADR-614** `pack-objects` ships closure-to-pack only. The walk's over-report with haves is git's
  own and stays.
- **ADR-637** the tree-depth cap is `core.maxTreeDepth`, unclamped, refused when malformed — the
  hoist below changes *where* it is resolved, never *what*.
- **ADR-544** the commit-graph reader is disabled by `.git/shallow` presence — `readCommitMeta`
  inherits the gate for free.
- **ADR-460** `commitDateWalk` yields `DateWalkStep { commit, frontierEmpty, frontier() }`; the
  fast path keeps that contract.
- **ADR-461/462/463** name-rev cutoff helpers are pure domain code; the generation cutoff extends
  them there.
- **ADR-189/191** merge-base array API and the single-base rule — P5 below shows ADR-191's
  "lexicographically smallest, mirroring git" is **not** git's rule; see DC-10.
- **ADR-645** the graph header cache is entry-capped; `readCommitMeta` reads through it.
- `.claude/workflow/surface-gates.md`: `WalkTreeOptions` (6 hits) and `WalkCommitsOptions`
  (17 hits) are in `reports/api.json` → both option additions regenerate it (prepush gate).

### Brief corrections

Anchors and claims the brief/review carry that the worktree contradicts. Each is carried corrected
in the design below.

1. **`tryEmit`/`state.emitted` at `closure-engine.ts:245, :264-268`** — `:245` is right;
   `:264-268` is `tryBitmapClosure`'s doc comment. `tryEmit` lives in
   `src/application/primitives/internal/object-emit.ts:16-31`.
2. **"`markBoundaryTrees` reads only `id` and `tree`"** — it also reads `commit.data.parents`
   (`closure-not-marks.ts:182`). The buffer is `{ id, tree, parents }`, not `{ id, tree }`.
3. **"bundle-create sits under the closure"** — `enumerate-bundle-objects.ts` never calls
   `computeClosure`; its `emitTreeObjects` already prunes on `seenTrees` (`:179-180`) and resolves
   `maxDepth` once. Bundle is **untouched** by this change.
4. **"`min_generation` cutoff in name-rev alongside its date cutoff"** — git's `name-rev` uses the
   generation cutoff **instead of** the date cutoff whenever the target commit has a generation
   number (`builtin/name-rev.c:84-91`, quoted in Pin G2). "Alongside" is not git's mechanism.
5. **"`min_generation` cutoff in merge-base's paint"** — git passes `min_generation = 0` to the
   main paint (`commit-reach.c:226`); the cutoff bites in `remove_redundant_no_gen`'s paint
   (`:291-308`), in `remove_redundant_with_gen` (`:417-420`) and in `repo_in_merge_bases_many`
   (`:614-625`). The `break` is only sound on a **generation-ordered** queue
   (`:107-115`, `:135-142`). Pin G1.
6. **"`skipTree` checked before `enterTree` pushes a subtree frame"** — in `walkTree` the consumer
   runs between the `yield` (`:263`) and `enterTree` (`:268`), and the closure's consumer `emit`s
   the directory entry — so a post-`yield` `emitted.has(id)` check would skip **every** subtree.
   The predicate must be evaluated **before** the `yield` and its verdict carried to the descent.
7. **`blame -L` with `start > end`**: git **swaps** the bounds (`line-range.c` `parse_range_arg`,
   Pin P3 `-L 4,2` and `-L 5,3` succeed); tsgit refuses (`blame.ts:268`). A faithfulness
   divergence surfaced by the pin — DC-9.
8. **`git merge-base` single result**: git prints the **first of the date-sorted result list**, the
   newest base (`builtin/merge-base.c` `show_merge_base`, Pin P5); tsgit returns the
   lexicographically smallest (ADR-191). Pre-existing divergence — DC-10; the 31.1 interop pin uses
   `--all` set equality.
9. **"300 commits × 2000-entry tree … flat after"** — not flat, in tsgit or in git. Every commit
   that changes a file has a distinct root tree, and git visits every distinct tree once, so the
   objects closure is linear in commits with a slope of (root entries + changed-subtree entries + 1)
   per commit; a flat 2000-entry root keeps the slope at ≈ 2 000 before **and after** the prune.
   The bench below fixes a subdirectory shape (40 directories × 50 files) where the prune cuts the
   slope ≈ 22× (≈ 2 040 → ≈ 91 entry visits per commit), and its oracle is absolute time on the
   300-commit row main-vs-branch, not a 100-vs-300 ratio (≈ 3 in both trees).
10. **Marked (uninteresting) subtrees**: today `emitTree` descends into them and rejects each entry
    (`:132`); git's `process_tree` returns on `UNINTERESTING | SEEN` (Pin G4). The prune predicate
    covers both — DC-2.

---

## Requirements

Mapped 1:1 to the brief's seven exit criteria. Each is a verifiable statement with its oracle.

| # | Exit criterion | Requirement | Oracle |
|---|---|---|---|
| R1 | 1 | Part 0 commit is the branch's first commit; main checkout carries no tracked change. | **Satisfied at `3bcbdb99`** (`git log --oneline -2`; `git -C ../tsgit status --short` shows only untracked `.claude/*`, `drop.err`, `stash-list.err`). Nothing further owed. |
| R2 | 2 | `revList({ wants: [HEAD], objects: true })` on medium reads **< 1 s** warm (from 39.3 s; expect ~0.2 s); `stat .git/config` per closure is O(1) — concretely the two reads `resolveMaxTreeDepth` issues (`findLastInvalidMaxTreeDepth` + `readConfig`), not 10 010; emitted oid set equals `git rev-list --objects HEAD \| cut -d' ' -f1 \| sort`; `packObjects` bytes on the delta-chain fixture byte-identical before/after. | The brief's `closure-oracle.mjs` under `fs-count.cjs` on `~/.cache/tsgit-bench/medium-v3` (wall-clock + `stat` count); Pin P1/P4 interop test; the two-worktree byte-identity script in [Test strategy](#test-strategy) plus a committed `buildPack` SHA golden. |
| R3 | 3 | `walkCommits` refuses `WALK_QUEUE_OVERFLOW` at exactly the same **frontier size** (pending = `queue.length − head`), and `WalkCommitsOptions.until` accepts a `ReadonlySet<ObjectId>`. | The three existing overflow tests (`walk-commits.test.ts:604-720`) unchanged and green; a new test where `head > 0` proves the bound is on the pending count, not the array length; a type-level + runtime test passing a `Set`. `reports/api.json` regenerated. |
| R4 | 4 | On a graph-bearing repo, merge-base / bisect-midpoint / name-rev read **zero commit objects** after the graph load; results identical with and without a graph, interop-pinned. | `instrumentedContext` (`test/unit/application/primitives/fixtures.ts:246`) `calls()` filtered to object-store paths (`objects/xx/`, `objects/pack/`; the graph file under `objects/info/` excluded) = 0 after `writeCommitGraph` (`fixtures.ts:414`); the brief's `fs-count.cjs` on `medium-commit-graph-v3` as the implementation-time check; interop tests per Pin P2/P5 with `git commit-graph write --reachable` and via `repo.maintenance({ tasks: ['commit-graph'] })`. |
| R5 | 5 | `blame -L` output pinned against `git blame -L` (Pin P3 matrix, porcelain reconstruction); `log.bench` medium and `describe.bench` not worse. | Extended `test/integration/blame-interop.test.ts`; `npm run bench:ab -- main perf/closure-history-walks 2` rows `log()`/`describe()` within noise (absolute wall-clock, both sides, alternating rounds — never self-share). |
| R6 | 6 | `closure.bench` rows renamed to what they price + a direct `computeClosure({ objects: true, tier })` pair; a new wide-tree closure bench whose per-commit slope after the prune is the distinct work only (root + changed subtree + blob; correction 9). | `npx vitest bench test/bench/closure.bench.ts test/bench/closure-wide-tree.bench.ts` — every entry in `raw.json` with `sampleCount > 0`; `bench:ab` on the 300-commit row: branch ≈ 10–20× below main (slope ≈ 2 040 → ≈ 91 entry visits per commit); the 100- and 300-commit rows both scale ≈ 3× on both trees (linearity, not flatness, is the shape). |
| R7 | 7 | `npm run validate` green; mutation budget intact (app ≥ 95); `reports/api.json` regenerated (`until`, `skipTree`); docs pages listed under [Docs consequences](#docs-consequences); backlog 31.1 ticked by the docs phase. | Bare gate runs into files (`echo $?`), never through a pipe; `npm run docs:json` diff committed in the slice that adds the export. |

---

## Design

### D0 — Shape of the change and suggested part order

Twelve items, one plan part each, in this order (the brief's order with one deliberate move):

| Part | Item | Why here |
|---|---|---|
| 1 | (l-i) `closure.bench` renames + direct tier pair + wide-tree bench | Land the honest series **first** so every later part's A/B has before/after on the same keys. |
| 2 | (a) `skipTree` + root short-circuit | Largest win. Captures the `buildPack` SHA golden and the medium entry-list snapshot **on main before touching `walkTree`**. |
| 3 | (b) `maxDepth` hoist | One option threaded; zero new resolution. |
| 4 | (c) `push` through `computeClosure` | Depends on (a)/(b) for the win; changes the pushed object set (git-faithfully). |
| 5 | (d) `walkCommits` head cursor | Independent. |
| 6 | (e) `{ id, tree, parents }` buffer + `until: ReadonlySet` | Public surface; api.json regen in-slice. |
| 7 | (f) `readCommitMeta` + three consumers + `loadShallowSet` hoists | Prerequisite for (g). |
| 8 | (g) generation cutoffs (merge-base, name-rev) | Interop-pinned with/without graph. |
| 9 | (h) `blame -L` seeding | Interop-pinned (P3). |
| 10 | (i) date-walk single-parent fast path | `describe` non-regression. |
| 11 | (j) `whatchanged` / `range-diff` | Independent. |
| 12 | (k) `name-rev` bounded reader + (l-ii) many-tag bench arm | Last: its A/B needs the arm. |

Every part is behaviour-preserving by construction **except**: (c) shrinks the pushed object set
to git's (Pin G5), (g) changes the *visited* set only, (h) under DC-9 turns one refusal into a
success, and DC-10 if taken. Each of those is pinned.

---

### D1 — (a) `skipTree` on `WalkTreeOptions` + `emitTree` root short-circuit

**Mechanism (git).** `list-objects.c` `process_tree` (Pin G4): `if (obj->flags & (UNINTERESTING | SEEN)) return;` then `obj->flags |= SEEN` — each distinct tree is expanded once, and an uninteresting tree is never expanded on the interesting side.

**Change.**

```ts
// src/application/primitives/types.ts — WalkTreeOptions (public; api.json + walk-tree.md row)
export interface WalkTreeOptions {
  …
  /**
   * Prune: when it returns `true` for a directory entry's id, that entry is still
   * yielded but its subtree is not entered. Evaluated once per directory entry,
   * BEFORE the entry is yielded — a consumer that reacts to the yield cannot
   * influence the verdict. git's `process_tree` SEEN/UNINTERESTING short-circuit.
   */
  readonly skipTree?: (id: ObjectId) => boolean;
}
```

```ts
// src/application/primitives/walk-tree.ts — the descent verdict moves BEFORE the yield
interface FrameStep { …; readonly descend: boolean }            // new field, computed in nextFrameEntry

function nextFrameEntry(config, counter, frame): FrameStep {
  …
  const descend =
    shouldRecurse(config.recursive, entry.mode) && !(config.skipTree?.(entry.id) ?? false);
  return { path, entry, nameHash, pathBytes, descend };
}

// walkTree loop (was :262-269)
const { path, entry, nameHash, pathBytes, descend } = nextFrameEntry(config, counter, frame);
yield buildYieldedEntry(path, entry, nameHash, pathBytes);
if (!descend) continue;
const subtreeObj = await readObject(config.ctx, entry.id);
…
```

`WalkConfig` gains `readonly skipTree?: (id: ObjectId) => boolean` (spread conditionally like
`pathHasher`, `:135`). Pre-yield evaluation is the load-bearing detail (correction 6): the closure's
`emit` for the directory entry runs while the generator is suspended at the `yield`, so a
post-yield `emitted.has(entry.id)` would be `true` for every subtree.

```ts
// src/application/primitives/internal/closure-engine.ts — emitTree
interface TreeEmitScope {
  readonly marked: ReadonlySet<ObjectId>;   // marks.objects, or NO_MARKS for a tree want
  readonly emitted: ReadonlySet<ObjectId>;  // state.emitted (read-only view)
  readonly maxDepth: number;                // marks.maxDepth (D2)
}

async function emitTree(ctx, treeId, scope, emit): Promise<void> {
  // git's process_tree: UNINTERESTING | SEEN → return, before anything is shown
  if (scope.marked.has(treeId) || scope.emitted.has(treeId)) return;
  emit({ id: treeId, type: 'tree', path: ROOT_PATH, nameHash: PACK_NAME_HASH_SEED });
  const skipTree = (id: ObjectId): boolean => scope.marked.has(id) || scope.emitted.has(id);
  for await (const entry of walkTree(ctx, treeId, {
    pathHasher: PACK_NAME_HASH_V1,
    maxDepth: scope.maxDepth,
    skipTree,
  })) {
    if (isGitlink(entry.mode)) continue;
    if (scope.marked.has(entry.id)) continue;
    emit({ … as today … });
  }
}
```

The predicate covers **both** `marked` and `emitted` (DC-2, recommended); `emitted`-only is the
brief's literal text and is also output-identical (argument below), but leaves the uninteresting
descent in place on every closure with a `not` side (push, `pack-objects --not`, `rev-list ^x`).

**Root short-circuit.** `marked.has(root) || emitted.has(root)` → return before the root emit
(today the root emit is rejected by `tryEmit` and the full walk still runs — P4 case).

**Refusal surfaces touched (tsgit-only guards, no git counterpart):**

- `TREE_ENTRY_LIMIT_EXCEEDED` (`MAX_FLAT_TREE_ENTRIES = 1 000 000`, per `walkTree` call, `:163-166`)
  now counts entries *visited* under the prune rather than every entry of every repeated subtree.
  The guard's purpose is to bound work; visits are the work. A first visit of an over-limit tree
  still refuses. Documented on `walk-tree.md`'s `maxEntries` row.
- `TREE_CYCLE_DETECTED` (`enterTree`, `:117`): a tree containing itself is a hash-collision-only
  shape; through the closure it becomes unreachable (the second encounter is `emitted`, so it is
  skipped) — exactly what git's `SEEN` return does. `walkTree` alone still detects it.
- `TREE_DEPTH_EXCEEDED`: unchanged — depth is checked in `enterTree` on every frame actually
  entered; a deep tree is entered in full on its first encounter.
- `PACK_TOO_LARGE` (`tryEmit`): unchanged — see the equivalence argument.

**Callers to sweep.** `walkTree`'s twelve callers (`walk-tree.ts:216` counts them) are untouched —
the member is optional and, evaluated only after `shouldRecurse`, is never called for a blob or a
gitlink entry. `emitTree`'s three call sites (`resolveWants:165`, `emitSeedsWithoutWalking:194`,
`walkAndEmitCommits:226`) take the `TreeEmitScope`; `resolveWants` runs after `markNotSide`
(`walkClosure:252-253`), so `marks.maxDepth` is available to the tree-want path.

**Pins.** P1 (shared subtrees: oid set equal to git's, tsgit's emitted entry sequence recorded
before the change), P4 (identical-tree commit: the shared root appears once in git's output; tsgit
short-circuits), G4 (`process_tree`).

### Equivalence argument — order, first-encounter path, `nameHash`, cap, hence pack bytes

Let *S* be the sequence of `emit(...)` calls that pass `tryEmit` today (the surviving sequence).
The claim: the pruned walk produces the identical *S*.

1. **A pruned subtree contributes nothing to *S* today.** `skipTree(T)` is true only when *T* is in
   `emitted` or `marked` at the moment the walker reaches *T*'s entry (pre-yield, so before the
   consumer sees it).
   - *T* ∈ `emitted`: *T* passed `tryEmit` earlier, at which point `emitTree` was descending it
     (a tree is only ever emitted by the `emitTree` that walks it, or as a root). Every descendant
     *E* of *T* was then either emitted (now in `emitted`) or rejected because already in `emitted`
     or in `marked`. So at any later visit every descendant is in `emitted ∪ marked` and every emit
     for it is rejected — `tryEmit` checks `emitted.has` **before** the cap (`object-emit.ts:17`),
     and marked entries `continue` before `emit` (`closure-engine.ts:132`). The block is silent.
   - *T* ∈ `marked`: `markTree` (`closure-not-marks.ts:52-76`) adds every non-gitlink descendant to
     `marked` recursively (blobs at `:71`, subtrees by recursion; `seenTrees` only short-circuits a
     subtree that a completed earlier `markTree` already marked). So every descendant is
     `continue`d at `:132`. Silent.
2. **Removing silent blocks preserves *S*.** `walkTree` is a pre-order DFS; a skipped subtree is a
   contiguous run of its entries. Deleting a contiguous run that contributes no surviving emit
   leaves the surviving sequence, and therefore every surviving entry's **ordinal**, unchanged.
3. **Path and `nameHash` are per-emit values fixed at first encounter.** Each surviving emit
   carries the `path`/`nameHash` `walkTree` folded on *that* encounter (`:170-173`); first
   encounter wins because later encounters are rejected. Pruning removes only later encounters.
4. **Cap.** `tryEmit` throws `PACK_TOO_LARGE` only for an id not yet in `emitted` when
   `emitted.size >= cap`. Pruned visits would have been rejected before the cap check, so the cap
   fires at the same emit, or not at all, as today.
5. **Pack bytes.** `buildPack` orders by `(type, nameHash, size, recency, oid)`
   (`build-pack.ts:53-62`); `pack-objects` passes `closure.objects` in emission order
   (`pack-objects.ts:82-89`), gc derives `recency` from the emission ordinal
   (`gc-pipeline.ts:316-335`). Same sequence, same `nameHash`, same ordinals ⇒ same input to the
   packer ⇒ identical bytes and identical `pack.sha`.

The argument holds for `emitted`-only and for `emitted ∪ marked` alike (DC-2 changes only which
silent blocks are removed). Its pins: the committed `buildPack` SHA golden on a synthetic
shared-subtree repository captured on `main`; the two-worktree byte comparison on the delta-chain
fixture; the medium entry-list snapshot diff (all in [Test strategy](#test-strategy)).

---

### D2 — (b) `core.maxTreeDepth` resolved once per closure

`NotMarks.maxDepth` already holds the closure-wide value (`closure-not-marks.ts:157,161`, resolved
in `markNotSide`, which `walkClosure` awaits first at `:252`). The hoist is a single option:
`walkTree(ctx, treeId, { …, maxDepth: scope.maxDepth })` from `emitTree` (D1's `TreeEmitScope`),
which makes `resolveWalkConfig:132` skip `resolveMaxTreeDepth`. No new resolution, no new
parameter on `computeClosure`, no change to `resolveMaxTreeDepth` (ADR-637's refusal still fires,
once, in `markNotSide`). The config-stat count per closure becomes the two reads `resolveMaxTreeDepth`
issues (`findLastInvalidMaxTreeDepth` + `readConfig`, `resolve-max-tree-depth.ts:17,21`) plus the
command gate's — O(1). `enumeratePushObjects` (`:70`) keeps its per-call resolution: it leaves `push`'s
path in D3 and is deleted by 31.6.

Threading alternatives (a `maxDepth` on `ClosureRequest`; a resolved value on `WalkConfig` cached
per `Context`) were probed and rejected: the value already exists in the closure state and
`WalkTreeOptions.maxDepth` is the existing seam. Not a decision.

---

### D3 — (c) `push` through `computeClosure`

**Today.** `push.ts:452-463` `collectObjects` → `enumeratePushObjects({ wants, haves })` → every
tree and blob reachable from the wanted commits, minus nothing the remote has (no not-side tree
marking). A one-file push on a 20 000-file tree sends the whole tree.

**Mechanism (git).** `send-pack.c:45-55` `feed_object` (Pin G5): a **negative** oid the local
repository does **not** have is dropped before it reaches `pack-objects`; every remote ref's
`old_oid` is fed negative (`:104-112`), `new_oid`s positive. `pack-objects --revs` then computes
the closure with the bitmap when usable (its default; ADR-618).

**Change.**

```ts
// src/application/commands/push.ts — collectObjects
const collectObjects = async (ctx, wants, haves): Promise<ReadonlyArray<ObjectId>> => {
  if (wants.length === 0) return [];
  const distinctHaves = [...new Set(haves)];
  // git send-pack `feed_object`: a negative we do not have locally is never fed.
  const present = await boundedMapFor(ctx, 'ioBound', distinctHaves, (id) => hasObject(ctx, id));
  const not = distinctHaves.filter((_, index) => present[index] === true);
  const closure = await computeClosure(ctx, { wants, not, objects: true, tier: 'bitmap' });
  return closure.objects.map((object) => object.id);
};
```

- `hasObject` (`has-object.ts:13-17`): registry lookup then loose `exists`, never a promisor fetch
  (git's `odb_has_object(…, 0)` does not fetch either); the zero-oid
  ref-creation sentinels `push.ts:347-351` keeps in `haves` fall out here (the comment at
  `:347-350` is rewritten: they no longer reach a membership set, they are filtered like any absent
  negative). Without this filter `markNotSide` would `readObject` an absent have and throw
  `OBJECT_NOT_FOUND` — DC-7 records the alternative (an engine-level tolerance).
- `tier: 'bitmap'` — git's `pack-objects` default for the push closure (DC-8).
- `buildPack(ctx, { objects: oids.map((id) => ({ id })) })` unchanged — no `nameHash`, no `recency`
  (`push.test.ts:595` keeps passing); deltas are 31.6's.
- `PACK_TOO_LARGE`: `walkClosure` uses `MAX_PUSH_OBJECTS` as the `EmitState` cap (`:245`) — same
  cap, same error.
- Tags: `resolveWants` records tag oids through `resolveTagChain` exactly as `collectCommitSeeds`
  did.

**Observable change (git-faithful).** The pushed object set shrinks to the walk's `W AND NOT N`
(or the bitmap's exact difference) instead of "everything reachable from `wants`": fewer objects
on the wire. Order of the surviving objects is the closure's (commit, its tree, entries — the same
per-commit shape `walkCommitClosure` produced). The cost moves: `markNotSide` walks the haves'
full commit ancestry (git's `^have` limits this with date slop; tsgit's not-side walk is total —
pre-existing, documented in `closure-not-marks.ts` module doc) — on medium that is one commits-only
walk (~0.2 s cold), against today's full-tree walk per pushed commit.

**Seam for 31.6.** `enumeratePushObjects` loses its last internal caller. It stays exported
(`primitives/index.ts:45`, public; `knip` does not flag a public export) with its unit test; a
doc note in `docs/use/primitives/internals.md` says `push` no longer uses it and 31.6 owns its
deletion together with `delta: true` for push.

**Tests to sweep.** `push.test.ts` (fake advertisement built per test at `:59-80`; each
expectation is re-checked against the `hasObject` filter — tips absent locally and zero-oid
sentinels drop out, locally present ancestors become real `not`s; the planner lists every case), `test/integration/network/push-http-backend.test.ts`
(asserts refs advanced, not object counts), `enumerate-push-objects.test.ts` (unchanged).

---

### D4 — (d) `walkCommits` head-cursor frontier

`bitmap-binding.ts:204-210` is the house pattern. `WalkState` gains `head: number`; the loop becomes
`while (state.head < state.queue.length) { const id = state.queue[state.head]!; state.head += 1; … }`
and `enqueueIds` checks `state.queue.length - state.head >= MAX_WALK_QUEUE_SIZE` before pushing.
Overflow therefore fires at the same **pending** frontier size; the retained array grows to the
number of ever-enqueued ids (the `visited` set already retains that order of memory).

**Pin (the easy regression).** A fourth test in the `queue-overflow guard` block: a walk that pops
`k > 0` commits before an octopus commit with exactly `MAX_WALK_QUEUE_SIZE − k + 1` fresh parents
arrives must **not** overflow (the array length passes 65 536 while the pending count does not),
and one with `MAX_WALK_QUEUE_SIZE + 1` fresh parents after `k` pops **must**. The existing three
tests (`:604-720`) stay as they are.

The `queue` comment at `:19-21` ("mutated via push/shift") is rewritten for the cursor.

---

### D5 — (e) `{ id, tree, parents }` buffer + `until` accepting a `ReadonlySet`

```ts
// closure-engine.ts — walkAndEmitCommits
interface WalkedCommit { readonly id: ObjectId; readonly tree: ObjectId; readonly parents: ReadonlyArray<ObjectId> }
const walked: WalkedCommit[] = [];
for await (const commit of walkCommits(ctx, {
  from: commitSeeds.map((seed) => seed.id),
  until: marks.commits,                    // the Set itself — completed before this walk starts
  ignoreMissing: true,
  order: …,
})) {
  walked.push({ id: commit.id, tree: commit.data.tree, parents: commit.data.parents });
  …
}
```

`markBoundaryTrees(ctx, walked: ReadonlyArray<WalkedCommit>, marks)` reads `parents` (`:182`) and
`id`/`tree` — correction 2. `Commit` bodies (message, author, committer, signature) are released as
the walk proceeds.

```ts
// types.ts — public
export interface WalkCommitsOptions {
  readonly until?: ReadonlyArray<ObjectId> | ReadonlySet<ObjectId>;
  …
}
export interface WalkCommitsByDateOptions { readonly until?: ReadonlyArray<ObjectId> | ReadonlySet<ObjectId>; … }
```

One shared narrowing helper in `primitives/internal/` (`asIdSet(until): ReadonlySet<ObjectId>` —
returns the set by reference when `typeof until.has === 'function'`, else `new Set(until)`), used
by `createWalkSession` (`walk-commits.ts:48`, `WalkState.until` becomes `ReadonlySet`, it is only
ever `.has`-read) and `commitDateWalk` (`commit-date-walk.ts:96`; `CommitDateWalkOptions.until`
widened the same way). DC-3 covers union vs replacement.

**Consumer sweep (value shape, not just the name — the type widens, so `tsc` stays green
regardless).** Callers passing a spread set today, each becomes the set by reference:
`closure-engine.ts:214` (`marks.commits`), `closure-not-marks.ts:103` (`markedCommits` — live set;
safe because a commit is added only after it is yielded and yielded commits are `visited`, so
`until` membership can no longer affect it; the `Stryker disable … ArrayDeclaration` at `:102`
disappears with the literal), `cherry-pick.ts:145`, `revert.ts:334`, `rebase.ts:182`
(`[...excluded]` — sets in hand; the plain equivalent-mutant note at `rebase.ts:178` is re-read
against the reference form). `enumerate-bundle-objects.ts:235` is **left as is** (correction 3 —
bundle is not in this change). Callers passing
arrays stay: `log.ts:57-58`, `whatchanged.ts:50-51`, `shortlog.ts:45`, `range-diff.ts:99`,
`enumerate-push-objects.ts:64`. `docs/use/primitives/walk-commits-by-date.md:17` shows the type;
`walk-commits.md`'s signature block is already stale (`from?`, `excluding`) — flagged for the docs
phase. `reports/api.json` regenerated in this part.

---

### D6 — (f) `readCommitMeta` — graph first, object fallback

**Mechanism (git).** `parse_commit_in_graph` serves parents, tree, date and generation without an
object read; `commit_graph_generation` (`commit-graph.c:126-135`, Pin G3) returns the graph's value
when non-zero and `GENERATION_NUMBER_INFINITY` otherwise — for a commit outside the graph **and**
for a graph written without generation data (`GENERATION_NUMBER_ZERO`).

```ts
// src/application/primitives/internal/read-commit-meta.ts (new)
export const GENERATION_INFINITY = Number.POSITIVE_INFINITY;   // git's GENERATION_NUMBER_INFINITY role

export interface CommitMeta {
  readonly parents: ReadonlyArray<ObjectId>;
  readonly committerDate: number;
  /** Graph generation — topo level (v1) or corrected commit date (GDA2) — or
   *  GENERATION_INFINITY when no graph serves this commit (or serves it with 0). */
  readonly generation: number;
}

const fromHeader = (header: CommitHeader): CommitMeta => ({
  parents: header.parents,
  committerDate: header.committerDate,
  generation: header.generation > 0 ? header.generation : GENERATION_INFINITY,
});

/** Graph first; `readObject` + `applyGraft` fallback. `undefined` for a non-commit object;
 *  OBJECT_NOT_FOUND propagates (a graph hit for a missing body does not throw — git's
 *  `repo_parse_commit` succeeds from the graph too). */
export const readCommitMeta = async (ctx: Context, id: ObjectId): Promise<CommitMeta | undefined> => {
  const header = await commitHeader(ctx, id);
  if (header !== undefined) return fromHeader(header);
  const object = await readObject(ctx, id);
  if (object.type !== 'commit') return undefined;
  const grafted = applyGraft(object, await loadShallowSet(ctx));
  return { parents: grafted.data.parents, committerDate: grafted.data.committer.timestamp, generation: GENERATION_INFINITY };
};

/** For a `Commit` already in hand (a peeled ref tip): the graph supplies only the generation. */
export const commitMetaOf = async (ctx: Context, commit: Commit): Promise<CommitMeta> => {
  const header = await commitHeader(ctx, commit.id);              // cache hit or a graph lookup; no object read
  const grafted = applyGraft(commit, await loadShallowSet(ctx));  // a no-op whenever a graph is on (ADR-544)
  return {
    parents: grafted.data.parents,
    committerDate: commit.data.committer.timestamp,
    generation: header === undefined ? GENERATION_INFINITY : fromHeader(header).generation,
  };
};
```

Graft consistency: the graph is disabled when `.git/shallow` exists (ADR-544), so a graph hit never
needs grafting; the fallback grafts. Shallow probing is one memoised promise per session
(`shallow-set.ts:31,61-74`) — the "hoist `loadShallowSet`" items are discharged by construction
(`merge-base.ts:33` and `name-rev.ts:119` disappear; the fallback awaits an already-resolved
promise only when the graph misses). DC-4 covers the graph-absent `generation` shape.

**Consumers.**

| Consumer | Today | After |
|---|---|---|
| `merge-base.ts` `makeReadCommit` (`:24-38`) | `readObject` + `loadShallowSet` per read, memo of `Commit \| undefined` | memo of `CommitMeta \| undefined` over `readCommitMeta`; `paint` reads `.parents`, `.committerDate`, `.generation`. The `Stryker disable … all: equivalent` at `:27-30` is re-proven against the new memo (same shape, same argument) or dropped if the memo goes. |
| `bisect-midpoint.ts` `readCommitEntry` (`:17-22`) | `readObject` + graft → `{ date, parents }` | `readCommitMeta`; `undefined` → the existing `invalidWalkInput` refusal (message verbatim). `paintReachable`/`makeEntryReader` unchanged. |
| `name-rev.ts` target (`:55-56`) | `readObject` → committer date | `readCommitMeta(ctx, target)` → date + generation for the cutoff (ADR-462's one-read pin holds without a graph). |
| `name-rev.ts` `seedRef` (`:97-98`) | `tip.commit` + `applyGraft(loadShallowSet)` | `commitMetaOf(ctx, tip.commit)`; stack nodes become `{ id, parents, committerDate, generation }`. |
| `name-rev.ts` `expandParents` (`:126-128`) | `readObject` + graft per parent | `readCommitMeta` through the bounded reader (D11). |

**Oracle.** Unit: `instrumentedContext(ctx).calls()` filtered to paths containing `objects/` (the
name-rev test's `withCountedObjectReads` at `name-rev.test.ts:544-556` is the existing shape) is
**zero** after `writeCommitGraph(ctx, [[…all commits…]])` for `mergeBase`, `bisectMidpoint`,
`nameRev`; the same repos without a graph return identical results with the pre-change read
counts. Implementation-time: `fs-count.cjs` on `medium-commit-graph-v3` — zero `readFile`/`fh.read`
of objects after the graph load.

---

### D7 — (g) Generation-number cutoffs, gated on graph presence

Two different git mechanisms, two local implementations sharing only `readCommitMeta` (the "one
helper or two" candidate is not a decision: git's structures differ).

#### merge-base — `paint_down_to_common`'s `min_generation` (Pin G1)

Verbatim mechanism (`commit-reach.c:100-191`): the queue compares
`compare_commits_by_gen_then_commit_date` unless `!min_generation && !corrected_commit_dates_enabled(r)`
(then date only, `:114-115`); after each pop `if (generation < min_generation) break;` (`:141-142`),
with a `BUG` guard that the pops are generation-monotone (`:135-138`). Callers:
`merge_bases_many` passes **0** (`:226`); `remove_redundant_no_gen` passes the **minimum generation
over the whole candidate array** (`:291-304`) — `INFINITY` when every candidate is outside the
graph, so the break fires as soon as a graph-covered commit pops, which is sound because a graph
contains the full ancestry of every commit it covers (no graph-covered commit can be a descendant
of a graph-absent one). git's `_no_gen` takes that minimum over the not-yet-redundant entries;
tsgit's `removeRedundant` paints every candidate against all others, so its minimum is over the
whole set — never higher than git's, so it never prunes more than git does. `remove_redundant`
dispatches to `_with_gen` when generation numbers are
enabled and any candidate is graph-covered (`:458-480`); `_with_gen` is a different algorithm
(first-parent-style STALE push-up, `:339-456`) — **not** replicated: `_no_gen` + `min_generation`
gives the identical reduced set with git's own cutoff and a small diff.

```ts
// merge-base.ts
interface PaintEntry { readonly oid: ObjectId; readonly date: number; readonly generation: number; readonly value: undefined }
/** git compare_commits_by_gen_then_commit_date: higher generation first, then newer date; oid tiebreak kept from `precedes`. */
const precedesByGeneration = (a: PaintEntry, b: PaintEntry): boolean =>
  a.generation !== b.generation ? a.generation > b.generation : precedes(a, b);

/** A non-commit id (today's `dateOf(undefined) === 0` leaf) sorts FIRST with an infinite generation
 *  and has no parents — it can never trip the break the way a `0` would. */
const generationOf = (meta: CommitMeta | undefined): number => meta?.generation ?? GENERATION_INFINITY;

const paint = async (read, one, twos, minGeneration: number) => {
  …   // mark(): heap.push({ oid: id, date: dateOf(meta), generation: generationOf(meta), value: undefined })
  while (hasNonStale(heap.entries(), flags)) {
    const { oid: id, generation } = heap.pop()!;
    if (generation < minGeneration) break;                        // commit-reach.c:141-142
    …
  }
};
mergeBasesMany  → paint(read, one, twos, 0)                       // commit-reach.c:226
removeRedundant → paint(read, candidate, others, minGenerationOf([candidate, ...others]))   // :291-304
```

- With no graph every `generation` is `GENERATION_INFINITY`: the comparator degenerates to today's
  `precedes`, `minGeneration` is `INFINITY`, `INFINITY < INFINITY` is false → today's behaviour
  exactly (no gate flag needed; the gate is the data).
- The comparator is gen-then-date **always** (DC-5): required whenever `minGeneration > 0` (git
  `BUG`s otherwise), harmless when 0. git switches to date-only for the main paint on a graph
  without GDA2; tsgit's `generation` is the corrected date when GDA2 is present
  (`commit-graph.ts:314-322`) and the topo level otherwise, so the only configuration where
  tsgit's *traversal order* differs from git's is a v1 graph in the main paint — results
  (RESULT set, reduced set) are traversal-order independent; the single-result rule is DC-10.
- `hasNonStale`'s linear scan stays (review: healthy; git's `nonstale_queue` bookkeeping is a
  constant-factor alternative).
- Suppressions inside `paint` (`:46-49`, `:75-78`, `:82-85`) sit on lines whose structure does not
  change; the memo suppression (`:27-30`) and the `removeRedundant` fast path (`:109-112`) are
  re-run after the change and re-proven in place.

#### name-rev — `commit_is_before_cutoff` (Pin G2)

Verbatim (`builtin/name-rev.c:84-91`): `if (generation_cutoff < GENERATION_NUMBER_INFINITY) return
generation_cutoff && commit_graph_generation(commit) < generation_cutoff; return commit->date < cutoff;`
— generation **replaces** the date test when the target has a generation (`set_commit_cutoff`
`:53-65` takes the minimum over the input commits; tsgit names one target). The `generation_cutoff &&`
guard is `--all`'s disable path (`:46-50`), which tsgit has no surface for.

```ts
// src/domain/name-rev/cutoff.ts (pure; ADR-461)
export interface NameRevCutoff { readonly date: number; readonly generation: number }
export const nameRevCutoff = (target: { committerDate: number; generation: number }): NameRevCutoff =>
  ({ date: adjustForSlop(target.committerDate), generation: target.generation });   // today's slop rule, unchanged
export const commitIsBeforeCutoff = (commit: { committerDate: number; generation: number }, cutoff: NameRevCutoff): boolean =>
  cutoff.generation < GENERATION_INFINITY ? commit.generation < cutoff.generation : commit.committerDate < cutoff.date;
```

Gating is again the data: no graph ⇒ target generation `INFINITY` ⇒ the date branch ⇒ today's
behaviour byte for byte. A commit outside the graph while the target is inside has generation
`INFINITY`, which is never below the cutoff — traversed, as git does (G3). Correction 4 applies:
the brief's "alongside" is replaced by git's priority rule (DC-6 records it for ratification).

**Visited set vs result.** Both cutoffs change which commits are *visited*, never which are
*returned* — for merge-base by the ancestry argument above; for name-rev because a commit with
generation `< gen(target)` cannot be a descendant of the target (generation strictly decreases
along parent edges), so no path from any ref to the target runs through it, and names flow only
along such paths. On histories with monotonic dates the date slop and the generation cutoff prune
the same result; on skewed clocks the date heuristic can mis-name where generation cannot — git
has the same two behaviours in the same two states, which is the faithful outcome.

**Pins.** P2 (merge-base single/`--all`/`--octopus`/`--is-ancestor`; name-rev default/`--tags`/
`--refs`; identical before and after `git commit-graph write --reachable`), P5 (criss-cross:
`--all` set identical with/without graph; single result = newest base — DC-10), G1–G3.

---

### D8 — (h) `blame -L` seeds `[bottom, top)`

**Mechanism (git).** `builtin/blame.c` `cmd_blame` (Pin G6): `lno = sb.num_lines`; per range
`parse_range_arg` → `if ((!lno && (top || bottom)) || lno < bottom) die("file %s has only %lu lines")`;
`if (bottom < 1) bottom = 1; if (top < 1 || lno < top) top = lno; bottom--;` then one
`blame_entry` per merged range. `line-range.c` `parse_loc`: `if (num <= 0) die("-L invalid line
number: %ld", num)`; `parse_range_arg`: `if (*begin && *end && *end < *begin) SWAP(*end, *begin)`.
Order of checks: each bound `> 0` (begin first), swap, beyond-EOF, clamp.

```ts
// blame.ts
interface LineWindow { readonly start: number; readonly last: number }   // 1-based inclusive, clamped

/** git cmd_blame's -L block + parse_loc/parse_range_arg, in git's check order. Runs on the
 *  queried file's own line count (committed blob or working file), BEFORE the empty-file return. */
const resolveLineWindow = (lineCount: number, range: BlameOptions['range']): LineWindow | undefined => {
  if (range === undefined) return lineCount === 0 ? undefined : { start: 1, last: lineCount };
  const { start, end } = range;
  if (!Number.isInteger(start) || !Number.isInteger(end)) throw invalidOption('-L', 'line numbers must be integers');
  if (start < 1) throw invalidOption('-L', `invalid line number: ${start}`);
  if (end < 1) throw invalidOption('-L', `invalid line number: ${end}`);
  const [bottom, top] = end < start ? [end, start] : [start, end];      // DC-9: git swaps
  if (bottom > lineCount) throw invalidOption('-L', `file has only ${lineCount} lines`);
  return { start: bottom, last: Math.min(top, lineCount) };
};

const seedEntry = (window: LineWindow): BlameEntry =>
  ({ finalStart: window.start - 1, count: window.last - window.start + 1, sourceStart: window.start - 1 });
```

Both seed paths take the window: `seed` (`:279-297`) resolves it from `splitLines(blob).length`
**before** the `lines.length === 0` return at `:286` (so `-L 1,1` on an empty file refuses
`file has only 0 lines`, P3; the no-range empty file still returns no lines, exit 0);
`seedWorkingTree` (`:186-225`) resolves it from `workingLines.length` before `:196` and uses
`[seedEntry(window)]` in place of `whole` for both the `splitAgainstParent` split and the
staged-new `finalizeUncommitted`. `applyRange` (`:256-271`) and its call at `:169` are deleted;
the final sort stays. `finalLine`/`sourceLine` remain absolute (git porcelain prints absolute
numbers — P3 `-L 2,4` shows `2 2 1`, `3 3 1`, `4 4 1`).

Messages: `line numbers must be integers` (tsgit-only, JS numbers), `invalid line number: N`,
`file has only N lines` — verbatim as today. `range end N precedes start M` is **removed** under
DC-9 (git never emits it — it swaps); kept only if DC-9 chooses the documented divergence.
`BlameOptions.range`'s doc comment (`:52-57`) and `blame.md:88-89` change accordingly.

Suppressions at `:195` and `:285` (empty-file early returns) are re-proven: with the window
resolved first, the guard still only short-circuits the no-range empty case and remains equivalent.

**Pin.** P3 matrix below, reconstructed as porcelain in `blame-interop.test.ts` (existing
reconstruction), refusals compared as `INVALID_OPTION` + message vs git's `fatal:` text + exit 128.

---

### D9 — (i) Date-walk single-parent fast path

```ts
// commit-date-walk.ts — enqueueParents
const parents = selectParents(commit, walk.firstParent).filter(claimUnseen(walk));   // today's :146-150
if (parents.length === 0) return;
if (parents.length === 1) return enqueueCommit(ctx, walk, parents[0]!);              // no allSettled, no promise array
… today's allSettled arm, unchanged, for ≥ 2 parents (array-order invariant, ADR-460) …
```

`enqueueCommit` (`:164-169`) already awaits `resolveHeapEntry` and pushes — the single-parent arm
reuses it. The per-pop `frontier` closure (`:117`) is hoisted to one closure per walk over the same
`walk.heap` (its contract is a live snapshot "valid until the iterator resumes" — same object,
same reads); `frontierEmpty` stays a per-step boolean. `DateWalkStep`'s shape is unchanged
(`describe.ts:281,289`, `walk-commits-by-date.ts:61`). The reviewer's 1.55 → 1.19 µs/commit is a
model, not a measurement; the oracle is `bench:ab` on `log()` medium and `describe()` — "not worse"
is the bar, the gain is reported if it clears the run-to-run noise.

Tests: `commit-date-walk.test.ts:257-295` (frontier snapshots on a diamond: `[[], [b], [a], []]`,
emptiness `[true, false, false, true]`) pin the ≥ 2-parent order; a new linear-history test pins
that the single-parent arm yields the same sequence as before and that a rejected single-parent
read still rethrows.

---

### D10 — (j) `whatchanged` and `range-diff`

**whatchanged** (`:54-71`): collect the selected commits (merge filter, `before` filter, `limit`
counted on selected commits, `break` when reached) into an array, then
`boundedMapFor(ctx, 'ioBound', selected, (c) => diffCommitAgainstParent(ctx, c.data.parents[0], c.data.tree))`
and zip in order. Output order and `limit` semantics identical; the walk's read-ahead is no longer
stalled by a diff per iteration.

**range-diff** (`:66-104`): `hydrate` renders immediately —
`renderRangePatch(input)` (`domain/range-diff/patch-text.ts:187`) → `RenderedPatch`
(`{ id, subject, patch, diff, diffsize }`, strings only) — and returns that; `materialisePatchFiles`'
`PatchFile.oldContent/newContent` go out of scope per commit inside `hydrate`. Domain:
`rangeDiffEntries(old: ReadonlyArray<RenderedPatch>, new: …, factor)` (its two `.map(renderRangePatch)`
at `range-diff.ts:17-18` become the caller's); `renderRangePatch` and `RenderedPatch` are exported
from `domain/range-diff/index.ts`. `CommitPatchInput`/`RenderedPatch` are not in `api.json` (0 hits)
— internal. Patch text is bounded by `MAX_PATCH_TEXT_CHARS` already. Output unchanged
(`RangeDiffCommit` reads only `id`/`subject`, `interleave.ts:34-62`).

---

### D11 — (k) `name-rev` bounded parent reads

Refs stay serial (`:58-60`; LIFO order and `isBetterName` tie-breaks are git's). Within a ref's
flood, `expandParents` keeps its two-phase shape with reads overlapped:

```ts
const metas = boundedReaderFor(ctx, 'ioBound', (id) => readCommitMeta(ctx, id));   // once per nameRev call
// expandParents(ctx, node, name, revNames, cutoff, metas)
const accepted = parents.filter((oid, index) => accept(revNames, oid, index === 0 ? firstParentName(name) : mergeParentName(name, index + 1)));  // sync, array order — unchanged
for (const oid of accepted) metas.start(oid);                       // overlap
for (const oid of accepted) {
  const meta = await metas.start(oid); metas.forget(oid);          // forget on consumption, or the flood is retained
  if (meta === undefined || commitIsBeforeCutoff(meta, cutoff)) continue;
  queued.push({ id: oid, ...meta });
}
```

`accept` decisions never depend on a read, so prefetching after acceptance changes no name; a
non-commit parent still `continue`s after having been named (today's behaviour, unobservable — the
target is never pruned). With a graph the reader is I/O-free. The bench fixture's ~0.5 ms
per-command floor hides this; the many-tag arm (D12) is what can show it.

---

### D12 — (l) Harness

**`test/bench/closure.bench.ts`** — keep both command-default rows, rename to what they price, add
the direct pair on the same fixture (`assertClosureAnsweredByBitmap`, `:40-53`, already builds the
call; `setupBitmapClosureFixture(500)`):

| Today (series key `…, <when-then> > tsgit`) | After |
|---|---|
| `When revList() computes the closure at its own default (a walk), Then measure tsgit` | `When revList() walks the commits-only closure at its own default tier, Then measure tsgit` |
| `When packObjects() computes the closure at its own default (a usable bitmap), Then measure tsgit` | `When packObjects() answers the objects closure from its default bitmap tier, deltifies and writes the pack, Then measure tsgit` |
| — | `When computeClosure({ objects: true, tier: 'walk' }) walks the full objects closure, Then measure tsgit` |
| — | `When computeClosure({ objects: true, tier: 'bitmap' }) answers the full objects closure from the bitmap, Then measure tsgit` |

Scenario titles are the `gh-pages` snapshot series keys (`tooling/bench-to-snapshot.ts:63-66`,
`"<group fullName> > <bench name>"`): two series end, four start; `bench-check` reports the old
keys `missing` and the new `new` (`bench-check.ts:51,76-79`) — non-blocking (`benchmark-compare`
is `continue-on-error`; `docs/perf/hot-paths.json` names no closure row). The PR body says so.

**New `test/bench/closure-wide-tree.bench.ts`.** In-process synthetic fixture (the
`setupBitmapClosureFixture` pattern: `openRepository().init()`, then a raw `Context` writing
objects through `writeObject`/`writeTree`/`createCommit` — loose is acceptable, the subject is the
CPU-bound warm closure; never `git`, never the shared cache): 40 directories × 50 files = 2 000
blobs; 300 commits, each rewriting one file in one directory round-robin. Distinct work per commit
after the prune ≈ 1 root (40 entries) + 1 subtree (50) + 1 blob ≈ 91 entry visits vs ≈ 2 040
before (root + every subtree re-descended). Rows: `computeClosure({ objects: true, tier: 'walk' })`
at 100 and 300 commits. The oracle is **absolute time on the 300-commit row, main vs branch**
(`bench:ab`; expect ≈ 10–20× lower). The 100/300 pair documents the shape: both trees scale ≈ 3×
because the root and the changed subtree are per-commit work in git too — linear with a small
slope, not flat (correction 9).

**`name-rev` many-tag arm** (`test/bench/name-rev.bench.ts`): an in-process scratch repository
(200 commits, 200 lightweight tags spread over the history; shared cached fixtures are read-only
for benches) — `When name-rev() names a commit under 200 tags, Then measure tsgit`.

**Non-regression rows read through `npm run bench:ab -- main perf/closure-history-walks 2`**
(`tooling/bench-ab.ts`: two detached worktrees, alternating rounds, best-of-rounds per side):
`log()` medium, `log()` via commit-graph, `describe()`, `name-rev()`, `maintenance gc`, and the
closure rows above. `docs/perf/baseline.*` is **not** regenerated (Part 0 owns it; workload set
unchanged).

---

### Empirical pin matrix

All probes: `git version 2.55.0`, `mktemp -d` throwaway (`/tmp/tsgit-pin-4YT3kS`), every `GIT_*`
scrubbed, `HOME` isolated, `GIT_CONFIG_NOSYSTEM=1`, `commit.gpgsign=false`, `tag.gpgsign=false`,
deterministic `GIT_AUTHOR_DATE`/`GIT_COMMITTER_DATE`, `gc.writeCommitGraph=false`. Git source
quotes are from the `v2.55.0` tag (`commit-reach.c`, `builtin/name-rev.c`, `builtin/blame.c`,
`line-range.c`, `list-objects.c`, `send-pack.c`, `commit-graph.c`, `commit.h`).

#### P1 — `rev-list --objects` on shared subtrees (4 commits: c0 adds `a/{one,two}`, `b/one`; c1 edits `a/one`; c2 adds `b/two`; c3 empty)

`git rev-list --objects HEAD` (raw, git's order — commits first, then per commit newest-first, `SEEN` skipped):

```
6cfc0592218947b3d619b59939ba5e613665126d
db9b60f9dc18d871301204d380db8c696a7bcfdf
ff0cd82d95238d5ae32ab7f7a02d28811838b083
1fca2c18b246298fe0ce103bfe3648a7ffa52ef7
372ae389ff622ca4a3f50773ead32bbf17ba5d2a 
636c8321ee1bf2d78b4d65245cf180f09920e3d0 a
1cfc4dc0fcc27c21a8a0756eb2f833cdd7b1a934 a/one
c1827f07e114c20547dc6a7296588870a4b5b62c a/two
e5d9693f1a0c873e9606b043f2a0df2ab1e5ef55 b
c9c6af7f78bc47490dbf3e822cf2f3c24d4b9061 b/one
e6bfff5c1d0f0ecd501552b43a1e13d8008abc31 b/two
5c6c2f923b0e8ac7db0de7e44d6fb3d632ade09e 
ada2bddbe02c7ef8203f0da2ab20bff79fa85903 b
96f2db6ce79037b8cd6a148daa052ad73e80500d 
8cca9a1dd4d57fc9079274cdea471f5a40cbdbcd a
da0f8ed91a8f2f0f067b3bdf26265d5ca48cf82c a/one
```

16 objects: 4 commits, 7 trees, 5 blobs. `git rev-list --objects HEAD | cut -d' ' -f1 | sort` =
the 16 oids above sorted. **tsgit today** (`dist-profile` bundle built on `1f84254c`, `revList({
wants: ['HEAD'], objects: true })` through `fs-count.cjs`): 16 entries, the **same sorted oid
set**, fs calls `{ lstat: 2, readFile: 17, readdir: 11, stat: 16 }` — one `stat .git/config` per
`walkTree` already visible at 4 commits. tsgit's emitted sequence (the "before" list the prune must
reproduce exactly — id, type, path):

```
6cfc0592 commit · 372ae389 tree "" · 636c8321 tree a · 1cfc4dc0 blob a/one · c1827f07 blob a/two ·
e5d9693f tree b · c9c6af7f blob b/one · e6bfff5c blob b/two · db9b60f9 commit · ff0cd82d commit ·
5c6c2f92 tree "" · ada2bddb tree b · 1fca2c18 commit · 96f2db6c tree "" · 8cca9a1d tree a ·
da0f8ed9 blob a/one
```

Under the prune: c2's root `372ae389` is already emitted (short-circuit); in c1's root the entry
`a` = `636c8321` is skipped (its blobs are emitted), `b` = `ada2bddb` is entered and `b/one` is
rejected; in c0's root `a` = `8cca9a1d` is entered, `b` = `e5d9693f` is skipped. Surviving sequence
identical. With a `not` side (`HEAD ^HEAD~2`) git emits `6cfc0592 db9b60f9 372ae389 "" e5d9693f b
e6bfff5c b/two` — the over-report shape ADR-618 documents (`b` re-emitted because c1's tree was
never marked).

#### P4 — a commit whose tree equals its parent's (c3 = `commit --allow-empty` on c2)

`rev-parse HEAD~1^{tree}` = `rev-parse HEAD^{tree}` = `372ae389ff622ca4a3f50773ead32bbf17ba5d2a`;
that oid appears **once** in `git rev-list --objects HEAD` (under c3, the first encounter). tsgit's
`emitTree` for c2 short-circuits on `emitted.has(root)`.

#### P2 — merge-base / name-rev with and without a commit-graph

History (`main` m0–m4 with a `--no-ff` merge of `side`; `side` s0–s3 forked from m1; `topic` = t0
on `side~2`; annotated `v1.0` on `main~2`, lightweight `light` on `side`):

| Command | Without graph | After `git commit-graph write --reachable` (1 772-byte file, `CGPH` v1, `commit-graph verify` exit 0) |
|---|---|---|
| `merge-base main topic` | `bde7cc71322aecd2a621be06fcd7e51d57f83840`, exit 0 | identical |
| `merge-base --all main topic` | `bde7cc71…` | identical |
| `merge-base --octopus main topic side` | `bde7cc71…` | identical |
| `merge-base --is-ancestor side main` / `main side` | exit 0 / exit 1 | identical |
| `name-rev --name-only side~1` | `tags/light~1` | identical |
| `name-rev --name-only --tags side~1` | `light~1` | identical |
| `name-rev --name-only --refs='refs/heads/*' side~1` | `side~1` | identical |
| `name-rev --name-only main~3` | `tags/v1.0~1` | identical |
| `name-rev --name-only <root>` | `tags/v1.0~3` | identical |
| `describe --contains side~1` | `light~1` | identical |

#### P5 — criss-cross (A; B on `b1`; C on `main`; `d1` = C with `b1` merged in; `e1` = B with `main` merged in)

Bases of `d1`/`e1` are `B = d5169463…` (date 1700000100) and `C = f1123af6…` (date 1700000200).

| Command | Without graph | With graph |
|---|---|---|
| `merge-base d1 e1` | `f1123af60b53751ca2e82884e3ff12435c1d8b0a` (**C, the newest**) | identical |
| `merge-base --all d1 e1` | `f1123af6…` then `d5169463…` (date-sorted, newest first) | identical |

Lexicographic order puts `d5169463…` (B) first — tsgit's ADR-191 rule returns **B** here; git
returns **C**. `show_merge_base` prints the head of `commit_list_sort_by_date`'s result
(`builtin/merge-base.c`; `commit-reach.c:189,236`). DC-10.

#### P3 — `blame -L` (file `f`: 5 lines; b0 all lines, b1 rewrites line 2, b2 rewrites line 4)

| Command | Output / refusal | Exit |
|---|---|---|
| `blame -L 2,4 --porcelain f` | three entries, headers `e67d6b21… 2 2 1`, `76d8bfec… 3 3 1` (+`boundary`), `b5519a32… 4 4 1`; absolute line numbers; full author/committer/summary/previous/filename blocks | 0 |
| `blame -L 3,100 -s f` (end past EOF) | lines 3, 4, 5 (clamped) | 0 |
| `blame -L 6,7 f`, `blame -L 6,6 f` (start beyond EOF) | `fatal: file f has only 5 lines` | 128 |
| `blame -L 4,2 -s f`, `blame -L 5,3 -s f` (start > end) | **swapped**: lines 2–4 / 3–5 | 0 |
| `blame -L 0,3 -s f` | `fatal: -L invalid line number: 0` | 128 |
| `blame -L -1,3 -s f` | `fatal: -L invalid line number: -1` | 128 |
| `blame -L 1,0 -s HEAD~2 -- f` (end of 0) | `fatal: -L invalid line number: 0` | 128 |
| `blame -L 3,3`, `-L 5,5` | one line | 0 |
| `blame -L 2,4 -s HEAD~2 -- f` (older rev) | lines 2–4 all `^76d8bfe` | 0 |
| `blame -L 1,3 --porcelain g` after `git mv f g` | entries carry `filename f` (rename-aware) | 0 |
| `blame -L 1,1 e` (empty file) | `fatal: file e has only 0 lines` | 128 |
| `blame e` (empty, no range) | no output | 0 |
| `blame -L 2,4 --porcelain g` with an uncommitted edit on line 3 (worktree mode) | `e67d6b21… 2 2 1`, `0000000000000000000000000000000000000000 3 3 1`, `b5519a32… 4 4 1` | 0 |

#### Git source mechanisms cited (v2.55.0)

- **G1** `commit-reach.c:100-191` `paint_down_to_common(r, one, n, twos, min_generation, mb_flags, result)`:
  queue `{ compare_commits_by_gen_then_commit_date }`; `if (!min_generation && !corrected_commit_dates_enabled(r)) queue.pq.compare = compare_commits_by_commit_date;`
  … `while (queue.max_nonstale) { commit = nonstale_queue_get_dedup(&queue); generation = commit_graph_generation(commit); if (min_generation && generation > last_gen) BUG(…); last_gen = generation; if (generation < min_generation) break; …`
  Callers: `merge_bases_many` `:226` passes `0`; `remove_redundant_no_gen` `:291-308` passes
  `min_generation` = minimum `commit_graph_generation` over the array; `remove_redundant` `:458-480`
  picks `_with_gen` when `generation_numbers_enabled(r)` and any candidate has a finite generation;
  `repo_in_merge_bases_many` `:602-625` passes the commit's own generation and returns early when
  it exceeds every reference's. `commit.c` `compare_commits_by_gen_then_commit_date`: higher
  generation first, then newer date, else 0 (prio-queue insertion order).
- **G2** `builtin/name-rev.c:41-42` `static timestamp_t generation_cutoff = GENERATION_NUMBER_INFINITY; static timestamp_t cutoff = TIME_MAX;`
  `:53-65` `set_commit_cutoff`: `cutoff = min(cutoff, commit->date)`; `if (generation_cutoff) generation_cutoff = min(generation_cutoff, commit_graph_generation(commit))`.
  `:70-79` `adjust_cutoff_timestamp_for_slop` (`CUTOFF_DATE_SLOP 86400`, underflow guard).
  `:84-91` `commit_is_before_cutoff`: `if (generation_cutoff < GENERATION_NUMBER_INFINITY) return generation_cutoff && commit_graph_generation(commit) < generation_cutoff; return commit->date < cutoff;`
  `name_rev`: `if (commit_is_before_cutoff(start_commit)) return;` and per parent `if (commit_is_before_cutoff(parent)) continue;` before `create_or_update_name`.
- **G3** `commit-graph.c:126-135` `commit_graph_generation`: `if (data && data->generation) return data->generation; return GENERATION_NUMBER_INFINITY;`
  `commit.h:12-15` `GENERATION_NUMBER_INFINITY ((1ULL << 63) - 1)`, `GENERATION_NUMBER_ZERO 0`.
- **G4** `list-objects.c:149-199` `process_tree`: `if (obj->flags & (UNINTERESTING | SEEN)) return;` … then the filter result's mark-seen bit sets `obj->flags |= SEEN` (the default filter always sets it); `process_tree_contents` (`:100-147`) skips gitlinks.
- **G5** `send-pack.c:45-55` `feed_object(r, oid, fh, negative)`: `if (negative && !odb_has_object(r->objects, oid, 0)) return;` — callers `:104-112` feed advertised/negotiated oids and each ref's `old_oid` as negatives, `new_oid` positive.
- **G6** `builtin/blame.c` `cmd_blame` `-L` block: `lno = sb.num_lines; … if ((!lno && (top || bottom)) || lno < bottom) die(Q_("file %s has only %lu line", "file %s has only %lu lines", lno), sb.path, lno); if (bottom < 1) bottom = 1; if (top < 1 || lno < top) top = lno; bottom--; range_set_append_unsafe(&ranges, bottom, top); … for (range_i = ranges.nr; range_i > 0; --range_i) { ent = blame_entry_prepend(ent, r->start, r->end, o); …}`
  `line-range.c` `parse_loc`: `if (num <= 0) die("-L invalid line number: %ld", num);` `parse_range_arg`: `if (*begin && *end && *end < *begin) { SWAP(*end, *begin); }`

---

## Decision candidates

The brief expects no ADR-level decision; probing every load-bearing choice still leaves the
following, each with a recommendation. Rejected candidates (not decisions) follow the table.

| # | Choice | Alternatives (≤3) | Recommendation | Why |
|---|---|---|---|---|
| DC-1 | Where `skipTree` lives | (a) optional member on public `WalkTreeOptions` (api.json + `walk-tree.md` row); (b) an internal-only options type consumed by a second entry point (`walkTreeInternal`); (c) an emit-aware tree walker duplicated inside `closure-engine.ts` | **(a)** | Smallest diff; git's `SEEN` prune is a legitimate consumer need; (b) forks a public/internal signature pair, (c) duplicates 280 lines of guarded traversal. |
| DC-2 | Prune predicate | (a) `emitted.has(id)` (brief's text); (b) `emitted.has(id) \|\| marked.has(id)` (git's `UNINTERESTING \| SEEN`) | **(b)** | Output-identical either way (equivalence argument covers both); (b) also stops descending uninteresting subtrees on every `not`-bearing closure (push, `--not`). |
| DC-3 | `until` widening | (a) union `ReadonlyArray \| ReadonlySet` on both `WalkCommitsOptions` and `WalkCommitsByDateOptions`; (b) set-only replacement (breaking, every array caller changes); (c) `walkCommits` only | **(a)** | Non-breaking, removes every `[...set]` round trip, symmetric across the two public walks; (c) leaves `commitDateWalk`'s `new Set(options.until ?? [])` inconsistent. |
| DC-4 | `CommitMeta.generation` when no graph serves the commit | (a) `GENERATION_INFINITY = Number.POSITIVE_INFINITY` (git's `GENERATION_NUMBER_INFINITY` role, incl. graph value 0); (b) `generation?: number` optional; (c) `{ source: 'graph' \| 'object' }` discriminant | **(a)** | Both cutoffs are literal transcriptions when infinity is a number (`x < Infinity`, `Infinity < Infinity`); (b)/(c) push `undefined` branches into every comparator and comparator mutants multiply. |
| DC-5 | merge-base heap comparator with a graph | (a) generation-then-date always (degenerates to today's date order without a graph); (b) replicate git's switch exactly (`minGeneration === 0 && !correctedDates` → date only), needing a graph-metadata probe on `readCommitMeta` | **(a)** | Required whenever `minGeneration > 0`; the only observable difference from (b) is traversal order in the main paint on a GDA2-less graph — results are order-independent; (b) adds surface for no result change. |
| DC-6 | name-rev cutoff semantics with a graph | (a) git's rule: generation **replaces** the date test when the target has a generation (`commit_is_before_cutoff`); (b) the brief's "alongside": prune when either test says so | **(a)** | (b) is not git's mechanism; on skewed clocks it prunes commits git visits and can name differently. Recorded as a candidate only because the brief's wording differs from the source. |
| DC-7 | Absent `haves` for push's `not` side | (a) `hasObject` pre-filter in `push.ts` (git's `feed_object`, send-pack side); (b) engine-level `ignoreMissingNot` tolerance inside `markNotSide` | **(a)** | Places the rule where git places it; keeps `computeClosure` strict for `rev-list`/`pack-objects` where an absent `not` is a user error git refuses. |
| DC-8 | push closure tier | (a) `'bitmap'` (git's `pack-objects` default, exact difference when a bitmap is usable, silent walk fallback); (b) `'walk'` | **(a)** | ADR-618 per-command rule: `push` runs `pack-objects --revs`, whose default is the bitmap. |
| DC-9 | `blame -L` with `end < start` | (a) swap like git (`parse_range_arg` SWAP; P3 `-L 4,2` = `-L 2,4`) — removes the `range end … precedes start …` refusal, updates `BlameOptions.range` doc + `blame.md:88-89`; (b) keep the refusal as a recorded divergence (needs an ADR line); (c) defer to a separate item | **(a)** | Faithfulness (ADR-226); the range code is rewritten anyway; the interop matrix pins it directly. |
| DC-10 | `mergeBase` single-result rule (P5: git prints the newest base; ADR-191 picks the lexicographically smallest) | (a) fix in this PR — newest committer date first, ties in RESULT-discovery order (git's `commit_list_sort_by_date` over the paint's append order), superseding ADR-191, pinned by a criss-cross interop; (b) separate backlog item, this PR pins `--all` set equality only and asserts the single result where unique; (c) keep ADR-191 as a recorded divergence | **(a)**, with its own ADR | It is a faithfulness defect found by this design's pin, the paint is being touched anyway, and the default is "everything rides in the current PR"; (b) is the honest fallback if the user wants the perf PR behaviour-preserving to the letter. |

**Rejected candidates — not decisions:**

- *Where `readCommitMeta` lives* — `primitives/internal/` is the brief's text and the existing home
  of `read-commit.ts`/`read-commit-graph.ts`; commands already import `primitives/internal`
  (`name-rev.ts:24-25`).
- *One shared `min_generation` helper vs two local ones* — git's two mechanisms differ (a
  queue-order break vs a per-parent predicate); one abstraction would invent structure git does not
  have. Both consume `readCommitMeta`; nothing else is shared.
- *How the `maxTreeDepth` hoist is threaded* — `NotMarks.maxDepth` and `WalkTreeOptions.maxDepth`
  already exist; passing one to the other is the whole change.
- *`DateWalkStep` shape* — ADR-460 fixed it; the fast path keeps it and hoists only the closure.
- *Wide-tree bench fixture source* — in-process synthetic (no git, no shared-cache mutation) is
  the only shape compatible with the read-only fixture rule.
- *`enumeratePushObjects` deletion* — 31.6's by the backlog's own wiring.

---

## Test strategy

House rules: `describe('Given …')` › `describe('When …')` › `it('Then …')`, AAA, `sut`; 100 %
coverage; every error assertion checks `data` (code + reason/message); guard clauses tested in
isolation; no ignore directives. No parser/serializer/matcher is touched, so the four property-test
lenses do not fire (the blame window resolver is a total function over small integers — a
parameterised example sweep is the clearer proof).

### Unit, per item (mutation-resistant shape)

| Item | Tests (file) | Kill shape |
|---|---|---|
| (a) `skipTree` | `walk-tree.test.ts`: predicate called once per directory entry with the entry id, **before** the yield (a consumer that mutates a set on yield must not change descent); `true` → entry yielded, subtree not entered (no `readObject` for it — `instrumentedContext`); `false`/absent → today's behaviour; counter (`maxEntries`) counts only visited entries. `closure-engine.test.ts`: shared-subtree repo → exact ordered entry list (id/type/path/nameHash) equal to a literal captured on `main` **before** the change; a `not`-marked subtree is not descended; root already emitted → no walk (read count); `PACK_TOO_LARGE` fires at the same emit with a tiny cap; `TREE_DEPTH_EXCEEDED` tests at `:706-800` unchanged. | Pre-yield vs post-yield mutant kills itself (all blobs vanish); `\|\|`→`&&` in the predicate leaves marked subtrees descended → read-count assertion; dropped root short-circuit → read count. |
| (a) pack bytes | `pack-objects.test.ts` (or `build-pack.test.ts`): synthetic repo with shared subtrees, `buildPack(closure.objects, { delta: true }).sha` equals a literal captured on `main`. | Any ordinal/`nameHash` drift changes the SHA. |
| (b) hoist | `closure-engine.test.ts`: `resolveMaxTreeDepth` spied → called exactly once per `computeClosure` with `objects: true` over N commits; `seedMaxTreeDepth(ctx, '4')` refusal tests unchanged. | Count assertion. |
| (c) push | `push.test.ts`: `computeClosure` receives `not` = advertised oids that exist locally only (zero-oid and foreign tips filtered), `tier: 'bitmap'`, `objects: true`; pushed oid list excludes objects reachable from a present have; `:595` still sees plain `{ id }`. | Filter mutant → `OBJECT_NOT_FOUND` surfaces; tier mutant → argument assertion. |
| (d) cursor | `walk-commits.test.ts`: the three existing overflow tests + the two head-cursor tests in D4. | Bound on `length` instead of `length − head` fails the `k > 0` test. |
| (e) buffer/until | `closure-engine.test.ts`: `markBoundaryTrees` receives `{ id, tree, parents }`; a boundary discovered by a later commit still gates an earlier tree (existing over-report tests). `walk-commits.test.ts` / `walk-commits-by-date.test.ts`: `until` as a `Set` and as an array give identical yields; the set is used by reference (mutating it before iteration starts is observed — pins the no-copy path). | Copy-vs-reference mutant. |
| (f) `readCommitMeta` | new `read-commit-meta.test.ts`: graph hit (parents/date/generation from `writeCommitGraph`), graph value 0 → `GENERATION_INFINITY`, graph miss → object read + graft (shallow file), non-commit → `undefined`, missing → `OBJECT_NOT_FOUND`; `commitMetaOf` reads no object. `merge-base.test.ts`/`bisect-midpoint.test.ts`/`name-rev.test.ts`: results unchanged with and without a graph; **zero** `objects/` reads after the graph load (`instrumentedContext`). | Each branch isolated. |
| (g) merge-base | `merge-base.test.ts`: `paint` pops in generation order with a graph (a skewed-date fixture where date order and generation order differ); `removeRedundant` breaks at the min generation (read count stops growing); `mergeBasesMany` passes 0 (no break even when generations are finite); no graph → identical reads/results as today. | Comparator mutants via the skewed fixture; break-condition mutants via read counts. |
| (g) name-rev | `test/unit/domain/name-rev/cutoff.test.ts`: `commitIsBeforeCutoff` truth table over `{generation finite/∞} × {cutoff generation finite/∞} × {date below/above}`; `name-rev.test.ts`: with a graph a parent below the target's generation is not expanded (read count), a graph-absent parent is; ADR-464's read-count pins hold. | Branch mutants via the table. |
| (h) blame | `blame.test.ts`: P3 matrix as parameterised cases over committed and worktree seeds: window, clamp, swap (DC-9), each refusal with its exact message and `data.option === '-L'`, empty file with/without range, staged-new file with a range. | Message assertions, check-order (a `-L 0,9` on a 5-line file must say `invalid line number: 0`, not `has only 5 lines`). |
| (i) date walk | `commit-date-walk.test.ts`: linear history yields the same order with zero `allSettled` (spy) and a rejecting single parent rethrows; existing diamond frontier tests. | `length === 1` boundary mutants (`<= 1` swallows the empty case — assert `enqueueCommit` not called for 0 parents). |
| (j) whatchanged/range-diff | `whatchanged.test.ts`: order and `limit` preserved; `boundedMapFor` called once with the selected commits. `range-diff.test.ts` + `test/unit/domain/range-diff`: `rangeDiffEntries` over rendered patches equals today's entries; `hydrate` returns no `oldContent`/`newContent`. | Order/limit assertions. |
| (k) name-rev reader | `name-rev.test.ts`: parent reads overlap (bounded reader spy: `start` for every accepted parent before the first await), `forget` after consumption, LIFO order and `^`/`~` steps unchanged on the merge fixtures. | Missing `forget` → memo size assertion. |

### Interop (real git, `test/integration/*-interop.test.ts`)

Rules: one shared repo per `describe` built in `beforeAll`, 60 s timeout, `GIT_*` scrubbed,
`HOME` isolated, signing off (`interop-helpers.ts` `runGitEnv`), a **fresh tsgit `Context` after
every git write** (the graph and fanout caches are per session).

| Test | Pins |
|---|---|
| new `rev-list-objects-interop.test.ts` (small, separate from the 400-commit `rev-bitmap-closure-interop`) | P1 set equality on the shared-subtree shape; P4 identical-tree commit; `HEAD ^HEAD~2` over-report set equals git's. |
| new `merge-base-interop.test.ts` | P2 rows (`--all` sets, `--octopus`, single where unique); P5 criss-cross `--all` set; single result per DC-10; each run twice: no graph, then `git commit-graph write --reachable`; one arm with `repo.maintenance({ tasks: ['commit-graph'] })` writing the graph. |
| `name-rev-interop.test.ts` (extend) | Existing expectations re-run after `git commit-graph write --reachable` with a fresh `Context`. |
| `bisect-midpoint-interop.test.ts` (extend) | Existing `--bisect-vars` expectations re-run with a graph. |
| `blame-interop.test.ts` (extend) | P3 matrix: porcelain reconstruction restricted to the window; refusals as `INVALID_OPTION` + message vs git's `fatal:` line + exit 128 (`tryRunGitWithExit`). |
| `network/push-http-backend.test.ts` (extend) | After a push of one new commit on top of a shared history, `git -C bare rev-list --objects --all` grows by exactly the new commit, its tree and the changed blob (git-faithful minimal pack). |

### fs-count oracle ("zero object reads after the graph load")

Unit: `instrumentedContext(ctx)` (`fixtures.ts:246`) → `calls().filter(c => c.path.includes('objects/') && c.method !== 'exists')` after `writeCommitGraph`, asserted `toEqual([])` for the three consumers (the graph file itself lives under `objects/info/` — filter it by path, or count only `read`/`readSlice` on `objects/[0-9a-f]{2}/` and `objects/pack/`). Implementation-time: the brief's `fs-count.cjs` shim (counts `fs.promises.{stat,lstat,readFile,readdir,open,readlink,realpath}`) on `medium-commit-graph-v3` for `mergeBase`, `nameRev`, `bisectMidpoint`, recorded in the PR.

### Performance oracles (recorded, not asserted in CI)

1. `node --require ./fs-count.cjs closure-oracle.mjs` on `medium-v3`: wall-clock < 1 s (expect ~0.2 s), `stat` = O(1).
2. `packObjects` byte identity on the delta-chain fixture: two detached worktrees (`main`, the branch) sharing `node_modules`, each running `packObjects({ wants: [HEAD], outputDirectory: <tmp> })` → `cmp` the `.pack` files and compare `packId` — the `bench-ab` two-worktree shape, driven by a scratch script in the PR body.
3. Emitted entry list on `medium-v3`: `revList({ objects: true })` entries serialised on both worktrees, `diff` empty.
4. `npm run bench:ab -- main perf/closure-history-walks 2`: closure rows, `log()` (both), `describe()`, `name-rev()` (incl. the many-tag arm), `maintenance gc`. Absolute wall-clock both sides; publishable numbers only from the nightly `bench.yml` artifact.

### `Stryker disable` suppressions inside touched structures (re-prove or remove)

| File:line | Mutator | Fate |
|---|---|---|
| `closure-not-marks.ts:102` | ArrayDeclaration on `until: [...markedCommits]` | **Removed** with the literal (D5 passes the set). |
| `merge-base.ts:27-30` | all — memo | Re-proven against the `CommitMeta` memo (same argument) or removed if the memo is dropped. |
| `merge-base.ts:46-49` | all — `hasNonStale` | Unchanged line; re-run under the new comparator. |
| `merge-base.ts:75-78`, `:82-85` | all — STALE / re-mark skip | Unchanged lines inside a changed loop (new `break`): re-run; the break must be killable (read-count test), never suppressed. |
| `merge-base.ts:109-112` | all — `removeRedundant` fast path | Unchanged; re-run (the function now computes `minGeneration`). |
| `bisect-midpoint.ts:37`, `:42`, `:81`, `:94` | Conditional / Equality / Update | Structures unchanged (`readCommitEntry` body only); re-run. |
| `blame.ts:195`, `:285` | ConditionalExpression — empty-file returns | Re-proven with the window resolved **before** them; the argument ("zero-count entry yields no lines") still holds only for the no-range path — restate. |
| `blame.ts:314`, `:508`, `:521` | ConditionalExpression | Untouched structures; re-run. |
| `walk-commits-by-date.ts:51`, `:53` | Conditional / BooleanLiteral | Untouched; re-run. |
| `describe.ts:280` | ArrowFunction, ConditionalExpression on `step.frontier().every(...)` | Untouched consumer of a hoisted closure; re-run. |
| `enumerate-push-objects.ts:69` | ObjectLiteral | File untouched (no longer on push's path). |
| `name-rev` domain `cutoff.ts:16` | EqualityOperator on the slop boundary | The slop rule is kept verbatim inside `nameRevCutoff`; re-prove at its new position. |

Local Stryker: `--concurrency 3`, `.stryker-tmp` cleared before a long run, `static: true` mutants
checked before writing kill tests; ranges from `git diff main` (working-tree-inclusive).

### Docs consequences

For the docs phase (sourced from this doc): `docs/use/primitives/walk-tree.md` (`skipTree` row;
`maxEntries` counts visited entries), `docs/use/primitives/walk-commits.md` and
`walk-commits-by-date.md` (`until` type; the stale `from?`/`excluding` signature block in
`walk-commits.md` is pre-existing drift), `docs/use/commands/blame.md:88-89` (DC-9),
`docs/use/commands/push.md:102` + `docs/use/primitives/internals.md` (`push` no longer uses
`enumeratePushObjects`; 31.6 deletes it), `docs/use/primitives/merge-base.md:5` (DC-10),
`docs/use/commands/rev-list.md` / `pack-objects.md` tier wording **unchanged** (the prune changes
no tier). `reports/api.json` regenerated for `until` and `skipTree`. Backlog 31.1 ticked by the
docs phase with the design/ADR suffix only.

---

## Out of scope

- **31.2's general `readConfig` staleness fix** (one stat per sequential read) — this item hoists
  the one resolution the closure needs; every other per-read stat stays for 31.2.
- **31.6's `enumeratePushObjects` deletion and `delta: true` for push** — D3 removes push's use;
  the export, its test and its `internals.md` entry stay until 31.6.
- **`remove_redundant_with_gen`** — git's alternative reduction algorithm; `_no_gen` + git's
  `min_generation` yields the same reduced set (D7).
- **`repo_in_merge_bases_many`'s generation early exit** — tsgit has no `isAncestor` surface here.
- **tsgit's total not-side ancestry walk** (`markCommitAncestry`) vs git's slop-limited
  uninteresting walk — pre-existing engine behaviour, documented in `closure-not-marks.ts`.
- **`walk-commits.md`'s stale signature block** — pre-existing drift; flagged, not owned here.
- **Everything the review lists under "Leave alone (verified healthy)"**: `BinaryHeap`, the
  byte-level commit parser, `emitInArtefactPositions`, `reconstructEntry`, `rev-list`'s tier
  default, `hasNonStale`'s linear scan (git's `nonstale_queue` is a constant-factor variant),
  blame's whole-directory scan (pinned faithful: git refuses `rev-parse <tree>:aaa` when a
  `10064a`-mode sibling follows).
- **`enumerate-bundle-objects.ts`** — already prunes on `seenTrees` and hoists `maxDepth`
  (correction 3); its `until: [...uninteresting.commits]` may take the set under D5 but nothing
  requires it.
- **`docs/perf/baseline.*` regeneration** — Part 0 owns it; the workload set does not change.
- **F2–F11, F13, F14 of the review** — 31.2–31.6.
