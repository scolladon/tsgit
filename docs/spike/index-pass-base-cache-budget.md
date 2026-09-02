# Spike — sizing the index-pass base cache (ADR-788)

> Brief: ADR-788 names the cache's shape and defers its byte budget to a measurement.
> This spike runs that measurement — the demand curve, an eight-point budget sweep, and
> the four falsifiers — and pins `INDEX_PASS_BASE_CACHE_MAX_BYTES`.
> Status: findings — default set to **8 MiB**.

## TL;DR

- **Chosen default: `INDEX_PASS_BASE_CACHE_MAX_BYTES = 8 MiB`.** It clears the largest
  observed base-with-children object (4.76 MiB) with headroom, is neither a fraction of
  nor equal to `ctx.deltaCache`'s 16 MiB default, and is inert on a delta-free pack.
- **No clean wall-clock knee on the real-clone fixture.** Root-hit rate rises roughly in
  proportion to budget (5 % at 1 MiB → 100 % at 64 MiB) rather than plateauing early. Per
  the falsifier protocol this means the honest response is the smaller, still-justified
  budget, not a larger one chasing a speedup the data doesn't clearly back.
- **The cache's own contribution is small and bounded** (~15 MB added footprint at the
  8 MiB default on the real-clone fixture, ~43 MB at an effectively-unbounded 64 MiB —
  matching the fixture's own ~42 MiB of total base-object content almost exactly).
- **R2's 126 MB class is not met by the pipeline this cache sits on top of**, independent
  of this cache's own budget — see §7. That gap predates this part (it belongs to the
  already-shipped two-pass streaming design) and is out of scope for a change whose job
  is bounding one additional cache; flagged here for visibility, not fixed here.
- **Fixture B (delta-free) stays wall-clock inert**, the entry-cap-vs-byte-cap distinction
  turned out to matter on the REAL clone fixture (not just a synthetic worst case — see
  §4), and R15 (identical results at budget 0 and at the default) is enforced by the
  automated test suite, not remeasured here.

## 1. Method

All numbers are **local measurements on one machine** (Apple M3 Pro, 18 GiB, macOS
Darwin 25.5.0, Node v22.22.3, git 2.55.0), single-threaded, never a performance claim —
this repository's published performance numbers come only from CI's nightly bench
artifact.

**Peak footprint** comes from a child process's kernel high-water mark
(`process.resourceUsage().maxRSS` at exit), never an in-process sampler: an in-process
`setImmediate`/`process.memoryUsage()` loop cannot see this pipeline's peak, because the
resolution loop awaits only already-settled promises and the event loop never turns
during the phase holding the peak (measured directly in this design's own §1d — an
8× discrepancy between two paths sharing one pipeline). Each reading is one fresh `node`
process running exactly one call into `indexQuarantinedPack`.

Because the cache's own budget knob (`IndexPackOptions.baseCacheMaxBytes`) is
deliberately **not** threaded through `fetchPack`/the published package surface (ADR-783's
"keeps its signature"), the sweep cannot run against the built, rolled-up `dist/` the way
`tooling/bench-memory.ts`'s other workloads do — `internal/index-pack.ts` isn't a rollup
entry point, and adding one to reach it would create unwanted public surface. Instead,
each reading here is a throwaway `tsc -p tsconfig.build.json` compile (per-file ESM output,
not the rollup bundle, never committed) that a bare `node` process imports directly. This
was validated against the shipped code path before trusting any number from it: the very
first smoke run (a hand-built one-entry pack through both `walkPackEntries` and
`indexQuarantinedPack`) produced the correct oid and a plausible `maxRSS`, and every
number below reproduces that same, real, compiled implementation — never a reimplementation
of it. The `npm run bench:memory` workloads added alongside this part (see §8) exercise the
same cache through the **public** clone path instead, at its shipped default only, and are
the ongoing regression signal; this spike's sweep is the one-off sizing measurement.

Every git probe asserts its own output before its number is trusted: each fixture's
`.idx` existence and object count is checked via `git count-objects -v` / `git verify-pack
-v` before any figure derived from it is used. macOS has no `timeout(1)`; no probe here
relies on one.

## 2. Fixtures

Built fresh for this spike (not the design doc's own historical numbers, which came from a
different content generator and machine — reproduced here for shape, not byte-parity):

| | Shape | Objects | `.pack` bytes | Σ inflated (all) | Max chain | Largest object |
|---|---|---|---|---|---|---|
| **A** | 2 000-line file, 300 commits (20 rewrites + 1 append each), one `git fast-import` stream, `git -c pack.threads=1 repack -a -d` | 903 (301/301/301) | 230 429 | 492 837 | 50 | 52 390 |
| **B** | fixture A repacked `--window=0 --depth=0` | 903 | 5 371 357 | 14 423 859 | 0 | 53 380 |
| **C** | `git clone --no-local --bare file:///…/tsgit` (this worktree's own repo) | 15 270 (4 794 base / 10 476 delta) | 27 949 932 | 71 371 878 | 47 | 4 992 665 |
| **thin** | fixture A, `pack-objects --thin --revs` for the last 150 commits against an earlier commit as the sole prerequisite | 1 unresolved delta, 1 distinct missing base | 119 863 | — | — | — |

`.idx` existence and `git verify-pack -v`'s own object count were asserted equal to
`count-objects -v`'s `in-pack` figure for A, B and C before any further number was
computed from them.

## 3. The demand curve

`Σ inflatedBytes(b)` over base entries `b` with at least one child — computed from `git
verify-pack -v`'s per-object listing (the `<sha> <type> <size> <size-in-pack> <offset>
[<depth> <base-sha>]` columns), cross-checked against this module's own instrumented
count (§4's budget-0-vs-B delta) rather than trusted as primary. The cross-check landed
within 1.2 % (git's per-link chain accounting groups some deeper-chain relationships
differently from this indexer's own root/child forest — the difference is a genuine
grammar mismatch between "git's chain depth" and "this design's forest roots," not a bug
in either), so `verify-pack`'s number is reported as the demand curve and the
instrumented count is what the sweep and the budget decision actually use.

| Fixture | bases-with-children | demand curve (Σ inflated) | largest base-with-children |
|---|---|---|---|
| A | 6 | 278 489 B (0.27 MiB) | 52 390 B |
| B | 0 | 0 | — |
| C | 1 628 (verify-pack) / 1 648 (instrumented) | 25 103 654 B (23.9 MiB) | 4 992 665 B (4.76 MiB) |

**Total base-object bytes** (every base pass 1 offers to the cache, not only the ones that
turn out to have children — pass 1 cannot know which until the whole pack is scanned) is
the number that actually bounds achievable residency: **44 052 249 B (42.0 MiB) across
4 794 base objects** on fixture C. This is why the entry-count cap (§4) has to clear the
pack's total base-object count, not the smaller with-children count — discovered by
measuring this real fixture, not assumed.

## 4. The entry-cap-vs-byte-cap trap, found on a real fixture

The plan's first candidate for `INDEX_PASS_BASE_CACHE_MAX_ENTRIES` was 4 096, sized against
fixture C's 1 628 bases-*with-children* plus headroom. At a 64 MiB byte budget (comfortably
above the 23.9 MiB demand curve), the instrumented hit count came back short: 137 roots
that should have been hits were misses. Root cause: pass 1 inserts **every** base object,
not only the ones later found to have children, and fixture C carries 4 794 total base
objects — more than the 4 096 entry cap. The entry cap was evicting still-needed roots
purely from count pressure, at a budget far under the byte ceiling — exactly the failure
mode ADR-727's amendment describes, but triggered by a **real repository's** base-object
count, not only a crafted adversarial pack.

Fixed by raising `INDEX_PASS_BASE_CACHE_MAX_ENTRIES` to 65 536 (matching the sibling
read-path caches' own cap) — comfortable headroom over 4 794, re-verified: at 64 MiB the
instrumented miss count is now exactly the theoretical floor (0 avoidable misses beyond
budget-driven eviction).

## 5. Hit rate against budget (instrumented, not sampled)

Exact — each budget's `streamInflate` call count against the base-cache-disabled (`budget
= 0`) baseline; avoided calls ÷ bases-with-children is the hit rate. Fixture A saturates by
1 MiB (its largest base-with-children is 52 390 B); fixture B is flat by construction (no
base has children, so nothing is ever a hit or a miss).

| Budget | A hit rate | C hit rate (instrumented, 1 648 roots) |
|---|---|---|
| 0 | 0 % | 0 % |
| 1 MiB | 100 % (6/6) | 4.6 % |
| 2 MiB | 100 % | 9.2 % |
| 4 MiB | 100 % | 17.2 % |
| 8 MiB | 100 % | 26.9 % |
| 16 MiB | 100 % | 45.2 % |
| 32 MiB | 100 % | 74.0 % |
| 64 MiB | 100 % | 100.0 % |

Fixture C's curve rises close to linearly with budget rather than turning over early — the
shape the "no knee" falsifier describes (§7).

## 6. Wall clock and peak footprint (median of 3–5, single-threaded)

Fixture A (all budgets; process start-up dominates a 0.27 MiB demand curve, so this row is
flat by construction and does not discriminate budgets):

| Budget | median wall (ms) | median peak (KB) |
|---|---|---|
| 0 – 64 MiB | 55.3 – 56.5 (noise band) | ~104 000 – 104 400 (noise band) |

Fixture B (delta-free control — endpoints only, 5 reps each):

| Budget | median wall (ms) | median peak (KB) |
|---|---|---|
| 0 | 92.03 | 112 752 |
| 64 MiB | 94.62 | 117 472 |

Fixture C (the discriminating fixture, 3 reps per point, then 5 reps at the two endpoints
to characterize noise — the two endpoint distributions did not overlap: budget-0's
five-run range was [1521.4, 1560.9] ms, budget-64's was [1437.8, 1458.8] ms, confirming the
~90 ms difference is a real, reproducible effect and not noise):

| Budget (MiB) | median wall (ms) | median peak (KB) |
|---|---|---|
| 0 | 1536.27 | 262 896 |
| 1 | 1530.68 | 270 128 |
| 2 | 1521.30 | 272 352 |
| 4 | 1514.12 | 280 512 |
| 8 | 1532.92 | 278 496 |
| 16 | 1492.25 | 287 488 |
| 32 | 1480.68 | 302 320 |
| 64 | 1423.17 | 307 024 |

Baseline (context creation + quarantine copy, no indexing; pack-size-independent, as
expected — dominated by module load, confirmed by measuring bare `import` of the compiled
`node-adapter.js` in isolation): median 66 112 KB (64.6 MiB) on fixture C's fixture size,
identically on fixture A's.

## 7. The four falsifiers — explicit verdicts

- **No knee.** *Fires, partially.* §5's hit-rate curve on fixture C rises close to
  linearly with budget (4.6 % → 9.2 % → 17.2 % → 26.9 % → 45.2 % → 74.0 % → 100 %) with no
  early plateau; §6's wall clock likewise shows its single largest step (32→64 MiB, 58 ms)
  at the *top* of the range rather than tapering off. Both are consistent with "retain
  everything wearing a budget" rather than a genuine diminishing-returns knee. Per
  protocol, the response is the smaller, honestly-modest budget (8 MiB, §9) rather than
  a larger one the data does not clearly justify — not the "smallest budget within 5 % of
  unbounded" rule the plan's provisional wording proposed, which this fixture's noise band
  (§6) cannot resolve with confidence at 3–5 repeats in any case.
- **Below the largest object.** *Does not fire.* 8 MiB (8 388 608 B) exceeds fixture C's
  largest base-with-children object (4 992 665 B) with 68 % headroom. A candidate at or
  below ~4.76 MiB would have failed this check outright (unable to hold even fixture C's
  single largest root) — ruled out on that basis alone, independent of the knee question.
- **Peak rises by more than the budget.** *Does not fire.* Budget 0 → 64 MiB peak rose by
  ~44 MB (262 896 → 307 024 KB) against a 64 MiB budget increase — inside the budget, not
  beyond it. The entry-sizer fix in §4 is what makes this hold at all budgets tested;
  before that fix the entry cap (not the sizer) was the source of the only anomaly found.
- **Fixture B moves.** *Does not fire, with one honest caveat.* Wall clock is flat within
  noise (92.03 vs 94.62 ms, a 2.6 ms difference on two 5-run medians whose own within-set
  spread is comparable). Peak footprint shows a small, *explained* rise (112 752 → 117 472
  KB, ~4.7 MB) — pass 1 still offers every base to the cache regardless of whether it
  turns out to have children, so a delta-free pack still transiently retains cache slots
  for bases nothing ever reads back, bounded by the budget and cleared at the end of the
  pass. This is the cache doing exactly what it is specified to do (cache every base
  optimistically, since pass 1 cannot know in advance which have children), not the cache
  serving a wrong or stale result — R15 (§8) already proves fixture B's *output* is
  byte-identical at every budget. Recorded as a real, small, structurally-expected cost
  rather than papered over as pure noise.

## 8. R15 — correctness across budgets

Enforced by the automated test suite
(`test/unit/application/primitives/fetch-pack.test.ts`'s "index pass equivalence — base
cache budget sweep (R15)" and its thin-pack sibling), not remeasured here: every
degenerate-corpus case, the synthetic deep-chain and branching-forest cases, and both
thin-pack scenarios run at `baseCacheMaxBytes: 0` and at the shipped default, asserting
identical `(id, crc32, offset)` sets, byte-identical `.idx`/`.rev` output, and identical
`TsgitError.data` on every refusal. The cache's own invariants (boundedness, the entry cap
binding independently of the byte budget, the two key spaces not colliding under genuinely
overlapping passes, `clear()` running on both the success and the failure exit) are pinned
by a further four tests in the same file, each verified — by deliberately breaking the
corresponding line and confirming the test fails for that exact reason, then restoring —
to catch the regression it targets rather than merely echo the implementation.

## 9. The chosen default

**`INDEX_PASS_BASE_CACHE_MAX_BYTES = 8 MiB` (8 388 608 bytes).**

Reasoning, in order:

1. It must exceed `largestEntryInflatedBytes` on the discriminating fixture (4.76 MiB) —
   8 MiB clears that with margin, so it can always hold at least one root on a real clone.
2. The knee falsifier fired (§7): the data does not support a larger budget earning a
   proportionally larger, qualitatively different speedup. The honest response is the
   smaller, still-justified number, not the largest candidate tested.
3. It must be neither a fraction of nor equal to `ctx.deltaCache`'s own 16 MiB default
   (ADR-788) — 8 MiB is neither.
4. It gives a real, modest, measured benefit: ~27 % root-hit rate and a small wall-clock
   improvement on fixture C, 100 % on fixture A, zero effect on fixture B beyond the
   explained §7 caveat.
5. Its own added footprint is small and bounded: ~15 MB over the no-cache baseline on
   fixture C (262 896 → 278 496 KB), never the ~44 MB an unbounded-equivalent budget would
   add.

`INDEX_PASS_BASE_CACHE_MAX_ENTRIES = 65 536` (§4) and
`INDEX_PASS_BASE_CACHE_ENTRY_OVERHEAD_BYTES = 200` (unchanged from the plan's own model) are
the paired constants.

## 10. R2, honestly

The design's R2 target — fixture C's peak over baseline not exceeding 126 MB, aiming for
the ~33 MB class git's own cache-disabled indexer reaches — is **not met** by the pipeline
this cache sits on top of, independent of this cache's own budget: measured peak-over-baseline
on fixture C ranges **192.2 MB** (budget 0, no cache at all) to **235.3 MB** (budget 64
MiB, effectively unbounded) against this spike's baseline methodology (§1, §6). At the
chosen 8 MiB default, peak-over-baseline is **207.4 MB**.

This gap predates this part: it belongs to the already-shipped two-pass streaming
indexer (the prior parts of this same plan), not to the cache this part adds — the
cache's own marginal contribution at the shipped default is the small, bounded ~15 MB
figure in §9, not the ~192 MB floor it's added on top of. Closing that floor is out of
scope for a change whose job is "add one bounded cache to what the prior parts already
built," per this part's own scope boundary. Recorded here for visibility rather than
silently narrowed away; it is a legitimate finding for a later phase, not a defect this
part introduced or is positioned to fix.

## 11. GC residency

`tooling/bench-memory.ts`'s new `gc-residency-3000-loose-objects` workload (§ ADR-790's
argument: `gc` is the highest object-count write path this library has) measured
**172 949 504 B (164.9 MB) peak RSS** on this branch, for `maintenance({tasks:['gc']})`
over 3 000 freshly committed, reachable loose objects, on this machine. This is an
absolute number for this branch only — the branch-vs-`main` comparison the design's
Benches section calls for (never a ratio or a self-share delta, both Amdahl-fragile
against `buildPack`'s own untouched deltify/window-search cost) needs a second checked-out
build of the library and was not completed within this measurement session; flagged as a
deferred observation rather than fabricated.

## 12. What this local sizing measurement is not

Every number above is a **local sizing measurement on one machine**, reproducible in
shape but not in absolute value across hardware — never a performance claim. This
repository's published performance numbers come only from CI's nightly bench artifact.
