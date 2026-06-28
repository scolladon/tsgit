# Plan — Bisect Midpoint Primitive

> Source: design doc `docs/design/bisect-midpoint-primitive.md` · ADRs `429, 430`
> The plan is the implementation script AND the knowledge handoff. Part agents start
> with zero context: whatever a part block omits is paid later as agent rediscovery.
> `plan-lint.sh` enforces the schema below — the plan phase cannot close without it.

## Sizing rules

- Every part costs a full agent lifecycle — it must earn it. No standalone test-only
  parts for FEATURE code: coverage/interop/property tests fold into the implementation
  part whose code they exercise.
- Two parts, sequential, sharing one working tree:
  - **Part 1** lands the pure **internal** domain engine (`src/domain/bisect/`) with its
    example + property tests. Zero public surface — `findBisection` / `Bisection` /
    `BisectCandidate` / `estimateSteps` stay internal (ADR-429).
  - **Part 2** lands the **public** Tier-2 primitive `repo.primitives.bisectMidpoint`,
    wires the facade, and pre-pays every Tier-2 surface gate (barrel, facade,
    surface-snapshot test, `docs/use/primitives/` page, parity scenario, `reports/api.json`).
    Its unit + interop tests fold in here.
- Part 2 depends on Part 1's domain barrel; they are not independent.

### Public-surface decision (decided up front)

| New symbol | Where | Public or internal? | Why |
|---|---|---|---|
| `findBisection(candidates)` | `src/domain/bisect/` | **internal** | ADR-429 keeps the pure fn internal; consumers call through the primitive. |
| `estimateSteps(all)` | `src/domain/bisect/` | **internal** | derivation helper consumed by the primitive only. |
| `Bisection`, `BisectCandidate` | `src/domain/bisect/` | **internal** | domain shapes; not re-exported via `public-types.ts`. |
| `bisectMidpoint(ctx, good, bad)` | `src/application/primitives/bisect-midpoint.ts` | **public** | bound on `repo.primitives.*`; trips the Tier-2 surface-gate set (Part 2 context). |
| `BisectMidpoint` (result type) | `src/application/primitives/types.ts` | **public** | flows to the package entry via `primitives/index.ts` `export type *` → `public-types.ts` line 10. Makes `reports/api.json` stale (prepush gate). |
| `MAX_BISECT_CANDIDATES` (const) | `src/application/primitives/types.ts` | internal | guard ceiling; not a public contract. |

No new error code is added — the empty candidate set returns `undefined` (not an error), and
the `MAX_BISECT_CANDIDATES` guard reuses the existing `invalidWalkInput(...)`
(`INVALID_WALK_INPUT`) helper from `src/domain/error.js`. **`src/domain/error.ts` is NOT
touched** — no exhaustiveness-switch wiring, no error-union member.

---

## Part 1 — Pure domain bisect engine (`src/domain/bisect/`, internal)

### Context

**Goal.** Port git's `find_bisection` (`bisect.c` @ `v2.54.0`) as a pure, I/O-free domain
subsystem: given an in-memory candidate DAG, pick the midpoint and return the single raw
count (`reaches`) the primitive needs. Plus `estimate_bisect_steps`. All internal.

**Files to CREATE** (mirror the `src/domain/range-diff/` pure-subsystem layout — see
`src/domain/range-diff/index.ts` for the internal-barrel convention):

```
src/domain/bisect/
├── weight.ts          # count_distance over an in-memory candidate DAG (multi-parent union)
├── find-bisection.ts  # do_find_bisection: 3-phase weight fill + approx_halfway + best_bisection
├── estimate-steps.ts  # estimate_bisect_steps (log2 floor / 2^n)
├── bisect.ts          # findBisection orchestrator: candidates -> Bisection | undefined
└── index.ts           # internal barrel (export ONLY what Part 2 consumes)
```

The exact split of `weight.ts` / `find-bisection.ts` / `bisect.ts` is the implementer's call
(internal, not gated). The **barrel surface is fixed** because Part 2 imports from it:
`index.ts` exports `findBisection`, `estimateSteps`, and the types `Bisection`,
`BisectCandidate` — **and nothing else** (knip flags unused exports at the phase-boundary
`validate`; test-only internals like `countDistance` are imported directly from their module
file by their own test, not re-exported through the barrel).

**Domain shapes** (exact, from the design — `src/domain/objects/object-id.js` exports `ObjectId`):

```ts
/** One candidate commit, hydrated by the primitive; the domain reads no objects. */
interface BisectCandidate {
  readonly id: ObjectId;
  readonly parents: ReadonlyArray<ObjectId>; // already filtered to in-set parents
  readonly date: number;                      // committer timestamp; fixes the list order
}

/** The pure halving result. */
interface Bisection {
  readonly nextCommit: ObjectId;   // bisect_rev (the midpoint)
  readonly candidateCount: number; // all
  readonly reaches: number;        // weight(midpoint) — the load-bearing raw count
}

findBisection(candidates: ReadonlyArray<BisectCandidate>): Bisection | undefined; // undefined on empty
estimateSteps(all: number): number;
```

**Algorithm — verbatim port (ADR-430, do not re-derive):**

- **`weight(c)` / `count_distance`**: number of candidates reachable from `c` through parent
  edges *including `c` itself*; a DFS over `parents` summing in-set commits, stopping at
  out-of-set / already-counted. A **merge** unions both parents' ancestries (NOT a per-parent
  sum). Pinned: in the diamond (`all=6`) the merge `M`'s weight is **5**.
- **`findBisection` 3-phase fill** (weights become known oldest→newest by ancestry,
  independent of list iteration direction):
  1. *Seed*: candidate with 0 in-set parents → weight 1; exactly 1 in-set parent → "single
     strand, unknown"; ≥2 in-set parents (merge) → "needs walk".
  2. *Merges*: only merges get `count_distance`; each checked against `approx_halfway`
     immediately (early-return short-circuit).
  3. *Fill*: sweep; a single-strand commit whose parent's weight is known takes
     `parentWeight + 1`, checked against `approx_halfway` on the spot.
- **`approx_halfway(c)`** with `nr = all`: `diff = 2*weight(c) - nr`;
  `halfway ⇔ diff ∈ {-1, 0, 1}` (exact, small sets) `OR (nr large AND |diff| < nr/1024)`
  (~0.1% band — only reachable for huge sets; document it equivalent for the small fixtures,
  do not contrive a test unless a fixture actually hits it).
- **`best_bisection` fallback** (no short-circuit fired): pick the candidate maximising
  `distance = min(weight, all - weight)`, **strict `>`** keeps the EARLIER candidate on a tie
  (candidate-**list-order** tie-break). The diamond `A2`/`B2` distance-2 tie resolves to the
  one earlier in the list — Part 2's interop pins it to **`B2`**; here, prove the strict-`>`
  semantics with a hand-built candidate list where two entries tie and the FIRST must win.
- **`estimateSteps(all)`** (verbatim):
  ```
  if all < 3: return 0
  n = floor(log2(all)); e = 1 << n; x = all - e
  return (e < 3*x) ? n : n - 1
  ```
  Pinned table (`all → steps`): `2→0, 3→1, 4→1, 5→1, 6→2, 7→2, 8→2, 9→2`.

**Faithfulness pins (the binding goldens for `findBisection`)** — linear chain
`c0 (oldest) … c9 (newest)`, `bad = c9`; plus diamond `base → {A1,A2} ∥ {B1,B2} → M(merge) → top`.
`reaches = bisect_bad + 1`:

| topology | `good` | `all` | midpoint | `reaches` |
|---|---|---|---|---|
| linear | c0 | 9 | c4 | 4 |
| linear | c1 | 8 | c5 | 4 |
| linear | c2 | 7 | c5 | 3 |
| linear | c3 | 6 | c6 | 3 |
| linear | c4 | 5 | c6 | 2 |
| linear | c5 | 4 | c7 | 2 |
| linear | c6 | 3 | c8 | 2 |
| linear | c7 | 2 | c8 | 1 |
| linear | c8 | 1 | c9 | 1 |
| diamond | base | 6 | **B2** | 2 |
| diamond | A1,B1 | 4 | **B2** | 1 |

In domain tests the candidate sets are **hand-built `BisectCandidate[]`** (no I/O) — model the
above as small arrays. For the linear rows, a chain `cN.parents = [cN-1]` filtered to the in-set
slice (e.g. `good=c2` ⇒ candidate set is `{c3..c9}`, weights `1..7`). For the diamond, encode
`base, A1, A2, B1, B2, M, top` with the in-set parent edges; the merge `M.parents = [A2, B2]`.
The **list order** you build must reproduce git's so the `best_bisection` tie picks `B2` — the
order is pinned downstream by Part 2's interop golden; here, choose the order that yields the
`B2` pins above and add an isolated strict-`>` tie test so a `>=` mutant dies.

**Test layout** (mirror `test/unit/domain/range-diff/` which pairs `*.test.ts` +
`*.properties.test.ts` + `arbitraries.ts`):

```
test/unit/domain/bisect/
├── weight.test.ts
├── estimate-steps.test.ts
├── find-bisection.test.ts
├── find-bisection.properties.test.ts
└── arbitraries.ts            # shared fast-check generators (fast-check@4.8.0 is a devDep)
```

**Conventions (CLAUDE.md):** `describe('Given …')` > `describe('When …')` > `it('Then …')`;
AAA body with section comments; `sut` is the function under test; 100% line/branch/function/
statement; 0 surviving mutants. NO phase/ADR/backlog refs in test or source code.

**Property tests** (per the project's property-ADR lenses 2/3 — total function over a finite
DAG grammar; tiered `numRuns`): in `find-bisection.properties.test.ts` with generators in
`arbitraries.ts` (a generator that builds a random small candidate DAG — each commit's parents
are a subset of strictly-older candidates, so it is acyclic and total): `findBisection` over any
non-empty DAG (a) returns a member of the input, (b) never throws, (c) `1 ≤ reaches ≤ all`,
(d) `min(reaches, all-reaches)` is maximal over the set (no candidate beats the pick on
`distance`), (e) `2*reaches - all ∈ {-1,0,1}` when a halfway commit exists. A separate cheap
round-trip-free property for `estimateSteps`: monotonic non-decreasing in `all`. Use `200`
numRuns for `estimateSteps` (cheap), `100` for the DAG-composition properties.

**Mutation-resistance specifics:**
- Isolate each `approx_halfway` boundary: separate tests for `diff = -1`, `diff = 0`,
  `diff = 1`, and a non-halfway `diff` (so an `∈{-1,0,1}` → `∈{0,1}` mutant dies on its own
  boundary).
- `estimateSteps`: isolate the `all < 3 → 0` guard; hit the `e < 3*x` branch on BOTH sides —
  `all=3` (true → `n`) and `all=4` (false → `n-1`).
- `best_bisection` strict `>`: the tie test where the earlier candidate must win kills a `>=`
  mutant.
- `count_distance` merge union: the diamond merge weight-5 example kills a per-parent-sum mutant.
- Octopus (≥3 parents): add a 3-parent merge weight example (no existing primitive exercises
  3 parents).

### TDD steps

1. **RED** `estimate-steps.test.ts`: parameterised sweep over the pinned `all→steps` table +
   isolated `all<3` guard + `all=3`(true)/`all=4`(false) branch tests. Fails: `estimateSteps`
   does not exist (module-not-found / not exported).
2. **GREEN** `estimate-steps.ts`: implement the verbatim formula; export from `index.ts`.
3. **RED** `weight.test.ts`: linear-chain weights `1..n`; diamond merge unions both branches
   (weight 5); octopus (3 in-set parents) union; a 0-in-set-parent commit has weight 1. Fails:
   `count_distance`/weight not implemented.
4. **GREEN** implement `weight.ts` (`count_distance` with multi-parent union).
5. **RED** `find-bisection.test.ts`: every pinned matrix row (assert `nextCommit` + `reaches` +
   `candidateCount`); empty list → `undefined`; single-candidate set; the four isolated
   `approx_halfway` boundaries; the `best_bisection` strict-`>` tie (earlier candidate wins,
   i.e. the `B2` diamond pick). Fails: `findBisection` not implemented.
6. **GREEN** implement `find-bisection.ts` + `bisect.ts` (`findBisection` orchestrator);
   export `findBisection` + `Bisection`/`BisectCandidate` from `index.ts`.
7. **RED** `find-bisection.properties.test.ts` + `arbitraries.ts`: the invariants above. Run;
   shrink any counterexample, fix the production code (never weaken the property to a tautology).
8. **REFACTOR**: extract small pure helpers (<20 lines, early returns, no nesting >2); keep the
   barrel minimal (only the 4 names Part 2 consumes); confirm immutability (no candidate-array
   mutation). Re-run all four test files green.

### Gate

```
npx vitest run test/unit/domain/bisect/weight.test.ts test/unit/domain/bisect/estimate-steps.test.ts test/unit/domain/bisect/find-bisection.test.ts test/unit/domain/bisect/find-bisection.properties.test.ts \
  && npm run check:types \
  && ./node_modules/.bin/biome check src/domain/bisect test/unit/domain/bisect
```

### Commit

```
feat: bisect — pure find_bisection midpoint engine
```

---

## Part 2 — Tier-2 primitive `bisectMidpoint` + facade + surface gates + interop

### Context

**Goal.** Land the public, ergonomic primitive that does the reachability I/O, builds the
candidate set in git's walk order, delegates to Part 1's `findBisection`, and returns structured
counts. Mirrors `mergeBase` (ObjectId inputs, `ctx`-first, no rev-grammar resolution inside).

**Surface signature (RATIFIED — ADR-429 + injected contract; this SUPERSEDES the design doc's
`BisectMidpointOptions { bad: string }` sketch).** The primitive takes **already-resolved
`ObjectId`s**, exactly like `mergeBase(ctx, commits)` which takes `ObjectId[]` and does NOT
resolve refs:

```ts
// src/application/primitives/bisect-midpoint.ts
export const bisectMidpoint = async (
  ctx: Context,
  good: ReadonlyArray<ObjectId>,
  bad: ObjectId,
): Promise<BisectMidpoint | undefined> => { … };
```

Facade-bound shape (ctx stripped by `BindCtx`): `repo.primitives.bisectMidpoint(good, bad)`.

**Public result type** (add to `src/application/primitives/types.ts`; it auto-flows to the
package entry — `primitives/index.ts` line 74 `export type * from './types.js'` →
`src/public-types.ts` line 10 `export type * from './application/primitives/index.js'`):

```ts
interface BisectMidpoint {
  readonly nextCommit: ObjectId;     // the commit to test next; caller abbreviates
  readonly candidateCount: number;   // bisect_all
  readonly remainingIfGood: number;  // all - reaches - 1   (porcelain "N revisions left")
  readonly remainingIfBad: number;   // reaches - 1
  readonly remainingSteps: number;   // estimateSteps(all)
}
```

Also add to `types.ts`: `export const MAX_BISECT_CANDIDATES = …;` (a numeric ceiling — reuse the
existing `MAX_WALK_QUEUE_SIZE = MAX_WALK_SEEDS * 64` already defined there, or define
`MAX_BISECT_CANDIDATES = MAX_WALK_QUEUE_SIZE` so the bound matches the walk ceiling).

**Candidate-set construction (the application I/O — reuse `merge-base.ts` discipline).** Read
`src/application/primitives/merge-base.ts` in full: it already implements
`makeReadCommit(ctx)` (a `Map`-cached `readObject` → `Commit | undefined`) and `paint(...)`,
a flag-paint over the date-priority queue from `src/domain/commit/priority-queue.js`
(`enqueue` / `precedes`: newest committer date first, oid-ascending tie-break). Build:

```
read = makeReadCommit(ctx)                       // copy the cached reader pattern
paint UNINTERESTING down from EVERY good (self + ALL ancestors)   // git limit_list down-paint
collect every commit reachable from `bad` that is NOT UNINTERESTING,
  in git's limit_list order, as BisectCandidate[]:
    { id, parents: <parents filtered to in-set candidates>, date: committer.timestamp }
guard: if candidates.length > MAX_BISECT_CANDIDATES → throw invalidWalkInput(<reason>)
result = findBisection(candidates)               // Part 1 domain barrel
if result === undefined → return undefined        // empty set: bisection already resolved
return {
  nextCommit:    result.nextCommit,
  candidateCount: result.candidateCount,
  remainingIfGood: result.candidateCount - result.reaches - 1,   // may be -1 (faithful, all=1)
  remainingIfBad:  result.reaches - 1,
  remainingSteps:  estimateSteps(result.candidateCount),         // Part 1 domain barrel
}
```

- `good = []` is **allowed** (git-faithful): no goods ⇒ the candidate set is everything
  reachable from `bad`. No special-case; the paint loop just paints nothing.
- `bad` that is not a commit / not present surfaces the existing `readObject` error — propagate,
  add no new code. (`makeReadCommit` returns `undefined` for non-commit objects, as in
  `merge-base.ts`.)
- **`all = 1 → remainingIfGood = -1`** is faithful passthrough (ADR-430). Do NOT clamp.

**FAITHFULNESS RISK G — candidate-LIST-ORDER.** `best_bisection` ties break by candidate-list
position, so byte-faithfulness requires building the list in git's exact `limit_list` order.
The diamond `A2`/`B2` distance-2 tie must resolve to **`B2`** under `git rev-list --bisect`
(NOT `A2`, which is `--bisect-all`'s oid-order first — do not conflate the two surfaces). The
date-descending pop order does not yield `B2` on its own; reproduce git's internal `commit_list`
order (may require collecting then reversing, or matching insertion order). **The diamond interop
golden is the regression guard.** If construction-order parity proves intractable for some exotic
dating, ESCALATE as a documented faithful divergence `{ unit, reason, ≤3 options }` — never guess.

**Imports for `bisect-midpoint.ts`:** `findBisection`, `estimateSteps`, type `BisectCandidate`
from `../../domain/bisect/index.js`; `invalidWalkInput` from `../../domain/error.js`; `ObjectId`,
`Commit` from `../../domain/objects/index.js`; `Context` from `../../ports/context.js`;
`readObject` from `./read-object.js`; `enqueue`/`QueueEntry` from
`../../domain/commit/priority-queue.js`; `BisectMidpoint`/`MAX_BISECT_CANDIDATES` from `./types.js`.

#### SURFACE GATES — pre-pay ALL of these in THIS part (each is its own red run otherwise)

1. **Barrel** — `src/application/primitives/index.ts`: add
   `export { bisectMidpoint } from './bisect-midpoint.js';` (alphabetical, next to the other
   `b*`/`catFileBatch` value exports — e.g. just before `export { catFileBatch } …`). The
   `BisectMidpoint` type rides the existing `export type * from './types.js'` (line 74) — no
   extra type export line needed.
2. **Facade interface** — `src/repository.ts`: in the `primitives` block of the `Repository`
   interface (currently lines ~258–281), add
   `readonly bisectMidpoint: BindCtx<typeof primitives.bisectMidpoint>;` (sorted — `bisectMidpoint`
   goes FIRST, before `catFileBatch`). Update the section comment `// Tier-2 primitives (22)`
   → `(23)` at line ~256.
3. **Facade binding** — `src/repository.ts`: in the `primitives: Object.freeze({ … })` block
   (currently lines ~600–689), add the guarded binding next to `mergeBase` (lines ~625–628):
   ```ts
   bisectMidpoint: ((good, bad) => {
     guard();
     return primitives.bisectMidpoint(ctx, good, bad);
   }) as Repository['primitives']['bisectMidpoint'],
   ```
4. **Surface-snapshot test** — `test/unit/repository/repository.test.ts`: in the
   `When listing primitives` test (the sorted array at lines ~257–282), add `'bisectMidpoint'`
   (sorts first). The assertion `.sort()`s both sides, so position is cosmetic — but add it in
   sorted position. (No top-level-key change; this is a `primitives` addition only.)
5. **`check:doc-coverage`** (VALIDATE gate — the injected note was wrong that it skips Tier-2;
   every primitive has a page): create `docs/use/primitives/bisect-midpoint.md` (mirror
   `docs/use/primitives/merge-base.md`'s structure) AND add the index row to
   `docs/use/primitives/README.md` — the tool requires the EXACT substring
   `` [`bisectMidpoint`](bisect-midpoint.md) `` in that README. Content can be lean; the docs
   phase enriches it later. (Kebab of `bisectMidpoint` = `bisect-midpoint`.)
6. **`check:browser-surface`** (VALIDATE gate — also applies to Tier-2; the allowlist has a
   `primitives` array, e.g. `runHook`): create `test/parity/scenarios/bisect-midpoint.scenario.ts`
   that invokes `repo.primitives.bisectMidpoint(good, bad)` in its `run()`, and register it in
   `test/parity/scenarios/index.ts` (import + add to the `SCENARIOS` array). Model on
   `test/parity/scenarios/phase-20-2-primitives.scenario.ts` (a `Scenario<Result>` with
   `name`/`inputs`/`expected`/`run`) and on `diff-pipeline.scenario.ts` which seeds commits and
   calls `repo.primitives.mergeBase`. Seed a small deterministic DAG (use `AUTHOR` from
   `test/parity/fixtures.ts` for identity so node/memory/browser produce identical oids), e.g. a
   linear 3-commit chain (`all=3` ⇒ `candidateCount:3, remainingIfGood:0, remainingIfBad:1,
   remainingSteps:1`), and pin `expected`. Keep it adapter-deterministic (fixed author/committer
   timestamps). `check:parity-fixtures` (VALIDATE) audits scenario fixtures — match the existing
   scenario shape exactly.
7. **`reports/api.json`** (PREPUSH gate `check:doc-typedoc`, not validate): the new public
   `BisectMidpoint` type makes it stale. Run `npm run docs:json` and commit the regenerated
   `reports/api.json` IN this part (the large typedoc-id diff is normal).
8. **NOT touched:** `src/domain/error.ts` (no new error code — `undefined` for empty,
   `invalidWalkInput` for the guard). `src/public-types.ts` (auto-flow). The Tier-1 heavy set
   (commands barrel, `docs/use/commands`, "N Tier-1 commands" README count) does not apply.

**Primitive unit test** — `test/unit/application/primitives/bisect-midpoint.test.ts` (memory
adapter; seed objects via `writeObject` / `createCommit` — see existing
`test/unit/application/primitives/merge-base.test.ts` for the seed harness):
- candidate-set excludes goods AND their ancestors; includes `bad`.
- multi-good (`good = [g1, g2]`) paints both ancestries.
- derived fields from domain `reaches`: assert `remainingIfGood = all - reaches - 1` and
  `remainingIfBad = reaches - 1`; **assert the `all=1 → remainingIfGood = -1` case explicitly**
  (kills clamp + off-by-one mutants — use a try/catch-free direct `.remainingIfGood` assertion).
- empty set → `undefined` (`bad` is an ancestor of / equal to a good).
- `good = []` → candidate set is everything reachable from `bad`.
- non-commit / missing `bad` → propagates the `readObject` error; assert `.data.code`.
- `MAX_BISECT_CANDIDATES` guard fires with a specific error — assert `.data.code ===
  'INVALID_WALK_INPUT'` and the reason (per CLAUDE.md: assert the data, never `toThrow(Class)`).
- a candidate-order fixture whose `best_bisection` tie depends on the build order (the `B2`
  diamond, seeded as real objects) — proves list-order construction.

**Interop test** — `test/integration/bisect-midpoint-interop.test.ts` (the faithfulness pin).
Read `test/integration/interop-helpers.ts` (use `runGit`, `git(dir,…)`, scrubbed `SAFE_ENV`,
`GIT_AVAILABLE`) and `test/integration/name-rev-interop.test.ts` for the
`createNodeContext({ workDir: dir })`-over-a-real-git-repo + shared `beforeAll` (`SETUP_TIMEOUT
= 60_000`) + `datedEnv(epoch)` deterministic-commit pattern (heavy git-spawning tests time out
hook concurrency otherwise — one shared repo, 60s timeout). Build fixture repos with real `git`
(deterministic dates, signing off via the scrubbed env), then open tsgit's NODE ctx over the
SAME on-disk repo and call `bisectMidpoint(ctx, good, bad)` (the oids come from `git rev-parse`;
brand the strings as `ObjectId`). For each scenario assert the structured result reconstructs
**both** git surfaces byte-for-byte:
- `git rev-list --bisect <bad> ^<good>…` → `nextCommit`.
- `git rev-list --bisect-vars <bad> ^<good>…` → `candidateCount` = `bisect_all`,
  `max(remainingIfGood, remainingIfBad)` = `bisect_nr`, `remainingIfGood` = `bisect_good`,
  `remainingIfBad` = `bisect_bad`, `remainingSteps` = `bisect_steps`.
- the porcelain line: reconstruct
  `` `Bisecting: ${remainingIfGood} revisions left to test after this (roughly ${remainingSteps} steps)` ``
  and compare against `git bisect start <bad> <good>` in a throwaway clone (pins the
  porcelain-`N`-vs-`--bisect-vars`-`nr` divergence).

Scenarios (the binding goldens): every linear row of the matrix below, the **diamond
(`best_bisection` tie → `B2`)**, a **multi-good** set, an **octopus merge** (≥3 parents — a
named regression guard, no existing primitive exercises it), single-candidate (`all=1`,
`remainingIfGood=-1`), and **empty-set** (`git rev-list --bisect-vars <bad> ^<bad>` exits 1 →
primitive `undefined`; use `tryRunGit` for the exit-1 co-refusal).

Pinned interop matrix — linear `c0 (oldest) … c9 (newest)`, `bad = c9`; diamond
`base → {A1,A2} ∥ {B1,B2} → M → top`; `reaches = bisect_bad + 1`, porcelain `N = all - reaches - 1`:

| topology | `good` | `all` | midpoint | `reaches` | porcelain `N` | `remainingIfBad` | `steps` |
|---|---|---|---|---|---|---|---|
| linear | c0 | 9 | c4 | 4 | 4 | 3 | 2 |
| linear | c1 | 8 | c5 | 4 | 3 | 3 | 2 |
| linear | c2 | 7 | c5 | 3 | 3 | 2 | 2 |
| linear | c3 | 6 | c6 | 3 | 2 | 2 | 2 |
| linear | c4 | 5 | c6 | 2 | 2 | 1 | 1 |
| linear | c5 | 4 | c7 | 2 | 1 | 1 | 1 |
| linear | c6 | 3 | c8 | 2 | 0 | 1 | 1 |
| linear | c7 | 2 | c8 | 1 | 0 | 0 | 0 |
| linear | c8 | 1 | c9 | 1 | **-1** | 0 | 0 |
| diamond | base | 6 | **B2** | 2 | 3 | 1 | 2 |
| diamond | A1,B1 | 4 | **B2** | 1 | 2 | 0 | 1 |

Structural facts to enforce: merge weight 5 (diamond `M`); `--bisect` tie → `B2` (NOT `A2`);
`bisect_good=-1` faithful at `all=1`.

**Conventions:** GWT describe/it + AAA + `sut`; specific `.data` error assertions; 100% coverage
on the primitive; mutation-killed. NO phase/ADR/backlog refs in code.

### TDD steps

1. **RED** add `BisectMidpoint` + `MAX_BISECT_CANDIDATES` to `types.ts`; write
   `bisect-midpoint.test.ts` (memory-seeded) covering the unit bullets above. Fails:
   `bisectMidpoint` not implemented / not exported.
2. **GREEN** implement `src/application/primitives/bisect-midpoint.ts` (cached reader + UNINTERESTING
   down-paint + ordered candidate collection + guard + `findBisection`/`estimateSteps` delegation +
   field derivation); export from `primitives/index.ts`. Unit test green.
3. **GREEN (surface wiring)** add the facade interface field + binding + `(22)→(23)` comment in
   `src/repository.ts`; add `'bisectMidpoint'` to the primitive key-set in `repository.test.ts`.
   Run `repository.test.ts` green.
4. **RED** write `test/integration/bisect-midpoint-interop.test.ts` (shared `beforeAll`, 60s
   timeout, scrubbed env, all matrix scenarios + diamond `B2` + multi-good + octopus + single +
   empty). Run against the now-implemented primitive; fix any list-order divergence the diamond
   golden catches (escalate if order parity is intractable — do not guess).
5. **GREEN (browser surface)** create `test/parity/scenarios/bisect-midpoint.scenario.ts` +
   register in `index.ts`; pin `expected` for the deterministic seeded DAG.
6. **GREEN (doc surface)** create `docs/use/primitives/bisect-midpoint.md` + add the
   `` [`bisectMidpoint`](bisect-midpoint.md) `` index row to `docs/use/primitives/README.md`.
7. **GREEN (api report)** run `npm run docs:json`; commit the regenerated `reports/api.json`.
8. **REFACTOR** small functions (<20 lines), early returns, immutable candidate array, no Demeter
   chains; de-dup against `merge-base.ts` where the cached-reader pattern is shared but keep the
   bisect walk's UNINTERESTING semantics explicit. Re-run all touched tests + the pre-pay gate
   commands below green.

### Gate

```
npx vitest run test/unit/application/primitives/bisect-midpoint.test.ts test/unit/repository/repository.test.ts \
  && npx vitest run test/integration/bisect-midpoint-interop.test.ts \
  && npm run check:types \
  && ./node_modules/.bin/biome check src/application/primitives/bisect-midpoint.ts src/application/primitives/types.ts src/application/primitives/index.ts src/repository.ts test/unit/application/primitives/bisect-midpoint.test.ts test/unit/repository/repository.test.ts test/integration/bisect-midpoint-interop.test.ts test/parity/scenarios/bisect-midpoint.scenario.ts test/parity/scenarios/index.ts
```

Public-surface pre-pay verifications (this part lands public surface — run before declaring done,
since these are phase-boundary/prepush gates owed in-slice):

```
npm run check:doc-coverage      # bisect-midpoint.md page + README index row
npm run check:browser-surface   # parity scenario invokes repo.primitives.bisectMidpoint
npm run docs:json               # regenerate + commit reports/api.json (prepush check:doc-typedoc)
```

### Commit

```
feat: bisect-midpoint — Tier-2 reachability primitive returning structured halving data
```
