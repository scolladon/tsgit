# Design — Memory-pressure bench scenarios (large packs, deep delta chains)

> Brief: Add memory-pressure scenarios — large packs and deep delta chains — to the
> bench suite so the Phase-26 baseline covers them, before per-command profile
> capture (26.3) and the CI regression gate (26.5).
> Status: draft → self-reviewed ×3 → accepted → **scope-folded against ADR-471..474**
> Ratified decisions: ADR-471 (delta-chain fixture: evolving blob at near-cap depth 43),
> ADR-472 (large-pack: reuse `LARGE_FIXTURE`, spread read, gated), ADR-473 (measurement:
> vitest-bench timing **plus a separate RSS/heap probe** — memory is IN scope), ADR-474
> (generator topology: new `'delta-chain'` label + strategy discriminant, resolver
> generalisation, no version bump).

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
- **Bench files AND `tooling/` are excluded from coverage** — `vitest.config.ts`
  coverage `include` is exactly
  `src/{domain,ports,adapters/node,adapters/memory,operators}/**` (verified). `test/bench/**`
  and `tooling/**` are never instrumented, so bench `.bench.ts` files, the generator edit,
  and the Part E probe (`tooling/bench-memory.ts`, mirroring the already-uncovered
  `tooling/profile.ts`) carry **no** coverage/mutation obligation. The generator lives
  under `test/bench/support`, which is *not* in the coverage `include`; confirm during
  planning that the generator edit stays inside that already-uncovered surface (it does).

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
5. The new timing scenarios flow into `reports/benchmarks/summary.md` and `snapshot.json`
   **with no tooling change** (the flatteners are generic — verified).
6. The suite reports **real RSS + `heapUsed`** (before / peak / after) for **both**
   memory-pressure workloads — the deep-delta-chain read and the large-pack spread — via
   a **separate memory probe** (Part E), run under `node --expose-gc`, emitted as its own
   artifact and **never merged into the timing summary** (ADR-473).
7. **CI bench time stays sane**: the deep-delta fixture is small to generate
   (< ~a few seconds) and runs on the **default medium path** (timing scenario + fast
   memory probe); any purpose-built large-pack fixture that is slow/GB-scale stays
   **gated** behind `TSGIT_BENCH_LARGE` (or reuses the existing `LARGE_FIXTURE`) so
   nightly CI is unaffected — this applies to both the large-pack timing scenario and its
   memory probe.
8. `FIXTURE_GENERATOR_VERSION` is **not** bumped — a new label is a pure addition and the
   `medium`/`large` cache shapes are untouched (ADR-474); the `bench.yml` cache key
   (already source-hashed on `fixture-generator.ts`) stays compatible.
9. Every `git` invocation added is env-isolated (author/committer/timestamp pinned, no
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

Load-bearing readings from this matrix (settled — **ADR-471** ratified the near-cap depth):

- **Similar content is necessary and sufficient** for deep chains — the evolving blob
  reaches chain length 43 where random content stays at ~1. The strategy is an
  *evolving blob mutated per commit*, not the existing random `blobContent`.
- **`--depth=50 --window=250` reaches chain length 43, near-saturating tsgit's
  `MAX_DELTA_CHAIN_DEPTH = 50` cap without exceeding it — this is the SETTLED choice
  (ADR-471).** The user ratified the near-cap depth (43) over the git-default-window
  moderate (chain 37, `--depth=50 --window=10`): a *memory-pressure* benchmark should
  stress the delta walker at the deepest point tsgit will accept. Both keep git's default
  depth cap of 50 — only the window differs — so a chain-43 pack is nothing a
  default-packed real repository could not contain; `git gc --aggressive`'s `--depth=250`
  is deliberately not used (tsgit refuses those chains).
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
  *maximum* chain depth, read empirically from `git verify-pack -v`** (SETTLED —
  ADR-471 ratifies the `verify-pack -v` deepest-object selection; never assume HEAD or
  root). This is deterministic (same seed + same git → same pack → same deepest object)
  and correct regardless of git's chosen base direction.

> Isolation note: the throwaway above wrote only inside `mktemp -d` with a private
> `HOME`; nothing touched the worktree's `.git/config` or any global config.

### What "memory pressure" means here (two signals, cleanly split)

Memory pressure is measured through **two separate signals** that never contaminate each
other (SETTLED — ADR-473 ratifies memory capture IN scope, kept out of the timed path):

- **vitest bench = wall-clock.** The `.bench.ts` scenarios stay **timing-only**. `vitest
  bench` has no heap/RSS capture, and per-iteration `process.memoryUsage()` sampling
  inside the measured closure is unreliable (GC timing, shared-heap noise) and would
  pollute the timing signal — so no memory sampling is ever added inside a timed `sut`.
- **probe = memory.** A **separate memory probe** (Part E) captures RSS + `heapUsed`
  *around* the two memory-pressure workloads, outside any timed iteration, under
  `node --expose-gc` with a forced GC before each baseline reading. It emits its own
  artifact and is never merged into the timing summary.

The two workloads and what each stresses:

1. **Deep delta chains** stress the **delta-base cache + iterative reconstruction**:
   a cold read replays the full chain (allocating each intermediate base buffer);
   a warm read hits the LRU.
   - *Timing signal* — the **cold-vs-warm timing gap** is the observable proxy for how
     much work the chain walk + cache save.
   - *Memory signal* — the probe reports the actual RSS/heap footprint of replaying the
     chain (before / peak / after), so the baseline carries real numbers, not only the
     timing proxy.
2. **Large pack** stresses the reader's ability to serve reads **without
   materialising the whole pack** — the fixture pack is far larger than any single
   object.
   - *Timing signal* — a spread read across the pack (Part C) confirms the reader stays
     proportional to the objects touched, not the pack size.
   - *Memory signal* — the probe reports RSS/heap around the same spread, confirming the
     footprint tracks the objects touched, not the ~500 MB pack. (Gated behind
     `TSGIT_BENCH_LARGE`, like the timing scenario.)

Real heap/RSS numbers for both workloads are delivered here (ADR-473), via the separate
probe — **not** faked inside the timing harness, and **not** deferred to 26.3. The 26.3
per-command profile harness (a general, all-commands memory harness) remains a separate,
broader item; this probe is narrow — just these two workloads.

### Part A — Teach the generator to build a deep-delta fixture

**Pre-chewed context**
- File: `test/bench/support/fixture-generator.ts`.
- Extend `FixtureSpec` with the fields the deep-delta shape needs. Current shape:
  `{ label: 'medium' | 'large'; commits; blobs; blobBytes }`.
- Add a third label `'delta-chain'` and a spec `DELTA_CHAIN_FIXTURE`. The evolving-blob
  shape is a **different generation strategy** from the multi-blob fast-import, so it
  needs its own streaming path — but it reuses the same cache/rename/meta machinery
  (`ensureScaledFixture`, `cacheDirFor`, `readCachedMeta`, atomic rename).
- **Field semantics — SETTLED (ADR-474):** `FixtureSpec` today is
  `{ label; commits; blobs; blobBytes }` where `blobs` = total distinct blobs, which is
  meaningless for a single evolving path. The ratified topology adds a **`strategy:
  'multi' | 'evolving'` discriminant** plus explicit **`deltaDepth`/`deltaWindow`**
  fields, so `generateInto` selects `streamFastImport` vs `streamEvolvingFastImport` and
  the repack knobs **off the spec (led by the discriminant), not the label**. `blobs` is
  repurposed/led by the discriminant rather than overloaded (for the evolving strategy it
  is not a file count). The `resolveScaledContext` `given` phrase currently interpolates
  `${spec.commits} commits, ${spec.blobs} blobs` — for the delta-chain shape it must read
  sensibly (e.g. "N commits, deep delta chains"); with the resolver generalisation
  (candidate #6 / ADR-474) the scenario passes the explicit `DELTA_CHAIN_FIXTURE` and the
  `given` branches off `strategy`. No `FIXTURE_GENERATOR_VERSION` bump (see below).
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
  forces a full recompute so `--depth`/`--window` actually apply). SETTLED (ADR-471 +
  ADR-474): `--depth=50 --window=250` (chain ≈ 43) are the pinned knobs, carried on the
  spec as `deltaDepth`/`deltaWindow` and applied when `strategy === 'evolving'`; the
  `multi` strategy keeps today's `git repack -ad --quiet` unchanged.
- `firstBlobId` today = `HEAD:d0/f0.dat`. For the delta-chain fixture the interesting
  object is the **object with the maximum delta-chain depth** — which the empirical
  pin shows is **NOT** `HEAD:evolving.dat` (git made HEAD the base and deltified older
  versions against it; the deepest object is an older version, e.g. the first-commit
  one at depth 38). So after `repack`, the generator must **read the deepest object's
  id from `git verify-pack -v`** — parse the blob line whose chain-depth column is the
  maximum — and record that as `firstBlobId`. Keep the `firstBlobId` field name (the
  `ScaledFixture` contract); it now names the **deepest-chain object** for this
  fixture. SETTLED (ADR-471): select the deepest object by parsing `git verify-pack -v`
  and picking the blob line with the maximum chain-depth column — the authoritative,
  deterministic source; never assume HEAD or root.
- `verify-pack -v` blob line format (pinned): `<oid> blob <size> <packed-size>
  <offset> <chain-depth> <base-oid>` for deltified objects; a base (non-delta) line
  has **no** chain-depth/base-oid columns. The generator picks the `<oid>` whose
  `<chain-depth>` is maximal. Run it env-isolated (as with every `git` call here).
- `FIXTURE_GENERATOR_VERSION`: **NO bump — SETTLED (ADR-474).** Adding a new label is a
  pure addition: the `medium`/`large` cache shapes are untouched, so their caches stay
  valid and only the new `delta-chain-v1` cache dir is created. Editing the generator file
  already re-keys CI's `actions/cache` (keyed on `hashFiles('…/fixture-generator.ts')`).
  The shared `streamFastImport` **must not change** (the evolving path is a separate
  `streamEvolvingFastImport` builder), which is what keeps a bump unnecessary.
- `FixtureUnavailableError` / `assertGitAvailable` / concurrency-safe rename: reuse
  unchanged.

**Determinism**: fixed `BASE_TIMESTAMP + commit` author/committer dates (as today),
seeded xorshift32 mutation, one file → fully reproducible pack. Cache-keyed by label.

### Part B — Deep-delta bench scenario

**Pre-chewed context**
- New file: `test/bench/delta-chain-read.bench.ts` (naming mirrors
  `pack-read-scale.bench.ts` / `read-blob.bench.ts`).
- The deep-delta fixture is small and label-specific — it does **not** ride the
  `TSGIT_BENCH_LARGE` env toggle (that only swaps medium↔large). SETTLED (ADR-474,
  candidate #6): **generalise `resolveScaledContext(spec?)` / `scaledScenario`** to accept
  an explicit `FixtureSpec`, defaulting to the env-driven medium/large spec so all five
  existing zero-arg call sites stay byte-for-byte compatible. The delta-chain scenario
  passes `DELTA_CHAIN_FIXTURE` explicitly and reuses the same skip/Stryker/unavailable
  logic (`benchScenario({ skip })`) — no duplicated resolver, no inlined skip logic. When
  the resolver takes an explicit spec, its `given` phrase must branch on `strategy` (see
  Part A) so it reads "N commits, deep delta chains" rather than "N blobs".
- Scenario shape mirrors `pack-read-scale.bench.ts` exactly:
  - **Cold**: `sut` = fresh `openRepository({ cwd })` per call → `readBlob(leafId)` →
    `dispose()`. Pays full chain replay with an empty LRU every call.
  - **Warm**: one shared `openRepository`, prime with a first `readBlob(deepId)`,
    `afterAll(dispose)`; `sut` re-reads it → LRU base hits.
  - `deepId = fixture.firstBlobId as ObjectId` — for this fixture `firstBlobId` holds
    the **deepest-chain object** (Part A), so reading it walks the longest chain.
- **Baseline — SETTLED (ADR-474, candidate #5):** include the `isomorphic-git` baseline
  (`git.readBlob({ fs, dir, oid })`) — the fixture is tiny, iso-git is not impractically
  slow here, and a comparative delta-chain-reader number is the point.
- Symbols: `openRepository` from `../../src/index.node.js`, `ObjectId` from
  `../../src/domain/objects/index.js`, `benchScenario` from
  `./support/bench-dsl.js`, the generalised `resolveScaledContext`/`scaledScenario` from
  `./support/scaled-bench.js` (now spec-parameterised), `ensureScaledFixture` +
  `DELTA_CHAIN_FIXTURE` from `./support/fixture-generator.js`.
- Given/When/Then titles via `benchScenario`; body AAA; the tsgit closure named `sut`.

### Part C — Large-pack memory-pressure scenario

**Pre-chewed context** — SETTLED (ADR-472): reuse `LARGE_FIXTURE`, spread read,
tsgit-only, gated behind `TSGIT_BENCH_LARGE`.
- Reuse the existing `LARGE_FIXTURE` (already a 200 000-object / ~500 MB single pack —
  ample pressure; a purpose-built larger fixture buys nothing and would blow the CI
  budget), **gated behind `TSGIT_BENCH_LARGE`** exactly as the existing scaled scenarios
  are (so it never runs in nightly CI, which sets no env).
- What applies the pressure: rather than a single `readBlob` (already covered by
  `pack-read-scale.bench.ts` under `TSGIT_BENCH_LARGE`), read a **spread of objects
  across the pack** in one measured call — walk N representative blob ids spanning
  the pack index — so the reader touches many pack regions / fanout buckets without
  the scenario itself buffering the whole pack. This is the net-new "large pack" signal
  beyond the existing single-object cold read.
- File — SETTLED: **extend `test/bench/pack-read-scale.bench.ts`** with the spread
  scenario (it already resolves the scaled context and is the home of pack-read
  scenarios), not a new `pack-read-large.bench.ts`.
- Must derive the spread of ids deterministically from the fixture. The generator's
  `blobPath(blobIndex)` is a **module-private** `const` (not exported), so the bench cannot
  import it — instead resolve a fixed set of index-derived paths at setup via a cheap
  `rev-parse HEAD:<path>` / `readTree` (`d<k/…>/f<…>.dat` follows the generator's own
  `blobPath` convention, spanning the pack index). Resolve once in `build`, cast the
  resulting id strings `as ObjectId`, keep id resolution **out of the measured `sut`**.
  (If the planner prefers not to reproduce the path convention, export `blobPath` from the
  generator — a trivial, side-effect-free addition on the already-uncovered support
  surface — and import it; either path is fine.)
- Baseline — SETTLED (ADR-472): **tsgit-only** for the multi-object spread at large scale
  (iso-git's repeated `readBlob` over a 200k pack is impractically slow) — matches
  `log-scale`/`status-scale`, which are also tsgit-only at scale;
  `BenchComparison.baseline` is optional by design.

### Part E — Memory probe (RSS/heap capture)

SETTLED (ADR-473): real RSS + `heapUsed` are captured for **both** memory-pressure
workloads, in a **separate harness** outside the `vitest bench` timed path — the
`.bench.ts` scenarios stay wall-clock-only; this probe is its own path so neither signal
contaminates the other.

**Pre-chewed context**
- **Where it lives:** a new `tooling/bench-memory.ts` script — the natural home, mirroring
  `tooling/profile.ts` (the existing per-hot-path capture harness). Study `profile.ts` for
  the idioms this reuses **verbatim**:
  - `SCRIPT_PATH`/`ROOT` via `fileURLToPath(import.meta.url)` + `path.resolve(..,'..')`;
    a report dir under `reports/` (`profile.ts` → `reports/profiles/`; this →
    `reports/benchmarks/`), `await mkdir(REPORT_DIR, { recursive: true })`.
  - Booting a repo: `const fixture = await ensureScaledFixture(SPEC)` then
    `const repo = await openRepository({ cwd: fixture.cwd })`, `try { … } finally {
    await repo.dispose() }`. For the cold-chain workload, re-open a fresh repo per
    iteration exactly like `profile.ts`'s `pack-read` branch
    (`openRepository → primitives.readBlob(fixture.firstBlobId) → dispose`).
  - Reading the workload objects through the same primitive the bench uses:
    `repo.primitives.readBlob(id)` (`fixture.firstBlobId` — a `string` on `ScaledFixture`,
    cast `as ObjectId` — is the deepest-chain object for the delta-chain fixture; for the
    large fixture, the **same deterministic index-derived spread as Part C's timing
    scenario**, resolved at setup via `rev-parse HEAD:<path>`, not the private
    `blobPath`).
  - The graceful-degrade guard: wrap `ensureScaledFixture` in try/catch and exit with a
    clear "fixture unavailable — install the `git` CLI" message + `process.exit(1)`,
    exactly as `profile.ts`'s `main()` does. Skip cleanly, never crash silently.
- **What it measures (new to this script — `profile.ts` does NOT do memory today, only
  CPU `--prof`):** around each workload, sample `process.memoryUsage()` (`rss` +
  `heapUsed`) at three points — **before** (post-GC baseline), **peak** (max sampled
  across the workload run), **after** (post-workload, post-GC). Force GC before each
  baseline reading via the exposed `global.gc()` for stability; the script therefore runs
  under **`node --expose-gc`**. Guard the GC call (`if (typeof global.gc === 'function')`)
  and fail loud if `--expose-gc` was omitted (the whole point is stable baselines) — a
  thrown error, not a silent skip. Peak is captured by sampling `process.memoryUsage()`
  immediately after each `readBlob` in the workload loop and keeping the max (sampling is
  *outside* any timed region — there is no wall-clock measurement here, so sampling cost
  is irrelevant, which is exactly why memory lives here and not in the `.bench.ts` timed
  `sut`).
- **Workloads (reuse the generator fixtures, no new fixture):**
  1. **Deep-delta chain** — `ensureScaledFixture(DELTA_CHAIN_FIXTURE)`; cold read of the
     deepest-chain object (`fixture.firstBlobId`) with a fresh repo per iteration (empty
     LRU → full chain replay, the allocation-heavy path). Reports before/peak/after
     RSS + heapUsed for the chain replay. Fast + small — runs on the default path.
  2. **Large-pack spread** — `ensureScaledFixture(LARGE_FIXTURE)`; the same deterministic
     index-derived spread as Part C's timing scenario (resolved at setup via
     `rev-parse HEAD:<path>`), read in one pass. **Gated behind `TSGIT_BENCH_LARGE`** (skip
     when unset), mirroring the timing scenario, so the ~500 MB fixture never generates in
     nightly CI.
- **What it emits and where:** its **own artifact**, never merged into
  `reports/benchmarks/summary.md`. Emit `reports/benchmarks/memory.json` (structured —
  `{ workload, rss: {before,peak,after}, heapUsed: {before,peak,after}, node, platform }`
  per workload) and, for human reading, a sibling `reports/benchmarks/memory.md` table.
  Keep the timing summary (`bench-summarize.ts`) untouched — it keys on `tsgit`/
  `isomorphic-git` bench names and only knows timing; the probe writes alongside it.
- **npm script:** add `bench:memory` = `npm run build && node --expose-gc
  --experimental-strip-types tooling/bench-memory.ts` — mirrors `profile`'s
  `npm run build && node …` form exactly. **Correction (found at implementation): the
  probe DOES need a prior `build`.** A strip-only runtime (`--experimental-strip-types`)
  cannot reach `openRepository` from source: `src/index.node.ts`'s transitive imports use
  `.js`-suffixed specifiers that strip-only mode won't resolve to their `.ts` siblings,
  and `src/domain/error.ts`'s `TsgitError` uses a TS parameter-property constructor that
  strip-only mode cannot even parse (`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`). `bench:fixture`
  works source-only *because it never imports `src/**`* — the memory probe does, so it
  follows `profile.ts` and consumes the compiled `dist/` instead. The large-pack workload
  is reached by `TSGIT_BENCH_LARGE=1 npm run bench:memory`.
- **Symbols/imports:** `ensureScaledFixture`, `DELTA_CHAIN_FIXTURE`, `LARGE_FIXTURE` from
  `../test/bench/support/fixture-generator.ts` (a `node:`-only source module — strips
  fine); `openRepository` is **dynamically imported from the built
  `dist/esm/index.node.js`** exactly as `profile.ts` does
  (`await import(pathToFileURL(DIST_ENTRY).href)`), typed via
  `typeof import('../src/index.node.ts').openRepository` (a type-only query, erased at
  runtime — no `any`). `ObjectId` from `../src/domain/objects/index.ts` is a type-only
  import (also erased) used to cast the resolved id strings (both `fixture.firstBlobId`
  and the resolved spread ids are `string`).
- **Env-isolation:** the probe spawns no `git` itself — it only calls `ensureScaledFixture`
  (which spawns env-isolated `git` internally, unchanged) and reads through `openRepository`.
  So no new `git`-invocation isolation surface is added by Part E.

**Coverage / gate obligation (verified against `vitest.config.ts`):** the coverage
`include` is `src/{domain,ports,adapters/node,adapters/memory,operators}/**` only —
**`tooling/` is not in the coverage include at all**, so `tooling/bench-memory.ts`
carries **no coverage or mutation obligation**, exactly the precedent set by
`tooling/profile.ts` (also uncovered tooling). (`tooling/test/unit` and
`tooling/test/integration` *projects* exist, so a pure helper extracted from the probe
*could* get an optional unit test, but nothing gates it.) See Test strategy.

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
- **Memory probe in CI (Part E) — SETTLED (ADR-473 wiring):** add a `bench:memory` step to
  `bench.yml` after `bench:summary`, running the **fast delta-chain memory probe only**
  (`npm run bench:memory`, which under `node --expose-gc` measures the delta-chain
  workload and skips the large-pack one since `TSGIT_BENCH_LARGE` is unset in CI) — mirror
  of the timing scenarios' gating. Extend the existing `upload-artifact` `path:
  reports/benchmarks/` to carry `memory.json`/`memory.md` alongside `summary.md` (no path
  change needed — it already uploads the whole `reports/benchmarks/` dir). The large-pack
  memory probe stays **local/manual** (`TSGIT_BENCH_LARGE=1 npm run bench:memory`),
  exactly like the large-pack timing scenario.
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
- **Memory probe, `--expose-gc` omitted** (Part E) → the probe throws loudly and exits
  non-zero (stable post-GC baselines are the point) — not a silent skip. The `bench:memory`
  npm script always passes `--expose-gc`, so this only bites an ad-hoc `node` invocation.
- **Memory probe, `git` absent** → `ensureScaledFixture` throws → the probe prints the
  "fixture unavailable — install `git`" message and exits non-zero (mirrors `profile.ts`).
- **Memory probe, large fixture without `TSGIT_BENCH_LARGE`** → the large-pack workload is
  skipped (only the delta-chain workload runs), mirroring the timing scenario's gate.

## Decisions (ratified — ADR-471..474)

Every candidate below is **settled**; the ADR that closed it is named. Nothing here is
open.

| # | Choice | Outcome (settled) | ADR |
|---|---|---|---|
| 1 | How to force deep chains — content strategy + depth/window knobs | Evolving single 4 KiB blob mutated ~1 %/commit + `git repack -adf --depth=50 --window=250` → max chain ≈ **43** (near-cap). **User-ratified** the near-cap depth over the git-default-window moderate (chain 37); `--depth=50` is the hard ceiling (`--depth=100` → chain 85 → `DELTA_CHAIN_TOO_DEEP`). | ADR-471 |
| 2 | Large-pack memory-pressure fixture + workload | **Reuse `LARGE_FIXTURE`**, read a deterministic **spread of objects** across the pack in one measured call, **gated by `TSGIT_BENCH_LARGE`**. Adopted as recommended. | ADR-472 |
| 3 | Fixture topology + delta-chain spec shape | New `'delta-chain'` label + `DELTA_CHAIN_FIXTURE`, a separate `streamEvolvingFastImport` builder in the **same** generator file (shared cache/rename machinery), a **`strategy: 'multi' \| 'evolving'` discriminant** + explicit `deltaDepth`/`deltaWindow` (blobs led by the discriminant), and **no `FIXTURE_GENERATOR_VERSION` bump** (pure addition). The field-semantics sub-question is closed to the discriminant form. Adopted as recommended. | ADR-474 |
| 4 | What to measure — is heap / peak-RSS in scope? | **IN scope. User-ratified — deviates from the design's timing-only recommendation.** Real RSS + `heapUsed` are captured for both workloads by a **separate memory probe** (Part E) under `node --expose-gc`, kept **out of the `vitest bench` timed path** (the honour of the design's noise concern); emitted as its own artifact, never merged into the timing summary. | ADR-473 |
| 5 | isomorphic-git baseline per scenario | Deep-delta = **comparative** (include iso-git, tiny fixture); large-pack spread = **tsgit-only** (iso-git impractically slow at 200k). Adopted as recommended. | ADR-472, ADR-474 |
| 6 | How the delta-chain scenario resolves its fixture | **Generalise `resolveScaledContext(spec?)` / `scaledScenario`** to accept an explicit `FixtureSpec`, defaulting to the env-driven medium/large spec so all five zero-arg call sites stay compatible; the delta-chain scenario passes `DELTA_CHAIN_FIXTURE` explicitly. Adopted as recommended. | ADR-474 |
| 7 | How the generator finds the deepest-chain object to record as `firstBlobId` | **Parse `git verify-pack -v`** and pick the blob line with the maximum chain-depth column — the authoritative, deterministic source; never assume HEAD or root (the pin proved HEAD is the *base*, depth 1). Folded in as settled. | ADR-471 |

## Test strategy

- **Bench files and `tooling/` are excluded from coverage.** Verified against
  `vitest.config.ts`: the coverage `include` is
  `src/{domain,ports,adapters/node,adapters/memory,operators}/**` only — `test/bench/**`
  and **`tooling/**` are never instrumented. So `delta-chain-read.bench.ts`, the generator
  edits, and the Part E probe `tooling/bench-memory.ts` all carry **no coverage or
  mutation obligation** — the probe follows the exact precedent of `tooling/profile.ts`
  (uncovered tooling). The generator edit stays within the already-uncovered
  `test/bench/support` surface (confirmed not in the coverage `include`).
- **Probe: no mandated unit test, optional helper test allowed.** Because `tooling/` is
  outside the coverage gate, the probe needs no unit test to satisfy any threshold. The
  `tooling/test/unit` + `tooling/test/integration` vitest *projects* exist, so if the
  probe grows a pure, easily-isolated helper (e.g. the `blobPath(k)` spread computation or
  the `{before,peak,after}` aggregation), a small optional unit test there is welcome —
  but nothing gates it, and the memory numbers themselves are host-specific artefacts, not
  assertable SUTs (same reasoning as `profile.ts` outputs).
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
- **The memory probe (Part E) is verified by running it**, not by an assertion: `npm run
  bench:memory` (under `--expose-gc`) must emit `reports/benchmarks/memory.json` +
  `memory.md` for the delta-chain workload and skip the large-pack one; `TSGIT_BENCH_LARGE=1
  npm run bench:memory` must additionally emit the large-pack workload numbers. It must
  degrade gracefully when `git` is absent (clear message, non-zero exit) and throw loudly
  if `--expose-gc` is missing. Confirm `summary.md` is **untouched** by the probe (the two
  artifacts are separate).
- **Env-isolation** of every added `git` call (author/committer/date pinned, no
  `GIT_*` inheritance, `commit.gpgsign` off implicitly via fast-import which sets no
  signature) — matches the existing generator. The probe adds **no** new `git`-invocation
  surface (it drives `git` only through `ensureScaledFixture`, unchanged).

## Out of scope

- **The general 26.3 per-command profile harness** — a broad, all-commands memory/CPU
  harness is still 26.3. The Part E probe here is **narrow**: just the two memory-pressure
  workloads (deep-delta read + large-pack spread). Real RSS/heap for *those two* is IN
  scope (ADR-473, Part E); a general profile harness that covers every command is not.
- **Merging memory numbers into the timing summary** — the probe emits its own
  `memory.json`/`memory.md` artifact; `reports/benchmarks/summary.md` stays timing-only
  (ADR-473). Cross-plotting timing vs memory is not built here.
- **Per-command profile capture (26.3)** — this only *adds the two scenarios + narrow
  probe* so 26.3's baseline covers them; the general profile harness itself is separate.
- **CI regression gate (26.5)** — thresholding the `bench:summary` diff is a later item;
  here the new scenarios only need to *appear* in the summary/snapshot.
- **Competitor comparison (26.7)** — the deep-delta comparative number feeds it later,
  but the head-to-head writeup is 26.7.
- **New adapter delta-cache tuning** — the scenarios exercise the default 16 MiB /
  65 536-entry LRU; changing cache sizing is a hot-path optimization (26.4), not a
  benchmark-scenario addition.
- **A purpose-built pack larger than `LARGE_FIXTURE`** — 200k objects / ~500 MB is
  already ample memory pressure; a bigger fixture only inflates the local/CI budget.
