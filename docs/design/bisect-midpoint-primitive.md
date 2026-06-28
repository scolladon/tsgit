# Design — Bisect Midpoint Primitive

## Goal

Expose git's bisection **halving step** as a pure Tier-2 primitive. Given the
`good` / `bad` endpoints of a search, return the single commit a caller should
test next — the commit that splits the still-suspect history as close to in half
as possible — plus the structured counts git derives from it. **Structured data
only** (ADR-249): the primitive returns `{ nextCommit, candidateCount,
remainingIfGood, remainingIfBad, remainingSteps }`; the byte string git prints
(`Bisecting: N revisions left to test after this (roughly M steps)`) is
reconstructed by the consumer (and by the interop test) from those fields.

What this primitive does **not** do — and deliberately leaves to the consumer:

- the good/bad **verdict** (deciding whether the tested commit is good or bad);
- the stateful session porcelain (`start` / `good` / `bad` / `skip` / `reset` /
  `run`) and its on-disk state (`BISECT_START`, `BISECT_LOG`, `BISECT_TERMS`,
  `BISECT_EXPECTED_REV`, `refs/bisect/*`, `BISECT_HEAD`);
- the **skip** list and git's randomised skip-reshuffle;
- pathspec-limited bisection (`git bisect start -- <path>`);
- checking the next commit out into the working tree.

Driving the bisect loop is orchestration, not a data-library surface. tsgit ships
the one piece that is a pure function of the commit graph: the midpoint.

## Faithfulness research (verified against real `git` 2.54.0)

Every fact below was pinned against canonical `git` with `GIT_*` scrubbed,
isolated `HOME`, `GIT_CONFIG_NOSYSTEM=1`, signing off, and deterministic
author/committer dates, then cross-checked against `git/git`'s `bisect.c` at tag
`v2.54.0`. They are the binding contract; the design records them and the interop
test re-pins them.

The exposing plumbing is **`git rev-list --bisect-vars <bad> ^<good>…`** (and its
siblings `--bisect`, `--bisect-all`). It emits exactly the structured datum this
primitive returns — no porcelain, no checkout:

```
bisect_rev='<oid>'      # the midpoint commit
bisect_nr=<n>           # max(reaches, all-reaches) - 1   (worst-case remaining)
bisect_good=<n>         # all - reaches - 1               (remaining if midpoint is good)
bisect_bad=<n>          # reaches - 1                     (remaining if midpoint is bad)
bisect_all=<n>          # candidate count
bisect_steps=<n>        # estimate_bisect_steps(all)
```

### The candidate set

The suspects are the commits reachable from `bad` but **not** reachable from any
`good` — git's `<bad> ^<good1> ^<good2> …` revision set, computed with the same
`UNINTERESTING`-flag down-painting `limit_list` uses (a `good` paints itself **and
its whole ancestry** uninteresting, not just the tip). `all` = the size of that
set. With no pathspec, every reachable commit is a candidate (no `TREESAME`
pruning). `good` and `bad` themselves: `bad` is in the set; `good` is excluded
(it and its ancestors are uninteresting).

### Weight and the midpoint (`do_find_bisection` + `count_distance`)

For a candidate `c`, define **weight(c)** = the number of candidates reachable
from `c` through parent edges, *including `c` itself* (`count_distance`: a DFS
over parents, summing in-set commits, stopping at uninteresting/already-counted).
A **merge** commit's weight unions both parents' ancestries — pinned: in the
diamond below, `M`'s weight is 5 (itself + both branches), verified.

git's selection (`do_find_bisection`) computes weights in three phases:

1. **Seed.** Each candidate with **0** in-set parents (an oldest commit) gets
   weight 1. Each with exactly 1 in-set parent is left "unknown, single strand".
   Each with ≥2 in-set parents (a **merge**) is left "unknown, needs walk".
2. **Merges.** Only the merge commits get the expensive `count_distance`; each is
   checked against `approx_halfway` immediately (early-return short-circuit).
3. **Fill.** Repeatedly sweep the list; a single-strand commit whose parent's
   weight is known takes `parentWeight + 1`, and is checked against
   `approx_halfway` on the spot. Because a weight is assignable only once its
   parent is known, weights become known **oldest → newest by ancestry**,
   regardless of list iteration direction.

`approx_halfway(c)` (the short-circuit test), with `nr = all`:

```
diff = 2 * weight(c) - nr
halfway  ⇔  diff ∈ {-1, 0, 1}            # exact, for small sets
        OR  (nr large and |diff| < nr / 1024)   # ~0.1% tolerance band
```

If no commit short-circuits, git falls back to **`best_bisection`**: pick the
candidate maximising `distance = min(weight, all - weight)`, ties broken by the
**first such commit in the candidate list order** (strict `>` keeps the earlier
one). `--bisect-all`'s output sorts by `-distance` then **oid ascending** and is a
**different tie-break** from `--bisect`/`--bisect-vars`; do not conflate them
(pinned: the diamond's `A2`/`B2` distance-2 tie resolves to `B2` under
`--bisect`, but `--bisect-all` lists `A2` first by oid).

**Consequence for tie-breaking.** Because the short-circuit fires on the
**lowest-weight** commit inside the halfway band (it is reached first by the
oldest→newest weight-fill), and because the `best_bisection` fallback breaks ties
by **candidate-list position**, reproducing git's pick byte-for-byte requires
porting `do_find_bisection` (with `count_distance`, `approx_halfway`,
`best_bisection`) **verbatim** *and* building the candidate list in git's
revision-walk order. This is the same "port the engine verbatim, pin the result"
discipline `range-diff` used for `compute_assignment`. The exact list order is the
central faithfulness risk (see Decision G); the interop matrix is the
contract that nails it down.

### Derived counts

With `reaches = weight(midpoint)` and `all = candidateCount`:

| field | formula | meaning |
|---|---|---|
| `bisect_bad`  | `reaches - 1`              | suspects left if the midpoint tests **bad** |
| `bisect_good` | `all - reaches - 1`        | suspects left if the midpoint tests **good** |
| `bisect_nr`   | `max(reaches, all-reaches) - 1` | worst-case suspects left (`--bisect-vars`) |
| `bisect_steps`| `estimate_bisect_steps(all)` | rough remaining test count |

**Pinned divergence between two git surfaces** — the human porcelain line and the
`--bisect-vars` `nr` use **different** counts:

- `git bisect start` prints `N = all - reaches - 1` (the *good-branch* count,
  `bisect_good`). Pinned: a 3-candidate set (`reaches = 2`) prints
  `Bisecting: 0 revisions left to test after this (roughly 1 step)`.
- `git rev-list --bisect-vars` reports `nr = max(reaches, all-reaches) - 1`.
  Pinned: the same 3-candidate set reports `bisect_nr=1`.

So a single `remainingRevisions` field would be ambiguous. The primitive returns
the two **half-counts** (`remainingIfGood`, `remainingIfBad`) plus
`candidateCount`; the caller reconstructs *either* surface (porcelain line =
`remainingIfGood`; vars `nr` = `max(remainingIfGood, remainingIfBad)`). This keeps
the library honest to both and free of a baked-in display choice (ADR-249).

### `estimate_bisect_steps` (verbatim)

```
estimate_bisect_steps(all):
  if all < 3: return 0
  n = floor(log2(all))      # log2u
  e = 1 << n                # 2^n
  x = all - e
  return (e < 3*x) ? n : n - 1
```

Verified table (`all → steps`): `2→0, 3→1, 4→1, 5→1, 6→2, 7→2, 8→2, 9→2`.

### Pinned interop matrix (the binding goldens)

Linear history `c0 (oldest) … c9 (newest)`, `bad = c9`, varying `good`; plus a
diamond `base → {A1,A2} ∥ {B1,B2} → M(merge) → top`. `reaches = bisect_bad + 1`;
porcelain `N = all - reaches - 1`.

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
| diamond | base | 6 | B2 | 2 | 3 | 1 | 2 |
| diamond | A1,B1 | 4 | B2 | 1 | 2 | 0 | 1 |

Two structural facts to enforce:

- **Merge weight** (diamond, `all=6`): `M`'s weight is 5 (both branches);
  `count_distance` must union multi-parent ancestries.
- **`best_bisection` tie** (diamond, `all=6`): `A2` and `B2` both have distance 2;
  git's `--bisect` picks **`B2`** (list-order tie-break), *not* `A2`
  (`--bisect-all`'s oid-order first). The interop golden pins `B2`.
- **Negative half-count** (linear, `all=1`): a single candidate yields
  `remainingIfGood = -1`. git's `--bisect-vars` emits `bisect_good=-1`
  faithfully (see Decision B: faithful passthrough vs. clamp).

### Empty / terminal cases

- **Empty candidate set** — `bad` is an ancestor of (or equal to) `good`, or every
  commit reachable from `bad` is good. `git rev-list --bisect-vars <bad> ^<bad>`
  **exits 1 with no output**; there is no midpoint. The primitive must signal "no
  candidate" structurally (see Decision B), never invent a commit.
- **Single candidate** (`all=1`) — the midpoint *is* that commit; `steps=0`. This
  is the loop's last step from the consumer's side, but to *this* primitive it is
  just a 1-element set with a defined answer.

## Architecture

Hexagonal, mirroring `range-diff` (pure domain engine) + `merge-base`
(reachability flag-painting in the application layer):

```
src/
├── domain/
│   └── bisect/                          # NEW pure subsystem
│       ├── weight.ts                    # count_distance over an in-memory candidate DAG
│       ├── find-bisection.ts            # do_find_bisection: 3-phase weight fill + approx_halfway + best_bisection
│       ├── estimate-steps.ts            # estimate_bisect_steps (log2u/exp2i)
│       ├── bisect.ts                    # pure orchestrator: candidates -> Bisection
│       └── index.ts                     # internal barrel
└── application/
    └── primitives/
        ├── bisect-midpoint.ts           # NEW Tier-2: resolve good/bad -> build candidate set (I/O) -> domain
        ├── types.ts                     # MODIFIED — BisectMidpointOptions, BisectMidpoint, MAX_BISECT_CANDIDATES
        └── index.ts                     # MODIFIED — export bisectMidpoint
└── repository.ts                        # MODIFIED — bind repo.primitives.bisectMidpoint (22 -> 23)
```

**Dependency rule preserved.** The application primitive does *all* I/O — resolve
`good`/`bad` to `ObjectId`, read commits, paint `UNINTERESTING` from the goods,
and collect the candidate set as a fully-hydrated array of
`{ id, parents, date }` in git's walk order. It hands the domain a pure,
in-memory DAG; the domain computes weights, selects the midpoint, and derives the
counts — all pure, nothing crossing the hexagon inward. The domain function is the
property-test target; the primitive is the integration/interop target.

### Candidate-set construction (application layer)

Reuse the flag-painting discipline already in `merge-base.ts`
(`paint_down_to_common` over the `priority-queue` ordered by commit date) and the
`readCommit` cache from `walk-commits`. The walk is git's `limit_list`:

```
paint UNINTERESTING down from every good (self + all ancestors)
collect every commit reachable from bad that is NOT UNINTERESTING
  ->  candidates[]  (each: { id, parents, date }), in git's limit_list order
```

The collected **order** is load-bearing for `best_bisection` ties and is **not**
simply commit-date-descending: the diamond golden pins the `A2`/`B2` distance-2
tie to `B2`, which the date-descending pop order (newest-first) does *not* yield
on its own — git's internal `commit_list` order does. Reproducing that order is
part of the verbatim port (it may require collecting then reversing, or matching
git's insertion order); the exact order is **pinned by the diamond interop
golden**, not assumed here (Risk G). The candidate array carries each commit's
in-set parent edges (parents filtered to candidates) so the domain never reads
objects. A `MAX_BISECT_CANDIDATES` guard (or reuse of the existing
`MAX_WALK_QUEUE_SIZE` ceiling) bounds memory, surfaced as a structured error —
never an unbounded walk.

### Domain shapes (pure)

```ts
/** One candidate commit, hydrated by the primitive; the domain reads no objects. */
interface BisectCandidate {
  readonly id: ObjectId;
  readonly parents: ReadonlyArray<ObjectId>;  // already filtered to in-set parents
  readonly date: number;                       // committer timestamp; fixes the list order
}

/** The pure halving result. */
interface Bisection {
  readonly nextCommit: ObjectId;       // bisect_rev (the midpoint)
  readonly candidateCount: number;     // all
  readonly reaches: number;            // weight(midpoint) — the load-bearing raw count
}
```

`findBisection(candidates: ReadonlyArray<BisectCandidate>): Bisection | undefined`
— `undefined` on an empty list (no midpoint). `reaches` is the single raw count
from which the primitive derives every public field, so the derivation lives in
exactly one place.

## Public surface

```ts
repo.primitives.bisectMidpoint(
  good: ReadonlyArray<ObjectId>,
  bad: ObjectId,
): Promise<BisectMidpoint | undefined>;

interface BisectMidpoint {
  readonly nextCommit: ObjectId;       // the commit to test next; caller abbreviates
  readonly candidateCount: number;     // bisect_all
  readonly remainingIfGood: number;    // all - reaches - 1  (porcelain "N revisions left")
  readonly remainingIfBad: number;     // reaches - 1
  readonly remainingSteps: number;     // estimate_bisect_steps(all)
}
```

`undefined` (rather than a thrown error) signals an empty candidate set — git's
"no midpoint" exit-1, modelled as the absence of a result, consistent with how
`submodule-walk` treats recursion shortfalls as absence rather than errors. (A
discriminated `{ kind: 'none' }` is the alternative — Decision B.)

**Caller projections** (not library concerns, ADR-249):

- the porcelain line: `Bisecting: ${remainingIfGood} revisions left to test after
  this (roughly ${remainingSteps} steps)` — including the `revision`/`step`
  singular/plural (git's `Q_()` plural form is a render choice).
- the `--bisect-vars` `nr`: `max(remainingIfGood, remainingIfBad)`.
- abbreviating `nextCommit`; checking it out; recording it in `refs/bisect/*`.

## Edge cases

- **Empty candidate set** (`bad ⊑ good`, or all-reachable-good) → `undefined`. No
  commit invented. Pinned: `git rev-list --bisect-vars <bad> ^<bad>` exits 1, no
  output. This is also how the **"first bad commit found"** terminal surfaces to
  this primitive: bisection completes when the suspect set empties (good and bad
  become adjacent); the consumer reads that `undefined` as "done" and reports the
  first-bad commit from its own session state — the primitive holds no "found"
  flag of its own.
- **Single candidate** (`all=1`) → midpoint is that commit, `remainingIfGood=-1`,
  `remainingIfBad=0`, `remainingSteps=0`. The `-1` is git-faithful (Decision B).
- **`bad` unresolvable / not a commit** → propagate the existing
  resolve/object-read error (no new code), like every other commit-ish input.
- **`good` empty array** → with no good tips the candidate set is everything
  reachable from `bad`; git's `git rev-list --bisect <bad>` accepts this.
  Recommend allowing zero goods (git-faithful) rather than rejecting at the
  boundary; the candidate-set walk handles it without a special case.
- **Merges in the set** → `count_distance` unions parent ancestries; pinned weight
  5 for the diamond merge.
- **Octopus merges** (≥3 parents) → the same multi-parent union; no special case,
  but add a property/example case since `merge-base` only exercised 2 parents.
- **Disconnected goods** (a good unreachable from `bad`) → still paints its
  ancestry uninteresting; commits not reachable from `bad` are simply never
  collected. Git-faithful (the `^good` is a filter, not a requirement of
  reachability from `bad`).

## Testing strategy

Conventions: `Given/When/Then` titles, AAA bodies, `sut`, 100%
line/branch/function/statement coverage, 0 surviving mutants (per CLAUDE.md).

### Unit — domain (`test/unit/domain/bisect/*.test.ts`)

- **`weight` / `count_distance`** — example: linear chain weights `1..n`; diamond
  merge unions both branches (weight 5); octopus (3 parents); a commit with no
  in-set parents has weight 1. Property (lens 3 — total function over a finite
  DAG): `1 ≤ weight(c) ≤ all`; the newest tip's weight equals `all`.
- **`estimateSteps`** — example sweep over the pinned `all → steps` table,
  including the `all < 3 → 0` guard in isolation and the `e < 3*x` branch on both
  sides (e.g. `all=3` true-branch, `all=4` false-branch). Property: monotonic
  non-decreasing in `all`.
- **`findBisection`** — example: every row of the pinned matrix (the midpoint and
  `reaches`), the `approx_halfway` short-circuit (linear, picks the lowest-weight
  halfway commit), the `best_bisection` fallback **tie** (diamond → `B2`, the
  list-order tie, which a naive oid- or first-distance matcher mis-picks), the
  empty list → `undefined`, the single-candidate set. Property (lens 2/3): result
  is always a member of the input; `min(reaches, all-reaches)` is maximal over the
  set (no candidate beats the pick on distance); never throws on any non-empty
  DAG.

### Unit — primitive (`test/unit/application/primitives/bisect-midpoint.test.ts`)

Memory adapter; objects seeded via `createCommit` / `writeObject`.

- candidate-set construction excludes goods and their ancestors; includes `bad`.
- multi-good (`^good1 ^good2`) paints both ancestries.
- the derived fields (`remainingIfGood = all-reaches-1`, `remainingIfBad =
  reaches-1`) from the domain `reaches` — assert the `all=1 → remainingIfGood=-1`
  case explicitly (mutation-resistant: a clamp mutant must die).
- empty set → `undefined`; `good=[]` → reachable-from-bad set.
- unresolvable `bad` surfaces the existing resolve error (assert `.data.code`).
- `MAX_BISECT_CANDIDATES` guard fires with a specific error (assert `.data`).
- candidate-list **order** is git's walk order (a fixture whose `best_bisection`
  tie depends on it).

### Interop — `test/integration/bisect-midpoint-interop.test.ts`

Build repos with real `git` (deterministic dates, signing off, `GIT_*`
scrubbed). For each matrix scenario, assert the structured result reconstructs
**both** git surfaces byte-for-byte:

- `git rev-list --bisect <bad> ^<good>…` → `nextCommit`.
- `git rev-list --bisect-vars …` → `candidateCount` (`bisect_all`),
  `max(remainingIfGood, remainingIfBad)` (`bisect_nr`), `remainingIfGood`
  (`bisect_good`), `remainingIfBad` (`bisect_bad`), `remainingSteps`
  (`bisect_steps`).
- the porcelain line: reconstruct `Bisecting: ${remainingIfGood} revisions left to
  test after this (roughly ${remainingSteps} steps)` and compare to `git bisect
  start <bad> <good>` (in a throwaway clone). Pins the porcelain-vs-vars `nr`
  divergence.

Scenarios: every linear row, the diamond (`best_bisection` tie → `B2`), a
multi-good set, an octopus merge, single-candidate, and empty-set (git exits 1 →
primitive `undefined`). Reuse one shared `beforeAll` repo with a 60s timeout
(per the interop-load flake note).

### Parity — `test/parity/scenarios/bisect-midpoint.scenario.ts`

Cross-adapter (node / memory / browser) parity that the same structured result
falls out of each adapter, registered in the parity registry.

### Mutation-resistant specifics

- isolate each `approx_halfway` boundary (`diff ∈ {-1,0,1}`) — separate tests for
  `diff=-1`, `0`, `1`, and a non-halfway `diff`; pin the large-`nr` tolerance band
  only if a scenario reaches it (else document it equivalent for small fixtures).
- isolate the `e < 3*x` branch of `estimateSteps`.
- the `best_bisection` strict-`>` tie-break (diamond `B2`) — a `>=` mutant must
  die.
- the half-count subtraction constants (`- 1`) — the `all=1 → -1` case kills the
  off-by-one and clamp mutants.

## Surface gates (Tier-2 primitive checklist)

- `src/application/primitives/bisect-midpoint.ts` + barrel export in
  `primitives/index.ts`.
- `repository.ts`: `repo.primitives.bisectMidpoint` field + bound method
  (primitive count 22 → 23; update the `// Tier-2 primitives (NN)` comment).
- `test/unit/repository/repository.test.ts`: add `'bisectMidpoint'` to the
  primitive key-set (and the post-`dispose` `REPOSITORY_DISPOSED` guard).
- `domain/bisect/` unit + property tests; primitive unit test; interop test;
  parity scenario.
- Docs: a primitive page under `docs/use/` (if Tier-2 primitives are documented
  there — confirm in the docs phase), `reports/api.json` regen, README primitive
  count if one is published.
- `docs/BACKLOG.md`: flip `24.6` `[ ]` → `[x]`.

## Decision-candidates

The choices below are load-bearing and **not** pre-decided by an existing ADR. The
user owns them in the decisions phase; recommendations are advisory.

### A. Input shape — where reachability is computed

The brief says "given the good/bad reachable-commit sets". Literal vs. ergonomic:

1. Application primitive takes `good[]` + `bad` **commit-ish** and builds the
   candidate set internally (flag-painting + commit reads).
2. A pure domain function takes a **pre-built candidate set** (`BisectCandidate[]`)
   — no I/O at all; the caller constructs reachability.
3. **Both**: a pure domain `findBisection(candidates)` *and* a thin application
   primitive `bisectMidpoint(ctx, { good, bad })` that builds the set and delegates.

**Recommendation: 3.** It is the codebase's established split (`range-diff` = pure
domain engine + application command that does I/O). The domain function is the
property-test target and stays trivially pure; the primitive owns the
faithfulness-critical list-order construction. The "reachable set" of the brief is
then the primitive's internal product, not its parameter.

### B. Output shape & terminal representation

Sub-decisions:

1. **Counts surface.** (a) two half-counts `remainingIfGood` / `remainingIfBad` +
   `candidateCount` (caller derives the porcelain `N` and the vars `nr`); (b) the
   raw `{ reaches, candidateCount }` (most primitive, but exposes git's internal
   `reaches`); (c) the brief's literal `{ remainingRevisions, remainingSteps }`
   with `remainingRevisions` = one chosen formula. **Recommend (a)** — it
   reconstructs *both* git surfaces and sidesteps the pinned porcelain-vs-vars
   ambiguity; `remainingRevisions` is genuinely ambiguous (the two surfaces
   disagree), so a single such field would be unfaithful to one of them.
2. **Empty set.** (a) return `undefined`; (b) a discriminated
   `{ kind: 'none' } | { kind: 'midpoint', … }`; (c) throw a structured error.
   **Recommend (a)** — git's plumbing models "no midpoint" as exit-1/no-output, an
   absence, not an error; `submodule-walk` set the absence-not-error precedent.
   (b) is the alternative if a non-optional return type is preferred.
3. **Negative half-count** (`all=1 → remainingIfGood = -1`). (a) pass `-1` through
   faithfully (matches `git --bisect-vars bisect_good=-1`); (b) clamp to `0`.
   **Recommend (a)** — byte-faithful to the plumbing; clamping is a display choice
   the caller can make. Flag explicitly because it looks like a bug.

### C. Multi-parent (merge / octopus) handling

Port `count_distance`'s multi-parent ancestry-union **verbatim** (pinned: merge
weight 5; octopus needs a new case beyond `merge-base`'s 2-parent coverage), vs.
any approximation. **Recommend: verbatim port.** Low controversy; listed because
it is load-bearing for faithfulness and needs an explicit octopus test that no
existing primitive exercises.

### D. Skip handling boundary

(a) No `skip` parameter — the consumer pre-filters the candidate set (brief's
intent); (b) accept a `skip` exclusion set and reproduce git's `filter_skipped` +
randomised reshuffle. **Recommend (a).** git's skip path uses pseudo-random
selection (`get_prn`) that is explicitly session/state behaviour, out of a pure
data primitive's scope. Documented as a faithful non-goal.

### E. Surface tier & placement

(a) Domain pure fn in `src/domain/bisect/` + application primitive bound on
`repo.primitives.bisectMidpoint` (named export too); (b) named export only, not on
the facade; (c) also a Tier-1 `repo.bisect(...)` command. **Recommend (a)** —
consistent with `mergeBase` / `walkSubmodules` living under `repo.primitives.*`;
(c) would re-introduce the session porcelain the brief explicitly excludes.

### F. Naming

| element | options | recommendation |
|---|---|---|
| domain fn | `findBisection` / `bisectMidpoint` / `pickMidpoint` | `findBisection` (git's `find_bisection`) |
| primitive | `bisectMidpoint` / `nextBisectCommit` / `findBisection` | `bisectMidpoint` |
| domain module | `src/domain/bisect/` / `src/domain/bisection/` | `src/domain/bisect/` |
| result type | `BisectMidpoint` / `BisectStep` / `BisectionResult` | `BisectMidpoint` (public), `Bisection` (domain) |

### G. Candidate-list order fidelity (faithfulness risk)

`best_bisection` ties (pinned: diamond `A2` vs `B2`) resolve by **candidate-list
position**, so the result is only byte-faithful if the primitive builds the
candidate list in git's exact `limit_list` order. Options: (a) port the whole
`find_bisection` pipeline including list construction verbatim and pin the tie via
interop (recommended); (b) reimplement selection and rely on the interop matrix to
catch order bugs. **Recommend (a).** This is the one place a plausible-looking
reimplementation silently diverges; the diamond tie is the regression guard. If
construction-order parity proves intractable for some exotic dating, escalate as a
documented faithful divergence rather than guessing.

## Non-goals (deferred, divergences noted)

- **Bisect session state & porcelain** — `start`/`good`/`bad`/`skip`/`reset`/`run`,
  `BISECT_*`, `refs/bisect/*`, the good/bad verdict, checkout. Consumer's.
- **Skip list / randomised skip-reshuffle** — git's `filter_skipped` + `get_prn`.
  Pre-filter the candidate set instead.
- **Pathspec-limited bisection** (`git bisect start -- <path>`, the `TREESAME`
  pruning) — no pathspec support in this primitive; all reachable commits are
  candidates.
- **`--bisect-all`'s sorted, oid-tie-broken listing** — a different selection from
  the midpoint; out of scope (only the single midpoint is returned).
- **Rendered output** — the `Bisecting: …` line, abbreviation, singular/plural —
  all caller projections (ADR-249).

---

_Provenance: backlog 24.6._
