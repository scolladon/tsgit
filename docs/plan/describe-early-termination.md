# Plan — describe early termination

> Source: design doc `docs/design/describe-early-termination.md` · ADRs `460`
> The plan is the implementation script AND the knowledge handoff. Part agents start
> with zero context: whatever a part block omits is paid later as agent rediscovery.

## Part 1 — walk core yields frontier-aware steps

### Context

- `src/application/primitives/internal/commit-date-walk.ts` (113 lines): internal
  date-ordered walk. State `DateWalk = { queue: QueueEntry<Commit>[], seen: Set<ObjectId>,
  until: Set<ObjectId>, reader, firstParent, ignoreMissing }` (read the file for exact
  fields). Loop shape: `while (walk.queue.length > 0) { abort check → const entry =
  shift() → yield entry.value → shallow check → await enqueueParents(walk, commit) }`.
- `QueueEntry<T>` (`src/domain/commit/priority-queue.ts`) carries `.oid` and `.value`;
  the queue is a date-sorted array — `walk.queue.map(e => e.oid)` is the frontier.
- Change the yield to a step object per ADR-460:
  `export type DateWalkStep = { readonly commit: Commit; readonly frontierEmpty: boolean;
  readonly frontier: () => ReadonlyArray<ObjectId> }`.
  `frontierEmpty` = `walk.queue.length === 0` sampled AFTER the shift and BEFORE the
  yield (git's `!list` position at cond 2 — load-bearing). `frontier` is a lazy snapshot
  closure over `walk.queue` (documented: valid until the iterator resumes).
- `src/application/primitives/walk-commits-by-date.ts` (33 lines) currently
  `yield* commitDateWalk(...)` — becomes a `for await` projecting `step.commit`.
  Public signature `walkCommitsByDate(ctx, options): AsyncIterable<Commit>` UNCHANGED
  (no api.json churn).
- `src/application/commands/describe.ts` `selectNearest` (~line 250) iterates
  `for await (const commit of commitDateWalk(...))` — destructure the step
  (`const { commit } of ...`) in this part; break logic comes in parts 2–3.
- Tests: `test/unit/application/primitives/internal/commit-date-walk.test.ts` (164
  lines, GWT + AAA + `sut`) asserts yielded commits — update to steps; add cases for
  `frontierEmpty` (linear chain: true at every step; diamond: false while both legs
  queued) and `frontier()` contents at a mid-walk step.

### TDD steps

1. RED: in `commit-date-walk.test.ts` — Given a linear chain c3→c2→c1, When walking
   from c3, Then each step's `frontierEmpty` is true and `frontier()` is empty
   (parents enqueue only after resume). Fails: steps are bare commits.
2. RED: Given a two-parent merge m(p1, p2), When walking from m, Then the step for the
   newer parent has `frontierEmpty === false` and `frontier()` equals `[olderParentOid]`.
3. GREEN: introduce `DateWalkStep`, sample `frontierEmpty` post-shift, yield the step;
   project `.commit` in `walkCommitsByDate`; destructure in `selectNearest`.
4. REFACTOR: keep functions <20 lines; run full touched-test sweep.

### Gate

npx vitest run test/unit/application/primitives/internal/commit-date-walk.test.ts test/unit/application/primitives/walk-commits-by-date.test.ts test/unit/application/commands/describe.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/internal/commit-date-walk.ts src/application/primitives/walk-commits-by-date.ts src/application/commands/describe.ts test/unit/application/primitives/internal/commit-date-walk.test.ts

### Commit

refactor: yield frontier-aware steps from commit date walk

## Part 2 — cond-2 break in the collection loop

### Context

- `src/application/commands/describe.ts` `selectNearest` (~lines 230–300). Current
  collection branch (winner undefined): freeze check → `nameMap.get(oid)` → candidate
  push (`candidates.push({ name, commitOid, depth: counter - 1, foundOrder: index })`
  + `reachSet(reach, oid).add(index)`) or `sawUnannotated = true` → then
  `incrementUnreached(candidates, reach.get(oid))` → `propagateReach(reach, commit,
  plan.firstParent)`.
- Add `annotatedCount`, incremented at candidate push when `named.priority === 2`
  (mirrors git's `annotated_cnt`; priority comes from `buildNameMap` — 2 = annotated
  tag). Lightweight candidates (priority 1 under `--tags`) never satisfy it.
- After `propagateReach`, add git's cond-2 (verbatim semantics in
  `docs/design/describe-early-termination.md` §Break 1):
  `if (annotatedCount > 0 && step.frontierEmpty && coveredByAllMinDepth(candidates,
  reach.get(oid))) break`.
- New helper `coveredByAllMinDepth(candidates, reached)` (<20 lines, early returns):
  min depth over `candidates`, then every candidate at that depth has its `foundOrder`
  in `reached`. `reached` may be undefined → false (unless candidates empty — cannot
  happen: annotatedCount > 0 implies a candidate).
- Read-count tests in `test/unit/application/commands/describe.test.ts`: build repos
  with `createMemoryContext` + `init`/`commit`/`tagCreate` (existing file pattern).
  Count object reads by wrapping the context's fs with a counting proxy before calling
  `describeRun` (count reads under `objects/`); pin EXACT totals (mutation-resistant).
  - Given a 30-commit chain with an annotated tag 3 commits below HEAD, When describing
    HEAD, Then the result is byte-stable (`tag-3-g<oid>` fields) AND commit reads stop
    at the tag+1 window (assert the exact count, far below 30).
  - Given only a lightweight tag on the same chain (no `--tags`), Then description
    fails as today (no candidates — unchanged path).
  - Given `--tags` with only lightweight tags, Then the walk does NOT terminate early
    (annotatedCount stays 0; exact full-chain read count).
  - Given two annotated tags tied at min depth on two merge legs, When the popped
    commit is reachable from only one of them, Then no early break (ADR-276 `ay-2`
    counter-example; assert full read count).

### TDD steps

1. RED: exact-read-count test for the 30-chain near-tag scenario (fails: walk reads all
   30 commits).
2. GREEN: `annotatedCount` + `coveredByAllMinDepth` + the break.
3. RED→GREEN: lightweight-only `--tags` no-break test; tied-min-depth no-break test
   (each guard condition isolated — mutation-resistant).
4. REFACTOR: extract helpers if the branch exceeds sizing rules.

### Gate

npx vitest run test/unit/application/commands/describe.test.ts test/unit/application/primitives/internal/commit-date-walk.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/commands/describe.ts test/unit/application/commands/describe.test.ts

### Commit

perf: stop describe collection at covered last path

## Part 3 — covered-frontier break in winner finalisation + differential property

### Context

- `selectNearest` post-freeze branch: `if (winner !== undefined) {
  finishWinner(reach, commit, winner, plan.firstParent); continue; }` and the freeze
  arm that assigns `winner` then calls `finishWinner`. `finishWinner` =
  `incrementUnreached([winner], reach.get(commit.id))` + `propagateReach`.
- After each `finishWinner` call (both arms), add git's finish-depth break (design doc
  §Break 2, ADR-460 decision 3 — lazy scan): when the popped commit is winner-covered
  (`reach.get(commit.id)?.has(winner.foundOrder)`), scan `step.frontier()`; if every
  queued oid's reach set contains `winner.foundOrder`, break. Early-exit the scan at
  the first uncovered oid. Extract as `frontierCovered(reach, winner, step)` (<20
  lines).
- Read-count example tests (same counting-proxy pattern as part 2):
  - Given a merge where the winner tag sits on one leg and the other leg is a long
    uncovered chain, When describing, Then the walk continues past the merge (frontier
    uncovered) and stops exactly when the frontier becomes winner-covered (exact
    count).
  - Given 11 annotated tags (maxCandidates 10 freeze) on a deep chain, Then
    finalisation stops early after the freeze (exact count, far below chain length).
- Differential property (ADR-460 decision 4): new
  `test/unit/application/commands/describe.properties.test.ts` + shared
  `test/unit/application/commands/arbitraries.ts` (new file — per-family generators,
  ADR-134/135 layout). Arbitrary: DAG of N∈[2,12] commits (each commit's parents = 1–2
  distinct earlier commits; strictly increasing committer timestamps so date order is
  deterministic); K∈[1,4] ANNOTATED tags on distinct commits; target = newest commit;
  constrain to a UNIQUE minimum-depth tag (filter) where depth(tag) =
  |reachable(target) \ reachable(tagCommit)| computed by plain BFS over the generated
  model (independent oracle — never calls src walk code). Property: `describeRun`
  returns that tag's name with that depth (and `distance === 0` exact-match case falls
  out naturally when the min-depth tag sits on the target). K ≤ 4 < maxCandidates 10 →
  no freeze; breaks 1–2 still exercised. numRuns 50 (filter-heavy). Same GWT/AAA/`sut`
  conventions; never commit a seed.
- Build the arbitrary's repos through `createMemoryContext` + `init`/`commit`
  (deterministic timestamps via commit options — read how `describe.test.ts` pins
  committer dates) + `tagCreate` with annotation message.

### TDD steps

1. RED: merge-topology read-count test (fails: finalisation walks to root).
2. GREEN: `frontierCovered` + break after `finishWinner` in both arms.
3. RED→GREEN: freeze-then-early-stop read-count test.
4. RED: property file + arbitraries (fails only if breaks are wrong — expected GREEN if
   parts 1–3 correct; a deliberately-broken break locally must make it fail before
   trusting it).
5. REFACTOR: dedupe any shared counting-proxy helper into the test file's local
   helpers.

### Gate

npx vitest run test/unit/application/commands/describe.test.ts test/unit/application/commands/describe.properties.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/commands/describe.ts test/unit/application/commands/describe.test.ts test/unit/application/commands/describe.properties.test.ts test/unit/application/commands/arbitraries.ts

### Commit

perf: stop describe winner finalisation at covered frontier

## Part 4 — describe bench on deep history

### Context

- Test-infra-only part (no `src/` delta) — standalone per sizing exception.
- `test/bench/log-scale.bench.ts` is the structural model (vitest bench, synthetic
  deep history on the memory adapter; read it for the fixture/builder pattern and
  bench naming conventions). Config: `vitest.bench.config.ts`; runner:
  `npm run test:bench`, reported via `bench:summary` (wireit →
  `tooling/bench-summarize.ts` → `reports/benchmarks/summary.md`).
- New `test/bench/describe.bench.ts`: linear history (match log-scale's commit count
  for comparability), one annotated tag 10 commits below HEAD; bench `describeRun`
  on HEAD. This is the `bench:summary` delta evidence the backlog entry (26.4a) pins —
  O(distance) vs the pre-change O(N).

### TDD steps

1. Write the bench (benches have no RED phase; correctness is pinned by parts 1–3).
2. Run `npm run test:bench -- describe` (or the file filter the runner supports) once
   locally to confirm it executes and records.

### Gate

npx vitest bench --run --config vitest.bench.config.ts test/bench/describe.bench.ts && npm run check:types && ./node_modules/.bin/biome check test/bench/describe.bench.ts

### Commit

test: bench describe on deep history with near tag
