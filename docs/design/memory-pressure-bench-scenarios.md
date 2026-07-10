# Design — Memory-pressure bench scenarios (large packs, deep delta chains)

> Brief: Add memory-pressure scenarios — large packs and deep delta chains — to the
> bench suite so the Phase-26 baseline covers them, before per-command profile
> capture (26.3) and the CI regression gate (26.5).
> Status: draft → self-reviewed ×3 → accepted

## Context

The bench suite already exists and is the surface this change extends. The relevant
pieces:

- **`test/bench/support/fixture-generator.ts`** — the deterministic scaled-fixture
  generator. Builds a repo via `git init` → `git fast-import` → `git checkout` →
  `git repack -ad --quiet`, cached under `~/.cache/tsgit-bench/<label>-v<N>`.
  - `FixtureSpec = { label: 'medium' | 'large'; commits; blobs; blobBytes }`.
  - `MEDIUM_FIXTURE` (5 000 commits / 20 000 blobs / 2 560 B) and `LARGE_FIXTURE`
    (50 000 / 200 000 / 2 560 B).
  - `FIXTURE_GENERATOR_VERSION = 1` gates the cache; a bump invalidates every stale
    cache. `bench.yml` keys `actions/cache` on `hashFiles('…/fixture-generator.ts')`,
    so any edit to this file already re-keys the CI cache — a version bump is only
    needed to invalidate a *developer's* local `~/.cache` when the shape changes.
  - `blobContent(blobIndex, bytes)` fills via **xorshift32 → high-entropy random
    bytes**. Verified empirically (see Design): `git repack -ad` finds no good deltas
    in random content, so today's fixtures produce **no deep delta chains** (max chain
    length ≈ window default; effectively depth ≤ 10). Deep chains require content that
    is **similar across successive objects**.
  - `repack -ad` has **no `--depth`/`--window` override** today.
  - `ScaledFixture = { cwd, headCommitId, firstBlobId, spec }`;
    `FixtureUnavailableError` when the `git` CLI is absent (callers `skipIf`).
- **`test/bench/support/scaled-bench.ts`** — `resolveScaledContext()` picks
  `MEDIUM_FIXTURE` unless `TSGIT_BENCH_LARGE` is set; returns
  `{ fixture?, given }`; skips under `STRYKER_MUTANT_ID`. `scaledScenario(ctx,
  whenThen, build)` registers a scenario that skips when the fixture is unavailable.
- **`test/bench/support/bench-dsl.ts`** — `benchScenario(given, whenThen, build,
  opts)` wraps vitest `describe` + `bench`. The two `bench()` names MUST stay exactly
  `'tsgit'` / `'isomorphic-git'` (summary script, `benchmark-compare` job, snapshot
  converter all key on them). `BenchComparison.baseline?` is **optional** — a scaled
  scenario may run tsgit-only.
- **`test/bench/pack-read-scale.bench.ts`** — the closest sibling: `readBlob()` cold
  (fresh `openRepository` per call → full fanout + inflate) vs warm (one shared repo →
  LRU delta-base cache hits) against the fixture pack. The deep-delta scenario is its
  natural neighbour.
- **`test/bench/read-blob.bench.ts`** — the small-repo (non-scaled) cold/warm idiom
  over `setupSmallRepo({ commits })` from `test/bench/fixtures.ts`.
- **Tooling & CI**: `tooling/gen-bench-fixture.ts` (`npm run bench:fixture --
  <medium|large>`) pre-warms a cache; `tooling/bench-summarize.ts` →
  `reports/benchmarks/summary.md`; `tooling/bench-to-snapshot.ts` →
  `snapshot.json`. Both flatten every `(group, bench)` pair generically — **new
  scenarios are picked up automatically**, no tooling change needed. `bench.yml`
  (nightly) restores the fixture cache, pre-warms **medium only**, runs
  `bench:summary`, uploads `reports/benchmarks/`. `TSGIT_BENCH_LARGE` is **never set
  in CI** — the large fixture is a manual/local escape hatch.

The code paths a memory-pressure scenario stresses (named so the planner/implementer
target them exactly):

- **`src/application/primitives/object-resolver.ts`** — `resolveObject(...)`, the
  loose-first-then-pack **iterative delta walker**. Imports `MAX_DELTA_CHAIN_DEPTH`
  from `domain/storage/delta.js`, `applyDelta` / `readDeltaTargetSize`, and a
  `LruCache<Uint8Array>` (the delta-base cache). This is what a deep chain drives:
  every read of a leaf reconstructs through its base chain, hitting or missing the
  LRU per base.
- **`src/domain/storage/delta.ts`** — `MAX_DELTA_CHAIN_DEPTH = 50` ("Matches git's own
  default"). A chain **deeper than 50** throws `DELTA_CHAIN_TOO_DEEP`
  (`domain/storage/errors`). **Load-bearing faithfulness constraint** for this design:
  the fixture must not produce chains longer than 50, or tsgit's own reader refuses
  the object.
- **Delta-base LRU** — `createLruCache<Uint8Array>` in each adapter
  (`node/browser/memory-adapter.ts`), default `16 MiB` / `65 536 entries`
  (`deltaCacheMaxBytes` / `deltaCacheMaxEntries` options on `openRepository`).
  `ctx.deltaCache` (`ports/context.ts`). Warm reads hit it; cold reads (fresh repo)
  start empty.

Constraining prior art / ADRs:

- **ADR-226 (git-faithfulness prime directive)** — replicate git byte-for-byte unless
  an ADR diverges. **This task does not *assert* git-observable behaviour** (benches
  measure wall-clock time), so it is not faithfulness-asserting. But every `git`
  invocation the fixture generator adds **must be env-isolated** exactly as the
  existing generator is (it already runs `git` with no `GIT_*` leakage via `-C`, but
  see the note under Design on the fast-import author/timestamp being pinned rather
  than inherited). The fixtures are authentic git packs by construction (`git
  fast-import` + `git repack`), so no faithfulness matrix is being pinned — only the
  **delta-chain-depth matrix** below, which is a *fixture-shape* pin, not a behaviour
  pin.
- **11.1 / 12.4** — the existing vs-isomorphic-git benches (`log` / `readBlob` /
  `status` / `clone:small-repo`) establish the comparative-baseline idiom this follows.
- **Bench files are excluded from coverage** — `vitest.config.ts` coverage runs over
  `src/**` only; `test/bench/**` is never instrumented. So bench `.bench.ts` files
  carry **no** coverage/mutation obligation. **Any change to the generator or a new
  tooling knob is production-adjacent test-support code and IS under the normal
  gates** where it is reachable by unit tests — but the generator is currently
  untested (`git`-spawning, cache-backed) and lives under `test/bench/support`, which
  is *not* in the coverage `include`. Confirm during planning that the generator edit
  stays inside the already-uncovered support surface (it does).

## Requirements

When this ships:

1. The bench suite contains a **deep-delta-chain** scenario that reads leaf objects
   whose reconstruction walks a long ref/ofs-delta chain, exercising
   `resolveObject`'s iterative walker + the LRU delta-base cache under **cold** (empty
   cache, full chain replay per read) and **warm** (cache primed, base hits) regimes.
2. The bench suite contains a **large-pack** memory-pressure scenario that reads across
   a pack large enough to stress the reader without materialising the whole pack in
   memory.
3. Both scenarios are **deterministic and cache-friendly** — seeded content, fixed
   timestamps, generate-once-and-cache — matching the existing generator's contract.
4. The fixtures produce delta chains **within** tsgit's `MAX_DELTA_CHAIN_DEPTH = 50`
   cap (empirically pinned depth target ≤ 50, saturating near it), so tsgit's own
   reader resolves every object and the scenario measures real chain-walk cost rather
   than tripping `DELTA_CHAIN_TOO_DEEP`.
5. The new scenarios flow into `reports/benchmarks/summary.md` and `snapshot.json`
   **with no tooling change** (the flatteners are generic — verified).
6. **CI bench time stays sane**: the deep-delta fixture is small to generate
   (< ~a few seconds) and runs on the **default medium path**; any purpose-built
   large-pack fixture that is slow/GB-scale stays **gated** behind `TSGIT_BENCH_LARGE`
   (or reuses the existing `LARGE_FIXTURE`) so nightly CI is unaffected.
7. `FIXTURE_GENERATOR_VERSION` is bumped iff the shape of an existing cached fixture
   changes; the `bench.yml` cache key (already source-hashed) stays compatible.
8. Every `git` invocation added is env-isolated (author/committer/timestamp pinned, no
   `GIT_*` inheritance) — determinism + no worktree/global-config writes.

## Design

### Empirically-pinned delta-chain matrix (the crux)

`blobContent`'s xorshift32 output is high-entropy — git's delta compressor finds no
usable base, so **today's fixtures have no deep chains**. Deep chains require
**successive-similar** content. Pinned against the real `git` binary in an isolated
`mktemp` throwaway (isolated `HOME`, `GIT_CONFIG_NOSYSTEM=1`, `GIT_*` scrubbed,
`commit.gpgsign false`), fixture = **one 4 KiB blob evolving over N commits, mutating
~1 % of its bytes each commit** (seeded PRNG), then `git repack -adf --depth=D
--window=W`:

| Fixture | repack args | Max delta-chain length | Pack size |
|---|---|---|---|
| 1 evolving 4 KiB blob, 300 commits | `--depth=10 --window=250` | **9** | 268 KiB |
| 1 evolving 4 KiB blob, 300 commits | `--depth=50 --window=10` (git default window) | **37** | 192 KiB |
| 1 evolving 4 KiB blob, 300 commits | `--depth=50 --window=250` | **43** | 180 KiB |
| 1 evolving 4 KiB blob, 300 commits | `--depth=100 --window=250` | **85** | 168 KiB |
| 20 000 random blobs (today's medium) | `--depth` default (50) `--window` default (10) | ~1 (no deltas) | — |

Load-bearing readings from this matrix:

- **Similar content is necessary and sufficient** for deep chains — the evolving blob
  reaches chain length 43 where random content stays at ~1. The strategy is an
  *evolving blob mutated per commit*, not the existing random `blobContent`.
- **`--depth=50 --window=250` reaches chain length 43, near-saturating tsgit's
  `MAX_DELTA_CHAIN_DEPTH = 50` cap without exceeding it.** This is the sweet spot: it
  measures a deep walk while every object stays resolvable by tsgit.
- **`--window` matters** — the git-default `window=10` under-fills the chain (37 vs 43);
  a wide `--window=250` is needed to let git pack a near-cap chain. So the generator
  must pass **both** `--depth` and `--window` (default repack window is too small).
- **`--depth=100` produces chains of length 85 — beyond tsgit's cap** → those leaf
  reads would throw `DELTA_CHAIN_TOO_DEEP`. **Do not exceed `--depth=50`.** Target
  `--depth=50 --window=250`; expect max chain ≈ 43 (git may not saturate exactly to
  50, which is fine — it is deep by any measure and stays under the cap).
- The evolving-blob fixture is **tiny and fast** (< ~1 s to generate 300 commits,
  ~180 KiB pack) — safe on the default medium CI path.
- **git deltas *backwards in time* here — the deepest leaf is NOT HEAD.** Pinned:
  for the 300-commit evolving blob, `git repack` stored the **newest (HEAD) version
  as the non-delta base** (chain length 1) and deltified **older** versions against
  it; the **first-commit (root) version sits at chain depth 38**. So the object that
  walks the longest chain is *not* `HEAD:evolving.dat` — it is whichever version git
  placed at the chain tip, and git's base-direction heuristic is not something to
  assume. **The generator must therefore record the id of the object with the
  *maximum* chain depth, read empirically from `git verify-pack -v`** — never assume
  HEAD or root. This is deterministic (same seed + same git → same pack → same
  deepest object) and correct regardless of git's chosen base direction.

> Isolation note: the throwaway above wrote only inside `mktemp -d` with a private
> `HOME`; nothing touched the worktree's `.git/config` or any global config.

### What "memory pressure" means here (honest scope)

`vitest bench` measures **wall-clock time only** — it has no built-in heap/peak-RSS
capture, and per-iteration RSS sampling inside the measured closure is unreliable
(GC timing, shared-heap noise) and would pollute the timing signal. So "memory
pressure" is expressed as **the two workloads that stress the reader's memory
behaviour**, observed through timing:

1. **Deep delta chains** stress the **delta-base cache + iterative reconstruction**:
   a cold read replays the full chain (allocating each intermediate base buffer);
   a warm read hits the LRU. The **cold-vs-warm timing gap** is the observable proxy
   for how much work the chain walk + cache save. This is the direct memory-behaviour
   signal.
2. **Large pack** stresses the reader's ability to serve reads **without
   materialising the whole pack** — the fixture pack is far larger than any single
   object, and the scenario reads a representative object (cold, paying full fanout +
   inflate). Timing that read confirms the reader stays proportional to the object,
   not the pack.

Explicit heap / peak-RSS capture is **out of scope** for a `vitest bench` scenario
(Decision candidate #4) — if the baseline wants memory numbers, that belongs in the
`tooling/profile.ts` path (26.3), not here. This design states that boundary honestly
rather than faking a memory metric inside a timing harness.

### Part A — Teach the generator to build a deep-delta fixture

**Pre-chewed context**
- File: `test/bench/support/fixture-generator.ts`.
- Extend `FixtureSpec` with the fields the deep-delta shape needs. Current shape:
  `{ label: 'medium' | 'large'; commits; blobs; blobBytes }`.
- Add a third label `'delta-chain'` and a spec `DELTA_CHAIN_FIXTURE`. The evolving-blob
  shape is a **different generation strategy** from the multi-blob fast-import, so it
  needs its own streaming path — but it reuses the same cache/rename/meta machinery
  (`ensureScaledFixture`, `cacheDirFor`, `readCachedMeta`, atomic rename).
- **Field-semantics mismatch to resolve (feeds Decision candidate #3):** `FixtureSpec`
  today is `{ label; commits; blobs; blobBytes }` where `blobs` = total distinct blobs.
  The delta-chain fixture has **one evolving path** but `commits` distinct blob
  *versions* — so `blobs` no longer maps to file count. Two clean options for the
  planner: repurpose `blobs` = number of blob versions (= `commits` here, one file), or
  add explicit `deltaDepth`/`deltaWindow` fields and a `strategy: 'multi' | 'evolving'`
  discriminant so `streamFastImport` vs `streamEvolvingFastImport` is selected off the
  spec, not the label. The `resolveScaledContext` `given` phrase currently interpolates
  `${spec.commits} commits, ${spec.blobs} blobs` — for delta-chain it must read
  sensibly (e.g. "N commits, deep delta chains"), so the spec should carry a
  self-describing `given`-fragment or the resolver must branch on label. Surface both
  as part of candidate #3's topology decision.
- New generation strategy: `streamFastImport` currently writes `BLOBS_PER_COMMIT` fresh
  random blobs per commit. The delta-chain strategy writes **one path** (`evolving.dat`)
  re-content each commit from a seeded mutation of the previous bytes. Keep xorshift32
  as the PRNG family for consistency; seed the base once, mutate ~1 % per commit.
  **Reuse the existing `git fast-import` streaming mechanism** — pinned: a single-path
  evolving stream through `fast-import` (`blob`/`mark`/`data` + `M 100644 :n
  evolving.dat` per commit) yields 300 distinct blobs and the same max chain length 43
  as an `add`+`commit` loop, with no per-commit subprocess. So this is a new
  *stream-builder* (`streamEvolvingFastImport`) alongside `streamFastImport`, sharing
  the same `spawn('git', ['fast-import'])` harness in `generateInto`.
  Author/committer/timestamp are written into the stream (pinned, not `GIT_*`-inherited)
  exactly as today. The shared `git checkout -f main` after import is harmless (one
  4 KiB file) and this fixture needs no working-tree scan, so no branch on the checkout
  step is required.
- `generateInto` currently ends with `git repack -ad --quiet`. The delta-chain path
  must run `git repack -adf --depth=50 --window=250 --quiet` instead (the `-f`
  forces a full recompute so `--depth`/`--window` actually apply; `--depth`/`--window`
  are the pinned knobs). **Decision candidate #1** covers whether these knobs become
  spec fields (`deltaDepth`/`deltaWindow`) or a per-strategy constant.
- `firstBlobId` today = `HEAD:d0/f0.dat`. For the delta-chain fixture the interesting
  object is the **object with the maximum delta-chain depth** — which the empirical
  pin shows is **NOT** `HEAD:evolving.dat` (git made HEAD the base and deltified older
  versions against it; the deepest object is an older version, e.g. the first-commit
  one at depth 38). So after `repack`, the generator must **read the deepest object's
  id from `git verify-pack -v`** — parse the blob line whose chain-depth column is the
  maximum — and record that as `firstBlobId`. Keep the `firstBlobId` field name (the
  `ScaledFixture` contract); it now names the **deepest-chain object** for this
  fixture. **Decision candidate #7** covers how to select the deepest object
  (parse `verify-pack` vs. probe candidate versions).
- `verify-pack -v` blob line format (pinned): `<oid> blob <size> <packed-size>
  <offset> <chain-depth> <base-oid>` for deltified objects; a base (non-delta) line
  has **no** chain-depth/base-oid columns. The generator picks the `<oid>` whose
  `<chain-depth>` is maximal. Run it env-isolated (as with every `git` call here).
- `FIXTURE_GENERATOR_VERSION`: adding a **new** label does not change the shape of the
  existing `medium`/`large` caches, and the new label's cache dir is
  `delta-chain-v1`. A bump is **not required** for a pure addition — but bump to `2`
  anyway iff the addition also touches the shared `streamFastImport` used by
  medium/large (it should NOT — keep the strategies separate). **Decision candidate #3.**
- `FixtureUnavailableError` / `assertGitAvailable` / concurrency-safe rename: reuse
  unchanged.

**Determinism**: fixed `BASE_TIMESTAMP + commit` author/committer dates (as today),
seeded xorshift32 mutation, one file → fully reproducible pack. Cache-keyed by label.

### Part B — Deep-delta bench scenario

**Pre-chewed context**
- New file: `test/bench/delta-chain-read.bench.ts` (naming mirrors
  `pack-read-scale.bench.ts` / `read-blob.bench.ts`).
- The deep-delta fixture is small and label-specific — it does **not** ride the
  `TSGIT_BENCH_LARGE` env toggle (that only swaps medium↔large). So this scenario
  resolves the `DELTA_CHAIN_FIXTURE` **directly** via `ensureScaledFixture`, not via
  `resolveScaledContext()`. Wrap it so it skips cleanly when `git` is absent / under
  `STRYKER_MUTANT_ID`, reusing the `benchScenario({ skip })` mechanism the same way
  `scaledScenario` does. **Decision candidate #6** covers whether to generalise
  `resolveScaledContext`/`scaledScenario` to take an arbitrary spec, or add a small
  dedicated resolver.
- Scenario shape mirrors `pack-read-scale.bench.ts` exactly:
  - **Cold**: `sut` = fresh `openRepository({ cwd })` per call → `readBlob(leafId)` →
    `dispose()`. Pays full chain replay with an empty LRU every call.
  - **Warm**: one shared `openRepository`, prime with a first `readBlob(deepId)`,
    `afterAll(dispose)`; `sut` re-reads it → LRU base hits.
  - `deepId = fixture.firstBlobId as ObjectId` — for this fixture `firstBlobId` holds
    the **deepest-chain object** (Part A), so reading it walks the longest chain.
- **Baseline**: include `isomorphic-git` (`git.readBlob({ fs, dir, oid })`) — the
  fixture is tiny, iso-git is not impractically slow here, and a comparative number is
  the point of a delta-chain reader benchmark. **Decision candidate #5.**
- Symbols: `openRepository` from `../../src/index.node.js`, `ObjectId` from
  `../../src/domain/objects/index.js`, `benchScenario` from
  `./support/bench-dsl.js`, `ensureScaledFixture` + `DELTA_CHAIN_FIXTURE` from
  `./support/fixture-generator.js`.
- Given/When/Then titles via `benchScenario`; body AAA; the tsgit closure named `sut`.

### Part C — Large-pack memory-pressure scenario

**Pre-chewed context**
- The existing `LARGE_FIXTURE` is already a 200 000-object (~500 MB) single pack —
  a purpose-built larger fixture buys nothing and would blow the CI budget. **Reuse
  `LARGE_FIXTURE`**, gated behind `TSGIT_BENCH_LARGE` exactly as the existing scaled
  scenarios are (so it never runs in nightly CI, which sets no env). **Decision
  candidate #2.**
- What applies the pressure: rather than a single `readBlob` (already covered by
  `pack-read-scale.bench.ts` under `TSGIT_BENCH_LARGE`), read a **spread of objects
  across the pack** in one measured call — e.g. walk N representative blob ids spanning
  the pack index — so the reader touches many pack regions / fanout buckets without
  the scenario itself buffering the whole pack. **Decision candidate #2** enumerates
  the exact workload (single-object cold read vs multi-object spread vs full walk).
- File: extend `test/bench/pack-read-scale.bench.ts` with the spread scenario (it
  already owns the scaled pack-read context) OR a new
  `test/bench/pack-read-large.bench.ts`. Recommendation: add the spread scenario to
  the existing `pack-read-scale.bench.ts` — it already resolves the scaled context and
  is the home of pack-read scenarios.
- Must derive the spread of ids deterministically from the fixture (e.g.
  `blobPath(k)` for a fixed set of `k`, resolved once via a cheap `readTree`/`rev-parse`
  at setup, outside the measured `sut`). Keep id resolution in `build`, not in `sut`.
- Baseline: **tsgit-only** for the multi-object spread at large scale (iso-git's
  repeated `readBlob` over a 200k pack is impractically slow) — matches
  `log-scale`/`status-scale`, which are also tsgit-only at scale. `BenchComparison.baseline`
  is optional. **Decision candidate #5.**

### Part D — Wiring: fixture pre-warm + CI

**Pre-chewed context**
- `tooling/gen-bench-fixture.ts` maps `argv[2]` → `MEDIUM_FIXTURE` / `LARGE_FIXTURE`.
  Add a `'delta-chain'` case → `DELTA_CHAIN_FIXTURE` so
  `npm run bench:fixture -- delta-chain` pre-warms it.
- `bench.yml` "Pre-warm the medium fixture" step runs `npm run bench:fixture --
  medium`. Add a sibling `npm run bench:fixture -- delta-chain` so the nightly run
  pre-warms the (fast, small) delta-chain fixture before `bench:summary`. The
  large-pack scenario stays gated (no `TSGIT_BENCH_LARGE` in CI) so it is skipped and
  costs nothing.
- No change needed to `tooling/bench-summarize.ts` / `bench-to-snapshot.ts` — both
  flatten every group generically; the new scenarios appear automatically. (Confirmed
  by reading both: they iterate `raw.files[].groups[].benchmarks[]` with no scenario
  allow-list.)
- `bench.yml` cache key = `hashFiles('test/bench/support/fixture-generator.ts')` —
  editing the generator (Part A) **already re-keys** the cache; no separate key edit.

### Error semantics / edge behaviour

- **`git` absent** → `FixtureUnavailableError` → scenario skips (existing path,
  reused). No new failure mode.
- **Stryker sandbox** (`STRYKER_MUTANT_ID`) → skip (existing path). Bench files carry
  no mutation obligation.
- **Chain exceeds 50** → would throw `DELTA_CHAIN_TOO_DEEP`; the design pins
  `--depth=50` precisely to keep every object resolvable. If a future git changes its
  packing heuristics and a chain does exceed 50, the bench would surface it as a
  thrown error inside the measured closure (loud, not silent) — acceptable, and a
  signal to re-pin.
- **Concurrency**: reuse the existing unique-temp-dir + atomic-rename race handling in
  `ensureScaledFixture` unchanged.

## Decision candidates

| # | Choice | Alternatives (≤3) | Recommendation | Why |
|---|---|---|---|---|
| 1 | How to force deep chains — content strategy + depth/window knobs | (a) Evolving single blob mutated ~1 %/commit + `repack -adf --depth=50 --window=250`; (b) evolving blob but keep repack at git-default window (depth 50 / window 10 → max chain 37); (c) many near-duplicate blobs (copies of a base with small edits) instead of one evolving file | **(a)** | Pinned matrix: (a) reaches chain 43, near-saturating tsgit's cap-50 without exceeding it; git-default window (b) under-fills to 37; (c) is more code for the same effect and muddies "one deep chain" with cross-blob deltas. `--depth=50` is the hard ceiling — `--depth=100` gives chain 85 and trips `DELTA_CHAIN_TOO_DEEP`. |
| 2 | Large-pack memory-pressure fixture + workload | (a) Reuse `LARGE_FIXTURE`, read a deterministic **spread of objects** across the pack in one measured call, gated by `TSGIT_BENCH_LARGE`; (b) reuse `LARGE_FIXTURE`, single cold `readBlob` (already exists in `pack-read-scale`); (c) purpose-built even-larger fixture | **(a)** | `LARGE_FIXTURE` is already ~500 MB / 200k objects — enough pressure; a purpose-built bigger one blows the budget. A single cold read is already covered; the spread is the net-new "touch many pack regions" signal. Gated so nightly CI is unaffected. |
| 3 | Fixture topology + how the delta-chain spec is shaped | (a) New `'delta-chain'` label + `DELTA_CHAIN_FIXTURE` spec + separate `streamEvolvingFastImport` strategy in the **same** generator file, sharing cache/rename machinery, NO `FIXTURE_GENERATOR_VERSION` bump (pure addition); spec gains a `strategy` discriminant + `deltaDepth`/`deltaWindow` (repurposing/replacing the `blobs` field which is meaningless for one evolving file); (b) same but bump version to 2 defensively; (c) a separate generator module | **(a)** | A new label is a pure addition — the `medium`/`large` cache shapes are untouched, so their caches stay valid; only the new `delta-chain-v1` dir is created. Editing the file already re-keys CI's cache. A separate module duplicates the cache/rename/race logic. Bump only if the shared `streamFastImport` changes (it must not). The `strategy` discriminant keeps `generateInto`'s repack args + stream-builder choice off the spec, and fixes the `blobs`/`given`-phrase mismatch for the one-file shape. |
| 4 | What to measure — is heap / peak-RSS in scope? | (a) Timing only (cold-vs-warm delta-chain gap + large-pack spread), explicitly declare heap/RSS out of scope for `vitest bench`; (b) add per-iteration `process.memoryUsage()` sampling inside/around the closure; (c) route memory capture through `tooling/profile.ts` now | **(a)** | `vitest bench` measures wall-clock; in-closure RSS sampling is noisy (GC/shared-heap) and pollutes timing. Cold-vs-warm timing is the honest proxy for cache/chain memory behaviour. If real memory numbers are wanted, they belong in the profile path (26.3), not a timing harness — state the boundary, don't fake it. |
| 5 | isomorphic-git baseline per scenario | (a) Deep-delta = comparative (include iso-git, tiny fixture); large-pack spread = tsgit-only (iso-git impractically slow at 200k); (b) both comparative; (c) both tsgit-only | **(a)** | The delta-chain fixture is tiny — iso-git runs fine and a comparative delta-chain-reader number is valuable. At 200k-object scale iso-git's repeated `readBlob` is impractically slow, matching the tsgit-only precedent of `log-scale`/`status-scale`. `baseline?` is optional by design. |
| 6 | How the delta-chain scenario resolves its fixture (it is label-specific, off the medium/large toggle) | (a) Add a small dedicated resolver mirroring `resolveScaledContext` for an explicit spec (skip on unavailable/Stryker), keep `scaledScenario` for medium/large; (b) generalise `resolveScaledContext(spec?)` / `scaledScenario` to accept any `FixtureSpec`; (c) inline the `ensureScaledFixture` + try/catch + `benchScenario({skip})` in the bench file | **(b)** | The medium/large toggle and the delta-chain fixture share the same skip/Stryker/unavailable logic; generalising `resolveScaledContext` to take an optional explicit spec (defaulting to the env-driven medium/large) is the DRY, low-churn move and keeps all 5 existing zero-arg call sites compatible via the default. (a) duplicates the resolver; (c) scatters the skip logic. |
| 7 | How the generator finds the deepest-chain object to record as `firstBlobId` | (a) Parse `git verify-pack -v` output and pick the blob line with the maximum chain-depth column; (b) probe a fixed candidate set (root + HEAD + midpoint versions) via `readObject` and keep whichever git reports deepest; (c) assume a fixed version (root or HEAD) | **(a)** | The pin proves the deepest object is neither reliably HEAD nor root — git's base direction is heuristic. `verify-pack -v` is the authoritative, deterministic source of per-object chain depth; parsing it is a handful of lines and needs no repeated `readObject`. (b) is more code and still guesses the candidate set; (c) is empirically wrong (HEAD was the *base*, depth 1). |

## Test strategy

- **Bench files are excluded from coverage** (`vitest.config.ts` instruments `src/**`
  only; `test/bench/**` is never covered) — so `delta-chain-read.bench.ts` and the
  generator/tooling edits carry **no coverage or mutation obligation**. Confirm during
  planning that the generator edit stays within the already-uncovered
  `test/bench/support` surface (it does — that path is not in the coverage `include`).
- **Correctness of the fixture is proven by the pinned matrix**, reproduced in the
  design against the real `git` binary: the deep-delta fixture yields max chain length
  ≈ 43 (≤ 50). During implementation, a one-shot `git verify-pack -v` on the freshly
  generated `delta-chain` cache confirms the chain depth lands in the pinned band —
  run manually via `npm run bench:fixture -- delta-chain` then `git verify-pack`, not
  as an automated assertion (bench fixtures are generate-once artefacts, not unit
  SUTs). If the planner wants a guard, a lightweight `test/bench/support` smoke that
  asserts `max chain length ∈ [30, 50]` on the generated pack is acceptable but
  optional — it spawns `git verify-pack`, so it must be env-isolated and `skipIf(no
  git)`.
- **No property tests** — this change touches no parser / matcher / round-trip pair;
  it is bench + fixture-generation code (the property-test lenses in CLAUDE.md do not
  fit: I/O + generation wrappers are explicitly *not* appropriate for property tests).
- **The scenarios themselves are the "test"** in the bench sense — they must (a) run
  green under `npm run test:bench` on the medium/default path (delta-chain scenario),
  and (b) skip cleanly when `git` is absent or under Stryker. Verify both:
  `npm run test:bench` locally (delta-chain runs, large-pack spread skips without
  `TSGIT_BENCH_LARGE`), and confirm `reports/benchmarks/summary.md` gains the new rows.
- **Env-isolation** of every added `git` call (author/committer/date pinned, no
  `GIT_*` inheritance, `commit.gpgsign` off implicitly via fast-import which sets no
  signature) — matches the existing generator.

## Out of scope

- **Explicit heap / peak-RSS metrics** — `vitest bench` measures wall-clock; memory
  numbers belong in the profile path (26.3). See Decision candidate #4.
- **Per-command profile capture (26.3)** — this only *adds the scenarios* so 26.3's
  baseline covers them; the profile harness itself is a separate item.
- **CI regression gate (26.5)** — thresholding the `bench:summary` diff is a later item;
  here the new scenarios only need to *appear* in the summary/snapshot.
- **Competitor comparison (26.7)** — the deep-delta comparative number feeds it later,
  but the head-to-head writeup is 26.7.
- **New adapter delta-cache tuning** — the scenarios exercise the default 16 MiB /
  65 536-entry LRU; changing cache sizing is a hot-path optimization (26.4), not a
  benchmark-scenario addition.
- **A purpose-built pack larger than `LARGE_FIXTURE`** — 200k objects / ~500 MB is
  already ample memory pressure; a bigger fixture only inflates the local/CI budget.
