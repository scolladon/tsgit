# Design — commit-priority-queue-heap: O(N²) sorted-array → O(N log N) binary heap

> Brief: migrate the shared date-ordered commit priority-queue
> (`domain/commit/priority-queue.ts`) from an O(N) sorted-array `enqueue`
> (`splice`) + O(N) `shift` pop → O(N²) over N commits, to a binary min-heap →
> O(N log N). Preserve each consumer's **exact** tie-break order; offer a
> FIFO-stable variant so `bisect-midpoint.ts` can converge onto the shared
> structure. Behaviour-preserving; pinned by the existing bisect interop
> goldens; profile to confirm the win before committing the churn.
> Status: draft → self-reviewed ×3 → decisions ratified (ADR-465, ADR-466, ADR-467) → revised against ADRs

## Context

`src/domain/commit/priority-queue.ts` (30 lines, consolidated from three inline
copies — see `docs/design/consolidate-commit-priority-queue.md`) keeps commits
ordered newest-committer-date-first with an oid-ascending tie-break:

```ts
export const precedes = (a: Ordered, b: Ordered): boolean =>
  a.date > b.date || (a.date === b.date && a.oid < b.oid);

export const enqueue = <T>(queue: QueueEntry<T>[], entry: QueueEntry<T>): void => {
  let i = 0;
  while (i < queue.length && !precedes(entry, queue[i]!)) i += 1;
  queue.splice(i, 0, entry);        // O(N) scan + O(N) array shift
};
```

There is **no `dequeue` export**; every consumer pops with `queue.shift()`
(O(N) re-index). So each enqueue is O(N) and each dequeue is O(N): over N
commits the walk is **O(N²)**. Canonical git uses a binary min-heap
(`prio_queue` in `prio-queue.c`): `prio_queue_put`/`prio_queue_get` are each
O(log N) → **O(N log N)** total.

### The consumers of the shared queue

Three consumers use the shared date queue today (tabulated below); `bisect`
becomes a fourth this PR by converging onto the shared heap (ADR-466, §below).

| # | Consumer | File | enqueue site | pop site | Order-sensitivity of *output* |
|---|----------|------|-------------|----------|-------------------------------|
| 1 | `commitDateWalk` (log / describe / name-rev / shortlog / range-diff / whatchanged) | `application/primitives/internal/commit-date-walk.ts` | `enqueue(walk.queue, { oid, date: committer.timestamp, value: commit })` (~L126) | `walk.queue.shift() as QueueEntry<Commit>` (~L86) | order-independent (see below) |
| 2 | `mergeBase` | `application/primitives/merge-base.ts` | `enqueue(queue, { oid: id, date, value: undefined })` (~L62) | `const { oid: id } = queue.shift()!` (~L67) | order-independent (drains via `hasNonStale`) |
| 3 | `blame` | `application/commands/blame.ts` | `enqueue(sb.queue, { oid: commit, date, value: {…} })` (~L357) | `sb.queue.shift() as QueueEntry<Suspect>` (~L235) | order-independent (scoreboard, date-priority) |

One structure is **not** a consumer of the shared date queue and stays out of scope:

- `application/primitives/walk-commits.ts` — a plain topo / first-parent FIFO
  (`push`/`shift`, **no date ordering**). Different scheduling concern; the
  23.3a architecture pass already ruled it correctly separate.

A fourth consumer **joins** the shared queue this PR:

- `application/primitives/bisect-midpoint.ts` — today runs its **own** local
  FIFO-stable sorted-array walk (`WalkEntry { id, date, ins }`,
  `entryPrecedes` = `date desc, ins asc`, `enqueueWalkEntry` splice,
  `walkQueue.shift()`). ADR-430 kept it "intentionally not shared" only because
  the shared queue baked in an **oid** tie-break; ADR-465's comparator-parameterised
  heap removes that reason, so **bisect converges onto the shared `BinaryHeap`**
  this PR (decided — ADR-466, which amends ADR-430's "not shared" clause). It
  constructs the heap with its own `(date desc, ins asc)` comparator, keeping the
  `ins` counter as the equal-date tie-break key; the local `WalkEntry` /
  `entryPrecedes` / `enqueueWalkEntry` are deleted.

The bisect walk suffers the **same O(N²)** — `enqueueWalkEntry` is the identical
linear-scan splice, and `walkCandidatesNewestFirst` pops with `shift()` — so
convergence gives it the O(N log N) win too.

## Why the tie-break is faithfulness-load-bearing (pinned empirically)

The shared queue's `(date desc, oid asc)` comparator is **faithful only for
order-independent consumers**. For an order-sensitive walk, git breaks equal-date
ties by **insertion order (FIFO)**, not oid. Pinned against real git 2.55.0 in a
`mktemp` throwaway (scrubbed `GIT_*`, `GIT_CONFIG_NOSYSTEM=1`, signing off):

```
Topology:  root ← a1(ts=+1) ← a2(ts=+3) ┐
                                          M = merge, parents [b2, a2]  (b-first)
           root ← b1(ts=+2) ← b2(ts=+3) ┘
  a2 = ae9a65785…  b2 = effc61f9b…   (a2.oid < b2.oid lexicographically)

git rev-list --date-order  ⇒  emits  b2  then  a2
  → FIFO: b2 came from M's parent[0], enqueued first, pops first.
  → oid-ascending would emit a2 first (ae9a < effc) — the OPPOSITE.
```

So the FIFO tie-break and the oid tie-break **disagree** on this diamond. This is
exactly why `bisect-midpoint.ts` needs its own `ins` counter and cannot use the
shared oid comparator today. Consumers 1–3 are unaffected because their *output*
is invariant under equal-date reordering of the frontier (argued in §Behaviour
preservation below), which the 23.3a consolidation already established and the
mutation suite already proves (blame's unit test kills every `precedes`/`enqueue`
mutant with zero suppressions; describe/merge-base carry documented
equivalent-mutant annotations on their *other* logic, not the comparator).

The regression net for the FIFO order already exists:
`test/integration/bisect-midpoint-interop.test.ts` pins **both** merge
directions of the equal-date diamond against `git rev-list --bisect` /
`--bisect-vars` (b-first → git picks a2; a-first → git picks b2). A naive
oid-ascending tie-break fails at least one of the two — that is the guard.

## Empirical profiling finding — the existing benches will NOT show the win

The O(N²) only bites when the **frontier is wide** — many entries live in the
queue simultaneously (concurrent equal-date branches, octopus merges, a bushy
DAG). On a linear history the frontier is width ≈ 1: `enqueue` scans one element
and `shift` re-indexes one element, so sorted-array and heap are both effectively
O(1) per step and O(N) overall — **no measurable difference**.

The scaled bench fixtures are **strictly linear** (verified in
`test/bench/support/fixture-generator.ts`: `commit refs/heads/main`, one parent
per commit, timestamps `BASE_TIMESTAMP + commit`). So `log-scale.bench.ts`,
`describe.bench.ts`, and `name-rev.bench.ts` walk a width-1 frontier and **cannot
demonstrate the heap win** — they would show a wash (or a tiny heap-overhead
regression from the extra sift bookkeeping). This finding is the *rationale* for
why the profiling gate rests on the asymptotic argument rather than a new
measurement: the existing suite shows a wash by construction, so it can only serve
as a **no-regression** guard, not as a demonstration of the win (ADR-467).

Frontier width, precisely: at any pop the queue holds the "open tips" of the
reachability wavefront. For a repo with `B` long-lived concurrent branches
(release lines, feature branches merged late), the frontier peaks near `B`, and
the per-step cost is O(frontier). A 500-branch monorepo history is where
O(frontier²·depth) hurts and O(depth·log frontier) wins — the regime the
asymptotic argument (git's own `prio_queue` is O(N log N)) covers without an
in-repo fixture.

## Approach (structure and API)

The API **must** move off `Array.shift()` — a raw array cannot pop in O(log N).
The chosen shape (ADR-465, decision A) is a generic `BinaryHeap<T>` in
`src/domain/commit/`, parameterised by an injected `less(a, b)` comparator and
exposing `push`/`pop`/`size` plus an unsorted `entries()` view; it stays internal
(relative-import only, not re-exported through any barrel). Its core:

- A binary **min-heap by "should pop first"**: the root is the entry that
  `precedes` all others. `push` appends then sifts up; `pop` swaps root↔last,
  pops last, sifts the new root down. Both O(log N). The comparator is `less(a, b)
  = precedes(a, b)` — a `true` means `a` outranks (pops before) `b`.
- The backing array is **mutated in place** (sift swaps), exactly as today's
  `splice`/`shift` already mutate. This is a local, fully-encapsulated mutation
  (ADR-465, decision E).

### API surface beyond push/pop — frontier iteration (load-bearing)

Two consumers scan the **whole** queue, not just the head, and the heap must
expose that:

- `merge-base` — `hasNonStale(queue, flags)` does `queue.some((entry) =>
  … flags.get(entry.oid) …)` to decide the drain-stop; **order-independent**
  (`.some` over the entry set).
- `commitDateWalk` → describe — `DateWalkStep.frontier = () =>
  walk.queue.map((entry) => entry.oid)` snapshots the queued oids; describe
  consumes it as `step.frontier().every((oid) => …)` (a set predicate) plus a
  `frontierEmpty` emptiness check — both **order-independent** over the frontier.

Because both uses are order-independent over the entry *set*, the heap can expose
its **unsorted backing entries** directly (a readonly view / iterator) — no sort
required. The heap therefore needs `entries()` (or `[Symbol.iterator]`) alongside
`push`/`pop`/`size`. This is why the migration is not a pure `shift`→`pop`
swap for these two consumers: their frontier scans must retarget onto the heap's
entry view. (`blame` reads only `.value` at the head, so it needs pop only.)

### FIFO variant

For bisect's `(date desc, ins asc)` order, the heap takes a **different
comparator**. The heap is comparator-parameterised, so "FIFO-stable" is not a
second data structure — it is the same heap constructed with
`entryPrecedes`-equivalent `less`. The `ins` monotonic counter stays the
tie-break key (it is already unique and monotonic by construction). **Bisect
adopts this and converges onto the shared heap this PR** (decided — ADR-466,
amends ADR-430).

### What does NOT change

- No SHA, ref, reflog, on-disk state, refusal, or output changes anywhere.
  Pop **order** is byte-identical for every consumer (proof below), so every
  downstream result is identical.
- `QueueEntry<T>` payload shape is unchanged.
- The module stays internal (relative-import only, not re-exported through any
  barrel) → `reports/api.json` is unaffected.

## Behaviour preservation — pop-order identity proof

**Claim:** a binary heap ordered by a comparator `less` yields the *same pop
sequence* as the sorted-array `enqueue`+`shift` ordered by the same `less`,
**provided `less` induces a strict total order on the entries actually enqueued**
(no two distinct enqueued entries are `less`-incomparable, i.e. no ties that
`less` cannot break).

Under a strict total order there is a unique minimum at every step, so both
structures must pop that unique minimum — the sequences coincide element for
element. The only way a heap and a sorted array diverge is when `less` reports
`false` in *both* directions for two distinct entries (a genuine tie): then the
sorted-array insert falls back to **insertion order** (stable splice at the first
non-preceding slot), while a naive heap does not preserve insertion order. So the
proof reduces to: **can two distinct enqueued entries tie under the comparator?**

The consumers split into **two** correctness classes — this distinction is
load-bearing (a reviewer/ADR must not conflate them):

**Class I — strict total order on the enqueued set (pop order identical by the
claim above).**

- `commitDateWalk` — the `seen` set is added-to *before* `enqueueCommit`
  (`enqueueSeeds`, `enqueueParents`) → each oid is enqueued **at most once** → no
  equal-oid pair exists → `(date desc, oid asc)` is a strict total order → heap
  and sorted array pop the identical sequence. (Faithfulness note: the walk's
  *output order* is what describe/name-rev/log observe; it is byte-identical.)
- `blame` — suspects carry distinct `commit` oids per schedule and a finalized
  suspect is never re-enqueued → at most one entry per oid → strict total order →
  identical pop sequence.
- `bisect` (converges onto the shared heap — ADR-466) — `(date desc, ins asc)`;
  `ins` is `ins++` at each enqueue → **unique and monotonic**, no two entries
  share an `ins` → strict total order → identical pop sequence. The existing
  `equivalent-mutant` annotations in `bisect-midpoint.ts` already assert exactly
  this ("newly enqueued entries always receive the highest ins").

**Class II — NOT a strict total order; correctness rests on
result-order-independence.**

- `merge-base` — **`merge-base genuinely re-enqueues the same oid.`** `mark(id,
  bits)` unconditionally `enqueue`s, and `paint`'s parent loop re-`mark`s a parent
  whenever it gains *new* flag bits (`((flags.get(parent) & f) === f)` skips only
  a parent that *already* carries every bit in `f`). A commit first reached as
  PARENT1 and later as PARENT2 is enqueued **twice**, same oid, same date → a
  genuine `(date, oid)` tie. So `(date desc, oid asc)` is **not** a strict total
  order here, and heap vs sorted-array **may pop the two equal-oid duplicates in a
  different relative order.** This is safe because merge-base's result is
  **order-independent**: it drains via `hasNonStale` (a set predicate over
  flags), flags accumulate monotonically (bit-OR, idempotent), and the `RESULT`/
  `STALE` set is invariant under any pop order of equal-priority entries — which
  is exactly what the module's existing Stryker *equivalent-mutant* annotations on
  its walk already assert. The heap therefore yields the identical **result**,
  though not necessarily an identical intermediate pop sequence.

**Corollary — plain (non-stable) heap suffices for all consumers.** Class I needs
no tie-break (strict total order → no ties). Class II (merge-base) has ties but is
result-invariant under any tie resolution, so a stable heap buys nothing there
either. git's own `prio_queue` is likewise non-stable — its FIFO behaviour comes
from the `ins`-style insertion counter baked into the compare, mirrored here by
bisect's `ins` key. **We do not implement a stable heap.**

**Counterexample search — none found.** The one place heap and sorted array can
diverge in pop *order* is merge-base's equal-oid duplicates (Class II), and that
divergence is provably absorbed by result-order-independence. The mutation pass
must confirm merge-base stays green under the heap (its order-independence
annotations are the guard); if any survives that was previously killed, that
flags a real order dependence to investigate — recorded as the sharpest
re-check, not a blocker.

## Faithfulness pinning matrix

Behaviour-preserving migration → **no new git behaviour to pin**; the guard is
that existing goldens stay green. Recorded matrix (all against real git 2.55.0,
`mktemp` throwaway, scrubbed env, signing off):

| Probe | git command | git output | tsgit invariant |
|-------|-------------|-----------|-----------------|
| equal-date diamond, b-first merge (parents `[b2,a2]`) | `git rev-list --date-order HEAD` | `b2` before `a2` (FIFO, **not** oid — `a2.oid < b2.oid`) | bisect FIFO walk picks a2; `bisect-midpoint-interop.test.ts` b-first fixture |
| equal-date diamond, a-first merge (parents `[a2,b2]`) | `git rev-list --bisect` | picks b2 | `bisect-midpoint-interop.test.ts` a-first fixture |
| unequal-date diamond (a2 older) | `git rev-list --bisect-vars` | picks a2, counts match | `bisect-midpoint-interop.test.ts` unequal fixture |

These interop cases are the FIFO-order regression guard. They already exist and
must stay green unchanged.

## Test plan

- **Unit — heap.** New `heap` unit tests replacing/extending
  `test/unit/domain/commit/priority-queue.test.ts`: empty, single, ascending /
  descending / shuffled insert sequences drain in comparator order; equal-date
  oid tie-break; equal-date FIFO tie-break (the FIFO variant); `size`/`length`
  reflects push/pop. Keep the existing `precedes` cases (date dominance, oid
  tie-break, full-equality) — they still document the comparator.
- **Property — heap-pop ≡ sorted-array-pop.** The heap is a total function over
  an algebraic order → **round-trip / invariant lens** (CLAUDE.md lens 1 & 2).
  Extend `test/unit/domain/commit/priority-queue.properties.test.ts`:
  - *Sorting oracle:* `drain(heapPush*(entries)) ≡ entries.sort(byPrecedes)` for
    arbitrary entries (the heap is an independently-testable sorting oracle — not
    a tautology, since the oracle is `Array.sort`, not the production loop).
  - *Invariant:* every popped element `!precedes(next, current)` (no element
    outranks its predecessor) — the same invariant the existing property asserts
    for the sorted insert, now over the heap.
  - Tiered `numRuns`: 200 (cheap pop-order round-trip), 100 (invariants).
- **Interop — unchanged, must stay green.** `bisect-midpoint-interop.test.ts`
  (all four diamond fixtures) is the faithfulness net. Bisect converges
  (ADR-466), so these now exercise the shared FIFO heap's `(date desc, ins asc)`
  comparator directly — they remain the FIFO-order regression guard and must stay
  green unchanged.
- **Regression — every consumer.** Existing unit + interop suites for log,
  describe, name-rev, shortlog, range-diff, whatchanged, merge-base, blame stay
  green unchanged (behaviour-preserving).
- **No-regression bench guard (ADR-467).** The existing linear bench suite
  (`log-scale.bench.ts`, `describe.bench.ts`, `name-rev.bench.ts`) must not
  regress beyond noise — this is the (b) half of the profiling gate. No net-new
  wide-frontier bench fixture is built (ADR-467); the win rests on the asymptotic
  argument, not an in-repo measurement.
- **Mutation.** Re-run Stryker on the heap module + touched consumers; target 0
  surviving killable mutants. The heap's sift-up/sift-down comparisons must be
  killed by the pop-order property + unit tests. Re-verify no equal-oid /
  equal-ins tie can be enqueued (the proof above) — if a mutant survives on a
  tie-break sub-expression, it is a genuine equivalent only if the strict-total-
  order argument holds for that consumer; document, don't suppress.

## Profiling gate (decided — ADR-467, ships on the asymptotic argument)

The brief mandates "profile to confirm the win before committing the churn."
**ADR-467 settles how that gate is discharged: on the asymptotic argument, with
no net-new wide-frontier benchmark fixture** (this deviates from an earlier draft
recommendation to build a bushy-DAG micro-bench — the deviation is the substance
of ADR-467). The gate is satisfied by two conditions, both required:

- **(a) The complexity argument.** The migration reproduces git's `prio_queue`
  behaviour — O(log N) per put/get, O(N log N) over N commits — an established
  result. On a wide frontier the sorted array is O(frontier²·depth) and the heap
  is O(depth·log frontier); the win is *argued from complexity*, not measured in a
  new in-repo fixture.
- **(b) No regression on the existing linear bench suite.** `log-scale.bench.ts`,
  `describe.bench.ts`, and `name-rev.bench.ts` walk a width-1 frontier
  (§Empirical profiling finding) — the overwhelmingly common case, and the one a
  heap could plausibly *slow* via sift bookkeeping. The heap must not regress them
  beyond noise. A **material narrow-frontier regression is a blocker**: the shared
  structure serves linear histories overwhelmingly, so a net loss there sinks the
  change regardless of the argued wide-frontier win.

**Deliberately NOT built (ADR-467).** The net-new wide-frontier micro-bench
fixture the earlier draft proposed — a bushy DAG with `B ∈ {8, 64, 512}`
concurrent branches, `priority-queue-frontier.bench.ts` driven through
`scaledScenario` — is **not** added in this change. No bench fixture or
scenario-glue churn rides along with the structural change. Should a future change
need the empirical curve, a bushy-DAG bench can be added then without disturbing
this decision.

## Non-goals

- No first-class rich collection API beyond `push`/`pop`/`size`/`entries()`
  (ADR-465) — YAGNI; only the operations the consumers need (`entries()` is the
  unsorted frontier view the two frontier-scanning consumers require).
- No change to `walk-commits.ts` (topo FIFO, not date-ordered) or to git's
  randomised bisect `skip` reshuffling (stays the consumer's, per ADR-430).
- No public-API surface change (`reports/api.json` untouched).
- No date-monotonicity semantics change: `commitDateWalk` keeps its documented
  lazy, monotonic-date assumption (it does not enforce git's strict
  all-children-before-parent rule for forged reverse-causal dates) — the heap
  preserves the same order the sorted array produced, so this edge behaviour is
  unchanged.

---

## Decisions (settled — see ADRs)

Every load-bearing choice below is now **decided**. The alternatives and analytic
content are retained (they remain load-bearing for the plan — the two-class
pop-order proof and the FIFO-vs-oid empirical pin), each annotated with its
ratified outcome and ADR reference. Candidates A, C, E → ADR-465; B → ADR-466
(amends ADR-430); D → ADR-467.

### A. Heap structure / API shape — DECIDED (ADR-465): option 1, `BinaryHeap<T>`

The API must move off `Array.shift()` to encapsulated `push`/`pop`. Three shapes:

1. **Generic `BinaryHeap<T>` parameterised by a `less(a, b)` comparator**
   (`push`, `pop`, `size`). Each consumer constructs it with `precedes` (or
   bisect's `entryPrecedes`). One structure, one comparator injection point.
   *Consumer ripple:* every consumer swaps its `QueueEntry<T>[]` +
   `enqueue(...)` + `.shift()` for `heap.push(...)` + `heap.pop()` +
   `heap.size`; ~2 call-site edits + 1 construction each. **4 call sites** total
   (bisect converges — ADR-466): the 3 shared-queue sites —
   `commit-date-walk.ts:126/86`, `merge-base.ts:62/67`, `blame.ts:357/235` —
   plus `bisect-midpoint.ts`.
2. **A `CommitPriorityQueue` class baking in `precedes`, plus a separate
   `FifoCommitPriorityQueue`** (or a boolean/enum "mode" — rejected: boolean
   param is a house smell). Two named types; the FIFO one carries the `ins`
   counter internally. *Ripple:* similar call-site churn, but two classes to
   test and the FIFO/date split is a type-level distinction rather than a
   comparator argument.
3. **Keep free-functions-over-array but swap the algorithm** — `enqueue`/a new
   `dequeue` implement heap sift on the raw array in place. *Ripple:* smallest —
   consumers keep `QueueEntry<T>[]` and swap `.shift()` for `dequeue(queue)`, and
   the frontier scans (merge-base `.some`, describe `.map`/`.every`) keep working
   verbatim on the exposed array. But that exposed array is a footgun: a caller
   could still `.shift()`/`.splice()`/`.push()` it and silently corrupt the heap
   invariant — the very `.shift()` we are removing stays reachable.

   Note the frontier requirement (§API surface) cuts *both* ways: option 1 must
   add an `entries()` view for the two frontier consumers; option 3 gets it for
   free but at the cost of an unprotected invariant.

**Decision (ADR-465): (1) generic `BinaryHeap<T>` with injected `less`.** It is the
single structure that serves both the oid and the FIFO comparators without
duplicating the heap logic, encapsulates the backing array (killing the
`.shift()`-corruption footgun of option 3), and stays FP-friendly (comparator is
a pure function argument). It directly enables decision B (bisect converges by
passing `entryPrecedes` as `less`). Trade-off vs option 3: more call-site churn
across the consumers, but each edit is mechanical and the encapsulation win is
real. Ratified as recommended; the heap exposes `push`/`pop`/`size` plus an
unsorted `entries()` view, lives in `src/domain/commit/`, and stays internal
(relative-import only, not re-exported through any barrel).

### B. Does bisect converge onto the shared heap this PR? — DECIDED (ADR-466): option 1, converge now

1. **Converge now** — migrate `bisect-midpoint.ts` to the shared `BinaryHeap`
   constructed with `(date desc, ins asc)` `less`; delete the local
   `WalkEntry`/`entryPrecedes`/`enqueueWalkEntry`. **Amends ADR-430** (the "not
   shared" clause). Bisect gets the O(N log N) win too and the equal-date diamond
   goldens now guard the shared structure directly.
2. **Heap becomes capable, bisect stays local this PR** — build the
   comparator-parameterised heap, migrate consumers 1–3, but leave bisect on its
   local walk (still O(N²)) for a follow-up. Smaller blast radius; ADR-430 stays
   as-is.
3. **Never converge** — keep bisect permanently separate on principle
   (ADR-430 unchanged), heap serves only the oid-comparator consumers.

**Decision (ADR-466, amends ADR-430): (1) converge now.** The brief explicitly
asks to "offer a FIFO-stable heap variant so bisect can converge," the pop-order
identity proof holds for `(date desc, ins asc)` (unique monotonic `ins` → strict
total order), the both-direction diamond goldens already exist as the exact
regression net, and bisect suffers the identical O(N²) so it benefits equally.
Convergence removes a duplicated structure (DRY) rather than perpetuating
rule-of-two. `bisect-midpoint.ts`'s candidate walk moves to the shared
`BinaryHeap<WalkEntry>` constructed with `a.date > b.date || (a.date === b.date
&& a.ins < b.ins)`; the local `WalkEntry` / `entryPrecedes` / `enqueueWalkEntry`
are deleted, and the `ins` counter stays the equal-date tie-break key so the
candidate-list order is unchanged. This amends ADR-430's "intentionally not
shared" clause; ADR-430's tie-break *semantics* and the verbatim `find_bisection`
port stand.

### C. Behaviour-preservation proof basis — DECIDED (ADR-465): option 1, plain non-stable heap

1. **Two-class argument, plain heap** (adopted in §Behaviour preservation):
   Class I consumers (`commitDateWalk`, `blame`, bisect) have a strict total order
   on the enqueued set (oids `seen`-unique; `ins` unique+monotonic) → identical
   pop sequence. Class II (`merge-base`) genuinely re-enqueues equal-oid
   duplicates but is result-order-independent → identical *result*. Plain
   (non-stable) heap suffices for both.
2. **Stable heap as insurance** — implement a tie-breaking-by-insertion-sequence
   heap so even merge-base's equal-oid duplicates pop in sorted-array order.
   Costs an extra per-entry sequence field + comparison, and buys nothing
   observable (merge-base's result is already order-invariant).

**Decision (ADR-465): (1) two-class argument, plain heap.** Class I is a clean
strict total order; Class II's only ties (merge-base equal-oid duplicates) are
absorbed by result-order-independence, which the module's existing Stryker
annotations already assert and the mutation pass re-verifies. git's own
`prio_queue` is non-stable, so a stable heap would over-engineer past
faithfulness. Adopted as recommended; **no stable heap is implemented.**

### D. Profiling gate — what evidence justifies the churn — DECIDED (ADR-467): option 3, ship on the asymptotic argument (DEVIATES from this doc's earlier recommendation)

1. **Wide-frontier micro-bench + narrow-frontier regression check** (§Profiling
   gate): new bushy-DAG fixture, `B ∈ {8, 64, 512}`; justify iff ≥ 2× at `B=512`
   **and** no worse than a few % regression at `B=8` / linear.
2. **Real-command bench only** — run `mergeBase` / a date-walk over a bushy
   fixture end-to-end; simpler, but noisier (I/O dominates, may mask the queue
   win).
3. **Ship on the asymptotic argument, no new bench** — trust O(N²)→O(N log N)
   and rely on existing (linear) benches for no-regression only.

**This doc recommended (1)** — a wide-frontier micro-bench with an explicit
threshold — reasoning that the brief makes profiling a gate and the existing
benches provably cannot show the win.

**Decision (ADR-467): (3) ship on the asymptotic argument — DEVIATES from the
recommendation above.** No net-new wide-frontier benchmark fixture is added. The
profiling gate is discharged by the complexity argument (the migration reproduces
git's `prio_queue` O(N log N), an established result) plus no regression on the
existing linear bench suite (`log-scale` / `describe` / `name-rev`) — the common
case, and the one a heap could plausibly slow. The empirical frontier-width
finding is retained as the *rationale* for why the existing benches show a wash;
the wide-frontier fixture (`priority-queue-frontier.bench.ts`, bushy DAG,
`B ∈ {8, 64, 512}`) is deliberately **not built**. A material narrow-frontier
regression remains a blocker. See the revised §"Profiling gate" above.

### E. Immutability vs in-place heap mutation — DECIDED (ADR-465): option 1, in-place encapsulated mutation

1. **In-place mutation, locally encapsulated** — the heap mutates its backing
   array (sift swaps), exactly as today's `splice`/`shift` already do. The
   mutation never escapes the heap object (with option A.1) so it is invisible to
   callers and the domain's "immutable by default" is satisfied at the boundary.
2. **Persistent / immutable heap** — every `push`/`pop` returns a new heap
   (structural sharing or copy). Pure, but allocates O(log N)–O(N) per operation,
   erasing much of the asymptotic win and adding GC pressure on the hot path.

**Decision (ADR-465): (1) in-place, encapsulated.** The house style is "immutable
by default" with local encapsulated mutation explicitly acceptable for performance
primitives (the hot-path perf precedent — the inflate decoder — mutates freely
inside its boundary). The current sorted array already mutates in place; the heap
keeps the same containment. A persistent heap would defeat the performance goal
that is the entire point of this change. Adopted as recommended.
