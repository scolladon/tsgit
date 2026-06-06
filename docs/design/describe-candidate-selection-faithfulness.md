# Design — `describe` candidate-selection faithfulness

## Goal

Resolve backlog **23.4n**: make the default `describe` candidate pick
byte-faithful to `git describe`.

On a merge where a **newer-dated** tag is structurally **farther** from the
target than an **older, nearer** tag, canonical `git describe` (default budget)
reports the *farther, first-met* tag, while tsgit currently reports the
*exhaustively-nearest* tag. `--candidates=1` already matches git (both spend the
single slot on the first-met tag — interop-pinned). Only the default / high-budget
selection diverges. This was surfaced and logged — not fixed — by the 23.4l walk
consolidation, whose mandate was behaviour-preserving.

## The divergence, observed against real git

Topology (the interop `candidate-cap` repo; `s1` committed *after* `n2`, so it
is newer-dated and the date-ordered walk meets it first):

```
base ── n1 ── n2 (tag: near) ──┐
   \                            ├── M (HEAD, merge --no-ff)
    ── s1 (tag: side) ──────────┘     first parent = n2, second = s1
```

Structural distances from `M`: `near` = 2 (`M`, `s1`), `side` = 3 (`M`, `n2`,
`n1`). So `near` is genuinely nearer.

Real `git describe` (2.54.0), default and `--candidates=1`, both report
**`side-3`**. Its `--debug` trace:

```
 annotated          3 side
 annotated          2 near
traversed 5 commits
found 10 tags; gave up search at <n1>
```

tsgit today reports **`near-2`** by default — the bug.

## Why git keeps the farther tag (the algorithm)

A faithful re-reading of git 2.54.0 `builtin/describe.c` (`describe_commit`)
explains it. The date-ordered scoreboard walk, per popped commit `c`:

1. **`gave_up` check (top of loop).** If `match_cnt == max_candidates ||
   match_cnt == hashmap_get_size(&names)`, set `gave_up_on = c` and **break** —
   before `c`'s name is even examined. `match_cnt` counts *collected* candidates;
   `hashmap_get_size(&names)` is the total number of distinct named commits.
   So the walk stops the moment **every** candidate slot — or **every** name —
   is taken.
2. Otherwise collect `c` if it carries a qualifying name (`t->depth =
   seen_commits - 1`, `found_order = match_cnt`), then increment `t->depth` for
   every already-collected candidate that cannot reach `c`.
3. A second early break (`annotated_cnt && queue_empty && c covered by every
   minimum-depth candidate`) stops once the frontier collapses to a single path
   already covered by the nearest candidate(s).
4. After the loop: sort `all_matches` by `compare_pt` — **depth asc, then
   found_order asc** — and pick `all_matches[0]`. Then
   `finish_depth_computation(&queue, &all_matches[0])` walks the rest, advancing
   **only the winner's** depth, to make the winner's distance exact.

The crux: when the walk stops early at step 1, the candidates are sorted on their
**frozen, partial depths** — *not* their exhaustive distances. In the topology
above the walk stops at the 4th pop (`n1`), where `match_cnt == 2 ==
names_size`, with **`side.depth == 2` and `near.depth == 2`** (a tie). The tie
breaks on `found_order`: `side` was met first (newer date) → `side` wins. Only
then does `finish_depth_computation` lift `side`'s depth from 2 to its true 3.
git reports `side-3`.

tsgit currently walks the **entire** reachable set, fully incrementing **every**
candidate's depth (`near` → 2, `side` → 3), then sorts. On full depths `near`
(2) beats `side` (3). That exhaustive sort is the bug: it ignores git's
freeze-at-stop semantics.

## Decision — re-port git's stop-and-finalise, keep the shared walk

The fix is to reproduce git's three observable facts:

1. **Stop collecting at the `gave_up` point** — when `candidates.length ===
   maxCandidates || candidates.length === totalNames`.
2. **Sort the candidates on their frozen partial depths** to pick the winner.
3. **Finalise only the winner's depth** by continuing the walk and advancing the
   winner alone (git's `finish_depth_computation`).

This is a localised change to `selectNearest` in `describe.ts`. It keeps the
23.4l consolidation (ADR-275): `describe` still consumes the shared
`commitDateWalk` core, and `commitDateWalk` / `walkCommitsByDate` /
`WalkCommitsByDateOptions` / `reports/api.json` are **unchanged**.

### The `annotated_cnt && queue_empty` break (cond 2) is observationally inert — omit it

git's second early break (step 3 above) is a *performance* optimisation with
**no effect on `DescribeResult`**, proven and empirically confirmed:

- It fires only when `c` is reachable from **every** minimum-depth candidate —
  i.e. those candidates are all descendants of `c`, so `c` (and every ancestor of
  `c`) is **farther** than every current nearest candidate.
- Any not-yet-found tag it skips is an ancestor of `c`, hence farther than the
  nearest candidate's depth → it can never become `all_matches[0]`.
- The winner is a minimum-depth candidate, so it reaches `c` and every ancestor
  of `c`; continuing the walk past the break increments the winner's depth by
  **zero** (`finish_depth_computation`'s own `c reachable from best ⇒ skip`).

So whether tsgit stops at cond 2 or walks the remaining ancestors, the winner's
**identity and finalised depth are identical**. Empirically: a "tag behind a
convergence" repo (`old` two commits past the merge-base of `ay`/`bee`) makes
real git fire cond 2 ("finished search at <merge-base>", traversing 4 commits)
and report `ay-2`; tsgit, walking all 6 commits and even collecting `old`, also
reports `ay-2` (`old` is farther, never wins). Reconstructing cond 2 would
require enriching the shared core with frontier-emptiness visibility for **zero**
observable gain — rejected under YAGNI/KISS. This is *not* a faithfulness
divergence under ADR-226: ADR-226 binds **observable** behaviour, and cond 2 has
none. It is pinned by the convergence interop scenario so a future regression
that *does* change the output is caught.

## Algorithm (new `selectNearest`)

State mirrors git: `candidates` (= `match_cnt`), a `reach` map (foundOrder sets,
git's per-candidate flag bits), `annotatedCnt`, a `counter` (= `seen_commits`),
`sawUnannotated`, and a `winner` (set once frozen).

```
totalNames = nameMap.size
for await (commit of commitDateWalk(ctx, { from: [target], firstParent })):
  oid = commit.id

  if winner !== undefined:                          # finishing phase
    finishWinnerDepth(winner, reach.get(oid))       # advance winner iff it cannot reach oid
    propagateReach(reach, commit, firstParent)
    continue

  # cond 1 — git's gave_up_on: all slots or all names taken
  if candidates.length === maxCandidates || candidates.length === totalNames:
    winner = pickWinner(candidates)                 # sort on FROZEN partial depths
    if winner === undefined: break                  # no candidates (totalNames 0) → caller handles
    finishWinnerDepth(winner, reach.get(oid))       # gave_up_on is finish's first commit
    propagateReach(reach, commit, firstParent)
    continue

  counter += 1
  named = nameMap.get(oid)
  if named && named.priority >= minPriority:
    index = candidates.length
    candidates.push({ name, commitOid: oid, depth: counter - 1, foundOrder: index })
    reachSet(reach, oid).add(index)
    if named.priority === 2: annotatedCnt += 1
  else if named:
    sawUnannotated = true

  incrementUnreached(candidates, reach.get(oid))
  propagateReach(reach, commit, firstParent)

return { best: winner ?? pickWinner(candidates), sawUnannotated }
```

- `pickWinner(cs)` = `[...cs].sort(compareCandidates)[0]` (git's `compare_pt`;
  `undefined` when `cs` is empty).
- `finishWinnerDepth(w, reached)` = increment `w.depth` iff `reached` does not
  contain `w.foundOrder` (git's `finish_depth_computation` winner-only advance).
- `incrementUnreached` / `propagateReach` / `reachSet` / `compareCandidates`
  are unchanged from today.

### Equivalence to git (per case)

- **Walk reaches natural end before cond 1** (e.g. a non-qualifying lightweight
  tag keeps `match_cnt < totalNames`, or the root has no parent): `winner` stays
  unset, every candidate is fully incremented, `pickWinner` sorts on full depths
  — identical to git's natural-end path (`finish_depth_computation` over an empty
  queue is a no-op). Equals **today's** behaviour, so all currently-green cases
  stay green.
- **cond 1 fires** (the common case — all qualifying tags found before the walk
  drains): candidates frozen, sorted on partial depths, winner finalised. The
  `gave_up_on` commit `c` is processed as `finish_depth_computation`'s first
  commit (git re-inserts it and decrements `seen_commits`; the decrement only
  affects the debug `traversed` count tsgit never emits). `c`'s parents are
  walked when the generator resumes on the next `continue` — matching git's
  `finish_depth_computation` pushing `gave_up_on`'s parents.
- **`counter` alignment.** git increments `seen_commits` for every pop before the
  `gave_up` check; tsgit increments `counter` only in the normal branch. Both
  count exactly the commits popped *before* the stop, which is all that
  `depth = seen_commits - 1` needs at collection time. `gave_up_on` and finishing
  commits are never collected, so their (absent) counter bump is immaterial.
- **`--first-parent` finishing.** git's `finish_depth_computation` parent loop has
  no `first_parent` break, so it walks *all* parents — but under `--first-parent`
  the walk is linear (frontier size ≤ 1), so cond 2 (`queue_empty`) **always
  preempts** `gave_up` at the first qualifying tag, and `finish_depth_computation`
  therefore always runs on an empty queue: git never walks a second parent during
  finishing. tsgit drives the finishing phase through the same
  `commitDateWalk(firstParent)`, so a `--first-parent` run continues the linear
  lineage and the first-met (nearest) tag wins the frozen-depth sort, finalised to
  its exact first-parent distance. Empirically: a merge with three untagged
  second-parent commits and tags on the first-parent lineage gives real git
  `tagB-1` under `--first-parent`, which this algorithm reproduces. For default
  (all-parents) describe the finishing phase walks all parents, matching git's
  all-parent `finish_depth_computation`.

### `totalNames` semantics

`totalNames = nameMap.size` matches git's `hashmap_get_size(&names)`: both count
**distinct named commits** after the ref / match / exclude filter, *including*
lightweight tags under `refs/tags/` even when describing annotated-only. So when
a non-qualifying name exists, `candidates.length` (qualifying only) can never
equal `totalNames`, and cond 1 falls through to `maxCandidates` or natural end —
exactly as git's `match_cnt` never reaches `names_size`.

`totalNames === 0` (no names at all) trips cond 1 on the first pop with an empty
candidate set; `pickWinner` returns `undefined`, the loop breaks, and the caller
throws `NO_NAMES` (or returns the `always` fallback) — git's `if (!match_cnt)`
path, reached before `finish_depth_computation`.

## Faithfulness & invariants

- **Observable behaviour now matches git** for default/high-budget describe on
  merges with date/distance inversion (the 23.4n bug). `--candidates=1`,
  `--first-parent`, exact-match, filters, dedup, refusals: unchanged.
- `api.json` **unchanged** — the change is internal to `describe.ts`; no public
  type or symbol moves. `commitDateWalk` / `walkCommitsByDate` untouched.
- Hexagonal layering preserved: `describe` (command) still composes the shared
  Tier-2 walk core; no new module, no domain change. `compareCandidates`,
  `Candidate`, the `reach`/`propagateReach` machinery stay in place.
- Behaviour-preserving for everything except the targeted bug: the natural-end
  path is byte-identical to today.

## Testing & mutation

Example tests (unit, memory adapter — `describe.test.ts`):

- **Flip the existing default-budget case** (currently asserts `near-2`) to the
  faithful `side-3`; keep the `--candidates=1` case (`side-3`) green.
- **Tie-break by found_order** at the freeze point: two equal-frozen-depth
  candidates → the first-met (newer-dated) wins.
- **`finish_depth_computation` lift**: the winner's reported distance exceeds its
  frozen depth (the 2 → 3 lift), guarding the winner-only finalisation.
- **cond-2-inert convergence**: the `ay`/`bee`/`old` topology returns `ay-2`,
  pinning that omitting cond 2 does not regress.
- **Natural-end preserved**: a lightweight tag keeps `match_cnt < totalNames`, so
  the walk runs to the end and still reports the nearest annotated tag (no
  premature freeze).
- Guard each cond-1 sub-condition independently (`maxCandidates` reached vs
  `totalNames` reached) so a `||` → `&&` mutant dies.

Cross-tool interop (`describe-interop.test.ts`):

- **Extend the existing `candidate-cap` scenario** with the *default* assertion
  (`render(describe()) === git describe`), reconstructing `side-3` from the
  structured `DescribeResult` — the byte-for-byte faithfulness pin for 23.4n.
- **Add the convergence scenario** (`ay`/`bee`/`old`) asserting default
  describe == real `git describe` (`ay-2`).

Mutation: target 0 surviving mutants on `describe.ts`. The cond-1 `||`, the
`>= minPriority`, the `counter - 1`, the `pickWinner`/`finishWinnerDepth`
guards, and the `winner === undefined` short-circuit are all order- and
data-sensitive; the freeze/finalise split is exercised by the 2→3 lift test.
No new `// Stryker disable` annotations.

No property-test obligation: the touched code is a traversal/aggregator, not a
parse/serialise pair (the priority queue already carries
`priority-queue.properties.test.ts`). If mutation reveals an under-pinned
frontier invariant, a composition-style invariant test is the fallback before any
suppression.

## Out of scope / non-goals

- The `annotated_cnt && queue_empty` early break (cond 2) — omitted as
  observationally inert (above); pinned by the convergence interop scenario. Its
  **performance** half (git's early-termination, so a shallow tag in a deep
  history doesn't walk all of history) is deferred to **26.2a** (Option B) per the
  ADR — pure perf, output already identical.
- The debug `traversed` / `gave up search` counters — git stderr diagnostics with
  no structured-data analogue (ADR-249).
- 23.4m (`UnmergedEntry` worktree mode) — unrelated deferred item.
