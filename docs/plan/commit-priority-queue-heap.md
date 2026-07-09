# Plan — commit-priority-queue-heap: O(N²) sorted-array → O(N log N) binary heap

> Source: design doc `docs/design/commit-priority-queue-heap.md` · ADRs `465, 466, 467`
> The plan is the implementation script AND the knowledge handoff. Part agents start
> with zero context: whatever a part block omits is paid later as agent rediscovery.
> `plan-lint.sh` enforces the schema below — the plan phase cannot close without it.

## Sizing rules

- Every part costs a full agent lifecycle (spin-up, zero-context rebuild, gate) — it
  must earn it. No standalone test-only parts for FEATURE code: coverage/interop/property
  tests fold into the implementation part whose code they exercise. EXCEPTION:
  test-infra-only and docs-only parts (tooling config, test helpers, fixtures,
  harness/ADV/property suites, docs/prose) with no `src/` delta ARE standalone — they
  have no implementation part to fold into.
- A part that would be a pure test pass over already-landed code merges into its
  neighbour.

## Orientation (whole-change map — every part shares this)

Migrate the shared date-ordered commit priority-queue from an O(N) sorted-array
`enqueue` + O(N) `shift` (O(N²) over N commits) to a comparator-parameterized binary
min-heap (O(N log N)). Behaviour-preserving: pop **order** is byte-identical for every
consumer (proof: design §"Behaviour preservation"). No SHA/ref/reflog/state/output
change; `reports/api.json` untouched (the heap is internal, relative-import only).

**Settled decisions (do NOT reopen — ADR-465/466/467):**
- Generic `BinaryHeap<T>` parameterized by injected `less(a,b): boolean` (`true` ⇒ `a`
  pops first). Exposes `push`/`pop`/`size`/`entries()` (unsorted frontier view). Internal
  module, relative-import only, NOT re-exported through any barrel (no `domain/commit/index.ts`
  exists — verified). ADR-465.
- Plain **non-stable** heap. No stable-heap machinery. The pop-order-identity proof rests
  on Class I (strict total order → no ties) / Class II (merge-base result-independence). ADR-465.
- In-place encapsulated mutation of the backing array (sift swaps). ADR-465.
- Bisect **converges** onto the shared heap with `less = (a,b) => a.date>b.date ||
  (a.date===b.date && a.ins<b.ins)`; delete its local `WalkEntry`/`entryPrecedes`/
  `enqueueWalkEntry`. ADR-466 (amends ADR-430, keeps its tie-break semantics).
- Ship on the **asymptotic argument** (ADR-467): NO new wide-frontier bench fixture. The
  only bench obligation is NO REGRESSION on the existing linear bench suite. Do NOT create
  `priority-queue-frontier.bench.ts`.

**Public-surface decision (up front, ADR-465):** `BinaryHeap<T>` and its members are
**INTERNAL** — imported by relative path only, never re-exported through any barrel.
Consequence: **zero surface gates apply.** `reports/api.json` is unaffected; no
`src/domain/commit/index.ts` barrel exists to update; no facade/doc-coverage/browser-surface
row. Verified: `grep -rn priority-queue` shows only three relative `src/` importers plus
tests; there is no `domain/commit/index.ts`. The new file `binary-heap.ts` follows the same
internal convention — do NOT add it to any barrel.

**Part order & why (sequential, one shared worktree):**
1. Create `BinaryHeap<T>` + its unit/property tests. Leaves `priority-queue.ts`/consumers
   untouched → validate green.
2. Migrate the three oid consumers (`commit-date-walk`, `merge-base`, `blame`) onto the heap
   AND delete `enqueue` from `priority-queue.ts` in the same part — `enqueue` must die
   atomically with its last consumer (deleting it earlier reds the others; a separate
   later no-op pass is a smell). Regression coverage folds in.
3. Converge bisect onto the shared heap; delete its local structure. Separable: wholly
   different local structure, its own interop net.

**Phase-level obligations (NOT per-part gates — do not create parts for these):**
- **No-regression bench guard (ADR-467):** the existing linear bench suite
  (`test/bench/log-scale.bench.ts`, `describe.bench.ts`, `name-rev.bench.ts`) must not
  regress beyond noise. NO new wide-frontier fixture. This is checked at the review/perf
  phase, not in a part gate. A material narrow-frontier regression is a blocker.
- **Mutation (ADR-465):** the heap's sift comparisons must be mutation-killed by Part 1's
  unit + property tests; the two merge-base and blame `equivalent-mutant` annotations stay.
  Verified at the mutation phase (gates the PR), not in a part gate.
- **Coverage:** `binary-heap.ts` is domain code → 100% line/branch/function/statement
  coverage is enforced by `npm run test:coverage`. Part 1's tests must exercise every
  branch (empty-pop, sift-up, sift-down two-children / one-child, equal-key tie).

---

## Part 1 — Create the generic BinaryHeap

### Context

**Create** `src/domain/commit/binary-heap.ts` — a new INTERNAL module (relative-import
only, NOT barrelled; there is no `src/domain/commit/index.ts` and none is created).

Reference the existing shared queue it will replace, `src/domain/commit/priority-queue.ts`
(read it — 30 lines). It currently exports:
- `interface QueueEntry<T> { readonly oid: ObjectId; readonly date: number; readonly value: T }`
  — KEEP unchanged, used by three consumers. Import `ObjectId` from `../objects/index.js`.
- `interface Ordered { readonly date: number; readonly oid: ObjectId }` (module-private).
- `export const precedes = (a: Ordered, b: Ordered): boolean => a.date > b.date ||
  (a.date === b.date && a.oid < b.oid)` — KEEP; it becomes the injected `less` for the
  three oid consumers in Part 2. Do NOT touch it in this part.
- `export const enqueue = <T>(queue, entry): void` (sorted-array splice) — NOT touched in
  this part; deleted in Part 2 when its last consumer migrates.

**The heap to build** (ADR-465, design §"Approach"):
```ts
export class BinaryHeap<T> {
  constructor(less: (a: T, b: T) => boolean)
  push(value: T): void      // append then sift-up; O(log N)
  pop(): T | undefined      // swap root↔last, pop last, sift-down new root; O(log N)
  size(): number
  entries(): ReadonlyArray<T>   // UNSORTED backing-array view (frontier scans); NO sort
}
```
- Min-heap "by should-pop-first": root is the entry that `less`-precedes all others.
  `less(a,b) === true` means `a` outranks (pops before) `b`.
- Backing array mutated **in place** (sift swaps) — fully encapsulated behind push/pop
  (ADR-465 decision E). This is a local, escape-free mutation; the domain's
  immutable-by-default holds at the object boundary. Follow the house perf-primitive
  precedent (the inflate decoder mutates freely inside its boundary).
- `entries()` returns the backing array as a `ReadonlyArray<T>` view — NO sort, NO copy
  needed beyond the readonly cast. Its consumers scan it as an order-independent **set**
  (Part 2), so unsorted is correct and intended.
- Standard array-backed heap indexing: parent `(i-1)>>1`, children `2i+1`/`2i+2`. Sift-up
  compares child vs parent with `less`; sift-down picks the `less`-smaller of the two
  children and swaps while it outranks the current node.
- `pop()` on empty returns `undefined` (mirrors `Array.shift()` on empty, which the current
  consumers' `while (size>0)` guards already gate).
- **No `any`.** Generic `T`, injected comparator. Small functions (<20 lines), early
  returns, no nesting >2 (extract sift-up/sift-down as private methods or module helpers).
  The comparisons in sift-up/sift-down are load-bearing and MUST be mutation-killed by the
  tests below (no suppressions).

**Tests — fold in here** (feature code + its tests in one part):

1. `test/unit/domain/commit/binary-heap.test.ts` (NEW). Model on the existing
   `test/unit/domain/commit/priority-queue.test.ts` conventions (read it): `oid = (char) =>
   char.repeat(40) as ObjectId`, GWT describe/it split, AAA body, `sut` names the SUT.
   Use a simple numeric or `{date,oid,value}` `T` with an explicit `less`. Cover:
   - empty heap: `size()` is 0, `pop()` is `undefined`, `entries()` is `[]`.
   - single push/pop round-trips the element; `size()` tracks push (+1) and pop (−1).
   - ascending / descending / shuffled insert sequences all **drain in comparator order**
     (repeatedly `pop()` until empty, assert the popped sequence is sorted by `less`).
   - equal-key tie handling: with a `precedes`-style `less` (date desc, oid asc), equal-date
     entries drain oid-ascending (the oid tie-break); with a `(date desc, ins asc)` `less`,
     equal-date entries drain by ascending `ins` (the FIFO variant bisect will use in Part 3).
   - `entries()` returns every live element (assert as a **set** — sort before compare —
     NOT an ordered array; it is deliberately unsorted).
2. `test/unit/domain/commit/binary-heap.properties.test.ts` (NEW). Model on the existing
   `priority-queue.properties.test.ts` (read it) — `fast-check`, small alphabet
   (`constantFrom('a','b','c','d')` oids, `integer({min:0,max:4})` dates so ties recur),
   `entriesArb` mapping rows to `{...row, value: index}`. Property lens: the heap is a
   round-trip / total-function-over-an-order sorting oracle (CLAUDE.md lenses 1 & 2):
   - *Sorting oracle* (numRuns **200**): `drain(pushAll(entries, less)) ≡
     entries.slice().sort(byLess)` — where `drain` pops until empty and `byLess` is a
     comparator derived from `precedes`. NOT a tautology: the oracle is `Array.sort`, not
     the production sift loop. Handle equal keys by making the sort stable-equivalent for
     the comparison basis, OR compare only the `precedes`-invariant projection so genuine
     ties don't spuriously fail (mirror how the existing property compares).
   - *Invariant* (numRuns **100**): every consecutively popped pair `(current, next)`
     satisfies `!less(next, current)` — no element outranks its predecessor (the same
     invariant the existing sorted-insert property asserts, now over the heap).
   - *No-drop / no-dup* (numRuns **100**): the multiset of popped values equals the multiset
     pushed (same values ignoring order) — mirror the existing "holds every entry exactly
     once" property.

`priority-queue.ts` (`precedes`, `enqueue`, `QueueEntry`, `Ordered`) and its two test files
stay UNCHANGED in this part — they still document the comparator and the (still-live)
`enqueue`. No consumer is migrated yet.

### TDD steps

- RED: write `binary-heap.test.ts` empty-heap + single-element + drain-in-order cases
  against a not-yet-existing `BinaryHeap`. Run `npx vitest run test/unit/domain/commit/binary-heap.test.ts`
  → fails: `BinaryHeap` is not exported / module `binary-heap.js` not found.
- GREEN: implement `src/domain/commit/binary-heap.ts` — `BinaryHeap<T>` with `less`-injected
  constructor, `push` (append + sift-up), `pop` (swap-last + sift-down), `size`, `entries()`.
  Minimal, no extras. Re-run → green.
- RED: add the tie-break cases (oid-asc `less` and `(date,ins)` `less`) and `entries()`
  set-membership case. Run → the tie-break drain assertions fail if sift comparisons are
  wrong; fix the sift comparator wiring. Re-run → green.
- RED: write `binary-heap.properties.test.ts` (sorting-oracle 200, pop-invariant 100,
  no-drop 100). Run `npx vitest run test/unit/domain/commit/binary-heap.properties.test.ts`
  → any counterexample shrinks and prints; fix the sift logic until the grammar round-trips.
- REFACTOR: extract sift-up / sift-down to named private methods or module-local helpers so
  each is <20 lines with no nesting >2; keep the backing array mutation encapsulated. Re-run
  both test files → green. Confirm no barrel edit (file stays relative-import-only).

### Gate

`npx vitest run test/unit/domain/commit/binary-heap.test.ts test/unit/domain/commit/binary-heap.properties.test.ts && npm run check:types && ./node_modules/.bin/biome check src/domain/commit/binary-heap.ts test/unit/domain/commit/binary-heap.test.ts test/unit/domain/commit/binary-heap.properties.test.ts`

### Commit

`feat: comparator-parameterized binary heap for commit priority queue`

## Part 2 — Migrate the three oid consumers onto the heap; delete sorted-array enqueue

### Context

Migrate the **three shared-queue consumers** from `enqueue(queue, entry)` + `queue.shift()`
+ raw-array frontier scans to `heap.push(entry)` + `heap.pop()` + `heap.entries()`, then
**delete** `enqueue` from `priority-queue.ts` (its last consumer is gone). All three inject
the SAME comparator, the existing `precedes` (`date desc, oid asc`), which stays exported.

Class assignment (design §"Behaviour preservation"): consumers 1 & 3 are **Class I** (strict
total order — oids `seen`-unique / suspect-unique → no ties → pop order byte-identical);
consumer 2 (`merge-base`) is **Class II** (genuinely re-enqueues equal-oid duplicates →
ties, but result is order-independent → identical *result*). Do NOT add stable-heap
machinery (ADR-465). The regression net is the consumers' existing unit + interop suites —
all must stay green unchanged.

**Consumer 1 — `src/application/primitives/internal/commit-date-walk.ts`** (read it):
- Import: line 1, `import { enqueue, type QueueEntry } from '../../../domain/commit/priority-queue.js'`.
  Change to import `precedes` + `QueueEntry` from `priority-queue.js` AND `BinaryHeap` from
  `'../../../domain/commit/binary-heap.js'`. `enqueue` import is dropped.
- `interface DateWalk` (L38–45): field `readonly queue: QueueEntry<Commit>[]` becomes
  `readonly heap: BinaryHeap<QueueEntry<Commit>>`.
- Construction (L74–80): `queue: []` becomes `heap: new BinaryHeap<QueueEntry<Commit>>(precedes)`.
  (`precedes(a,b)` accepts `Ordered = {date,oid}`; `QueueEntry` structurally satisfies it.)
- Pop loop (L84–95): `while (walk.queue.length > 0)` → `while (walk.heap.size() > 0)`;
  `walk.queue.shift() as QueueEntry<Commit>` → `walk.heap.pop() as QueueEntry<Commit>`.
- Frontier retarget: `frontierEmpty: walk.queue.length === 0` → `walk.heap.size() === 0`;
  `frontier: () => walk.queue.map((entry) => entry.oid)` → `() => walk.heap.entries().map((entry) => entry.oid)`.
- Enqueue site: `enqueueCommit` (L123–128) `enqueue(walk.queue, {...})` → `walk.heap.push({...})`.
  **PINNED behaviour — do NOT break:** `test/unit/application/primitives/internal/commit-date-walk.test.ts`
  L199 asserts `frontiers` equals `[[], [b], [a], []]` (ordered array). Every snapshot in
  that diamond holds **≤1 element**, so `entries()` order is irrelevant → the test stays
  green after the retarget. Do NOT rely on `entries()` being sorted; any multi-element
  frontier is consumed order-independently (describe reads it as a `.every` set predicate).
  L182–183 assert the pop *sequence* `[d,c,b,a]` / emptiness `[true,false,false,true]` — the
  strict-total-order (Class I) proof guarantees the heap reproduces this exactly.

**Consumer 2 — `src/application/primitives/merge-base.ts`** (read it):
- Import: line 1, same swap (`precedes` + `QueueEntry` from `priority-queue.js`, `BinaryHeap`
  from `binary-heap.js`; drop `enqueue`).
- `paint` (L53–86): local `const queue: QueueEntry<undefined>[] = []` (L59) →
  `const heap = new BinaryHeap<QueueEntry<undefined>>(precedes)`.
- `mark` (L60–63): `enqueue(queue, { oid: id, date: dateOf(await read(id)), value: undefined })`
  → `heap.push({ oid: id, date: dateOf(await read(id)), value: undefined })`. **Note (Class II):**
  `mark` enqueues unconditionally and `paint`'s parent loop re-marks parents that gain new
  bits → the SAME oid is pushed more than once by design. Keep that; do NOT dedup.
- Drain-stop retarget: `hasNonStale` (L38–45) takes `queue: readonly QueueEntry<undefined>[]`
  and does `queue.some(...)`. Change its parameter to accept the heap's entry view — either
  pass `heap.entries()` at the call site (L66 `while (hasNonStale(queue, flags))` →
  `while (hasNonStale(heap.entries(), flags))`) keeping `hasNonStale`'s signature as
  `readonly QueueEntry<undefined>[]`, OR change the param type to `ReadonlyArray<QueueEntry<undefined>>`.
  `.some` is order-independent → correct over the unsorted view. Preserve the existing
  `Stryker disable next-line all` equivalent-mutant comment on `hasNonStale` verbatim (it is
  an accepted equivalent, not a suppression to remove).
- Pop (L67): `const { oid: id } = queue.shift()!` → `const { oid: id } = heap.pop()!`.
- `paint` returns `flags` (the Map) — unchanged; `collectResults`/`removeRedundant`/
  `mergeBasesMany`/`octopusMergeBases`/`mergeBase` (L88–160) are untouched.

**Consumer 3 — `src/application/commands/blame.ts`** (read it):
- Import: line 17, same swap (`precedes` + `QueueEntry` from `priority-queue.js`, `BinaryHeap`
  from `'../../domain/commit/binary-heap.js'`; drop `enqueue`).
- `interface Scoreboard` (L106–110): `readonly queue: QueueEntry<Suspect>[]` →
  `readonly queue: BinaryHeap<QueueEntry<Suspect>>` (or rename to `heap` — keep `queue` to
  minimise churn; the field is internal).
- Construction (L121): `const board: Scoreboard = { ctx, queue: [], finalized: [] }` →
  `queue: new BinaryHeap<QueueEntry<Suspect>>(precedes)`.
- `walk` (L233–238): `while (sb.queue.length > 0)` → `while (sb.queue.size() > 0)`;
  `sb.queue.shift() as QueueEntry<Suspect>` → `sb.queue.pop() as QueueEntry<Suspect>`.
- `schedule` (L346–358): `enqueue(sb.queue, { oid: commit, date, value: {...} })` →
  `sb.queue.push({ oid: commit, date, value: {...} })`. Preserve the existing
  `equivalent-mutant` comment on the `entries.length === 0` guard verbatim.
- Blame reads only `.value` at the head → pop-only; no `entries()` retarget needed here.

**Delete `enqueue` from `src/domain/commit/priority-queue.ts`:**
- Remove the `export const enqueue = <T>(queue, entry): void => {...}` (L25–29) and its
  doc-comment (L24). KEEP `QueueEntry`, `Ordered`, `precedes`, and the `ObjectId` import.
- Update `test/unit/domain/commit/priority-queue.test.ts` and
  `test/unit/domain/commit/priority-queue.properties.test.ts`: drop the `enqueue` import and
  every `enqueue`-based describe/property (the sorted-array insert/drain cases at
  test.ts L57–115 and the "enqueuing each in turn" properties at properties.test.ts
  L65–97 + the `drainAll` helper L22–26). KEEP all `precedes` cases (test.ts L19–55;
  properties.test.ts L28–63) — `precedes` remains exported and comparator-documenting.
  The heap's own drain/tie-break behaviour is now covered by Part 1's `binary-heap.test.ts`
  / `binary-heap.properties.test.ts`, so this is not a coverage loss.

**Regression suites that must stay green unchanged** (do NOT edit their assertions):
`test/unit/application/primitives/internal/commit-date-walk.test.ts`,
`test/unit/application/primitives/merge-base.test.ts`,
`test/unit/application/commands/blame.test.ts`, and the describe/name-rev/log/shortlog/
range-diff/whatchanged suites that ride on `commitDateWalk`. Run the broad set to confirm
behaviour preservation.

### TDD steps

- RED (guard-first, no new test needed — the existing regression suites ARE the RED net):
  before editing, run the three consumers' unit suites to confirm green baseline, then make
  the edits; the type-check will red first on the field/loop type changes if wired wrong.
- GREEN: apply the three consumer migrations exactly as specified, delete `enqueue` +
  prune its tests. Run
  `npx vitest run test/unit/application/primitives/internal/commit-date-walk.test.ts test/unit/application/primitives/merge-base.test.ts test/unit/application/commands/blame.test.ts test/unit/domain/commit/priority-queue.test.ts test/unit/domain/commit/priority-queue.properties.test.ts`
  → all green (behaviour-preserving: Class I identical pop order, Class II identical result).
- REFACTOR: verify no leftover `enqueue` import or `.shift()`/`.length` on a heap anywhere
  in `src/` (`grep -rn 'enqueue\|\.shift()\|\.queue.length' src/application`). Confirm the
  `hasNonStale` retarget reads the entry view, not a raw array. Confirm the two preserved
  Stryker equivalent-mutant comments are intact. Re-run the suite → green.

### Gate

`npx vitest run test/unit/application/primitives/internal/commit-date-walk.test.ts test/unit/application/primitives/merge-base.test.ts test/unit/application/commands/blame.test.ts test/unit/domain/commit/priority-queue.test.ts test/unit/domain/commit/priority-queue.properties.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/internal/commit-date-walk.ts src/application/primitives/merge-base.ts src/application/commands/blame.ts src/domain/commit/priority-queue.ts test/unit/domain/commit/priority-queue.test.ts test/unit/domain/commit/priority-queue.properties.test.ts`

### Commit

`refactor: migrate commit-date-walk, merge-base, blame onto binary heap`

## Part 3 — Converge bisect-midpoint onto the shared heap

### Context

Migrate `src/application/primitives/bisect-midpoint.ts`'s candidate walk from its OWN local
FIFO-stable sorted-array structure onto the shared `BinaryHeap<T>`, keeping its own
`(date desc, ins asc)` comparator. ADR-466 (amends ADR-430; tie-break semantics preserved).
Bisect is **Class I** (`ins` is `ins++`, unique + monotonic → strict total order → pop
sequence byte-identical). The interop goldens are the FIFO-order regression net and MUST
stay green **unchanged**.

**Edits in `src/application/primitives/bisect-midpoint.ts`** (read it). ADR-466 deletes the
local FIFO machinery: the `WalkEntry` type alias, `entryPrecedes`, and `enqueueWalkEntry`.
The heap's element type becomes an **inline object type** `{ readonly id: ObjectId; readonly
date: number; readonly ins: number }` (bisect reads only `.id` at pop; `date`/`ins` feed the
comparator only), and the `(date desc, ins asc)` comparator becomes the heap's `less`.
- **Delete** `type WalkEntry = { readonly id: ObjectId; readonly date: number; readonly ins:
  number }` (L55) and its doc-block (L47–54). Replace every `WalkEntry` reference below with
  the inline object type (or a fresh module-local `type HeapEntry = {...}` if the inline type
  repeats too much — a rename, not the old alias with its stale doc-block).
- **Delete** `const entryPrecedes = (a: WalkEntry, b: WalkEntry): boolean => a.date > b.date
  || (a.date === b.date && a.ins < b.ins)` (L57–61) — its expression MOVES INTO the heap's
  `less` argument. Prefer a named `const less = (a, b) => a.date > b.date || (a.date === b.date
  && a.ins < b.ins)` inside `walkCandidatesNewestFirst` passed to `new BinaryHeap`, carrying
  forward the equivalent-mutant reasoning (the `a.ins < b.ins` sub-expression never fires for
  a freshly enqueued entry — highest ins) as a comment on the surviving `less`.
- **Delete** `const enqueueWalkEntry = (queue, entry): void => {...}` (L63–67) entirely
  (replaced by `heap.push`).
- Import `BinaryHeap` from `'../../domain/commit/binary-heap.js'` at the top.
- `walkCandidatesNewestFirst` (L93–120):
  - `const walkQueue: WalkEntry[] = []` (L102) → `const heap = new BinaryHeap<{...ins}>(less)`.
  - `enqueueWalkEntry(walkQueue, { id: bad, date: badDate, ins: ins++ })` (L105) →
    `heap.push({ id: bad, date: badDate, ins: ins++ })`. KEEP the `ins++` equivalent-mutant
    comment (L103–104) verbatim.
  - `while (walkQueue.length > 0)` (L107) → `while (heap.size() > 0)`.
  - `const { id } = walkQueue.shift()!` (L108) → `const { id } = heap.pop()!`.
  - `enqueueWalkEntry(walkQueue, { id: parent, date: pe.date, ins: ins++ })` (L116) →
    `heap.push({ id: parent, date: pe.date, ins: ins++ })`.
- The deleted `WalkEntry` doc-block claimed the shared queue "must NOT be changed" — that
  claim is now obsolete (bisect DOES share the heap); do not carry it forward. Do NOT write
  any ADR/phase/backlog reference into the code (house rule).
- `paintReachable` (L24–45) uses a plain index-cursor BFS (`queue: ObjectId[]`, `head++`),
  NOT the date queue — leave it completely untouched. `projectOldestFirst`,
  `collectCandidatesOldestFirst`, `deriveMidpoint`, `bisectMidpoint` — untouched.

**Regression net — MUST stay green UNCHANGED (do NOT edit):**
- `test/integration/bisect-midpoint-interop.test.ts` — all diamond fixtures (both merge
  directions of the equal-date diamond + the unequal-date diamond). This pins the FIFO
  tie-break against real `git rev-list --bisect` / `--bisect-vars`. A naive oid tie-break
  would fail at least one direction; the `(date,ins)` comparator keeps them green.
- `test/unit/application/primitives/bisect-midpoint.test.ts` — the unit suite.

### TDD steps

- RED (guard-first): run `test/unit/application/primitives/bisect-midpoint.test.ts` +
  `test/integration/bisect-midpoint-interop.test.ts` to confirm the green baseline. These
  existing suites are the RED net — no new test is written (the candidate-list order is
  fully pinned already; adding a duplicate would be a pure test-only pass).
- GREEN: apply the edits — delete `WalkEntry`/`entryPrecedes`/`enqueueWalkEntry`, use the
  inline heap-element type, move `entryPrecedes`'s expression into the `BinaryHeap` `less`,
  swap `walkQueue`+`shift` for `heap`+`pop`, keep the `ins` counter and its `ins++` sites.
  Run both suites → green (Class I → identical candidate order → identical midpoint + counts).
- REFACTOR: `grep -rn 'enqueueWalkEntry\|entryPrecedes\|walkQueue\|WalkEntry' src/` returns
  nothing (all three names deleted); confirm the `ins` counter and its `ins++` sites remain;
  confirm the surviving equivalent-mutant comments are intact and no stale "must NOT be
  changed" claim about the shared queue remains. Re-run both suites → green.

### Gate

`npx vitest run test/unit/application/primitives/bisect-midpoint.test.ts test/integration/bisect-midpoint-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/bisect-midpoint.ts`

### Commit

`refactor: converge bisect-midpoint candidate walk onto the shared binary heap`
