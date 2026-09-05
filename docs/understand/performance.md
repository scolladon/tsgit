# Performance

This document explains what tsgit measures, how it measures, and how to read the numbers. The bottom line first: tsgit is competitive with isomorphic-git — faster on `status:dirty`, `readBlob:warm` (a cached read), `log:walk`, and `readBlob:cold` on the medium pack; at parity on `clone`. Where it trails, the cost is per-entry stat work and repository-open fixed cost — **not** a security check git itself forgoes: that check existed, was stricter than git, and has since been removed (see below). The v4 perf pass (Phase 26) is closing those gaps against a stable surface.

## Current measured numbers

Source: the CI **nightly benchmark artifact** (`bench.yml`, a dedicated GitHub Actions runner). The numbers below are hand-transcribed from a dated run so they stay citable; regenerate the raw report anytime with `npm run bench:summary` (writes `reports/benchmarks/summary.md`, uncommitted). The rendered summary carries a tsgit-only scenario's own numbers with an em dash in the peer column and `n/a` for speedup, reserving `_missing entry_` for a scenario that produced no tsgit result ([ADR-809](../adr/809-a-tsgit-only-row-renders-an-em-dash-and-n-a-a-no-tsgit-row-keeps-the-missing-marker.md)). They are **not** measured on a personal machine — a host under interactive load biases tsgit's stat-heavy paths (isomorphic-git, a pinned dependency, itself measures 1.2–2.4× slower under load), so its numbers are not citable. See [ADR-483](../adr/483-committed-hand-transcribed-benchmark-snapshot.md).

Measured on the CI nightly runner: `linux-x64`, AMD EPYC 7763 64-Core Processor, Node 22.23.2 · isomorphic-git 1.41.3 · captured 2026-08-15 (`bench.yml` run 31869804879, branch `feat/cold-read-first-access`).

| Scenario | tsgit/iso |
|---|---|
| `clone:small-repo` (local http) | 1.13× (parity) |
| `log:walk` (small) | **9.54× (faster)** |
| `log:walk` (medium, 5000 commits) | **19.13× (faster)** |
| `readBlob:cold-cache` (small pack) | **0.81× (slower)** |
| `readBlob:cold-cache` (medium pack) | **27.61× (faster)** |
| `readBlob:cold-cache` (fresh repo, empty LRU) | **0.37× (slower)** |
| `readBlob:reused-handle` (open once, read N) | **1.87× (faster)** |
| `readBlob:warm-cache` (small, cached read) | **278× (faster)** |
| `readBlob:warm-cache` (medium, cached read) | **~21,563× (faster)** |
| `delta-chain` (cold) | **0.32× (slower)** |
| `delta-chain` (warm, cached read) | **314× (faster)** |
| `status:clean` (small) | **0.54× (slower)** |
| `status:clean` (medium) | **0.58× (slower)** |
| `status:dirty-25-files` | **3.54× (faster)** |

The `warm`/cached-read rows (`readBlob:warm-cache`, `delta-chain` warm) compare a tsgit read served entirely from its LRU delta-base cache against isomorphic-git re-reading and re-inflating the object from disk on every call — the two aren't doing the same amount of work, so the outsized ratio reflects the cache's presence, not a general throughput multiplier. Read it as "a repeated read of the same blob amortises to near-zero," not as "tsgit's raw read path is 300× faster."

GitHub Actions runners introduce ±20% variance — trust direction more than absolute numbers. Re-run on your hardware before extrapolating to your workload.

### Reference points (not pure-JS peers)

For context, two other libraries are sometimes weighed against tsgit — but neither is a pure-JS peer, so neither appears in the table above, and we do not publish a head-to-head number for them:

- **`simple-git`** wraps the native `git` binary via `child_process`. Its speed is git's speed — dominated by process-spawn overhead on small operations — and it has no browser build. Benchmarking it measures the `git` CLI, not a JavaScript library.
- **`wasm-git`** runs libgit2 compiled to WebAssembly — precisely what tsgit deliberately avoids ("zero WASM") — behind an emscripten virtual filesystem rather than a JS git API. A same-fixture comparison is structurally apples-to-oranges.

`nodegit` (native libgit2 bindings) is excluded outright: it fails to install without approving arbitrary native build scripts and pulls a dozen deprecated/vulnerable transitive dependencies. See [ADR-480](../adr/480-competitor-benchmark-set-pure-js-peer-plus-reference-points.md).

## Methodology

- **Runner:** `vitest bench`. Each scenario is iterated until 95% confidence interval stabilises (typically 100–10000 samples depending on the scenario's runtime). A scenario whose measured function throws during warmup fails the run — the bench DSL sets tinybench's `throws` — so a green sweep means every scenario measured; the snapshot converter refuses, by scenario name, any entry with no measurement before anything is published ([ADR-800](../adr/800-the-zero-sample-guard-lives-in-both-the-bench-dsl-and-the-snapshot-converter.md)/[ADR-802](../adr/802-the-converter-refusal-is-a-separate-exported-guard-called-from-main-only.md)).
- **Reported metric:** median, with ±RME (relative margin of error) captured in `reports/benchmarks/raw.json`.
- **Fixtures:** committed under `test/fixtures/`. Reproducible bit-for-bit on every host. Larger fixtures (`medium`, `large`) are deterministically regenerable via `npm run bench:fixture` and cached in `~/.cache/tsgit-bench`. The cache is shared and read-only for benches: a bench whose `sut` must write (`checkout`, `gc`) works on a disposable copy created beside the fixture and removed after the scenario's last measurement. On a cache hit the generator verifies the fixture's identity — `HEAD` on `refs/heads/main`, its tip matching the recorded commit — and rebuilds, with a warning, a fixture a bench mutated; a fixture git cannot verify is kept and reported, never destroyed. `npm run bench:fixture -- --prune` reclaims stale caches from older generator versions and abandoned build/scratch leftovers whose owning process is gone; nothing is reclaimed automatically. A scaled bench skips only when `git` is unavailable — any other fixture error fails the bench file rather than silently dropping its scenarios. A third fixture, `delta-chain`, is a small evolving 4 KiB blob mutated ~1% per commit and repacked at `--depth=50 --window=250`, producing a near-cap delta chain (~43 deep, within git's default depth cap of 50) — pre-warmed via `npm run bench:fixture -- delta-chain` and cached the same way. See [ADR-471](../adr/471-deep-delta-chain-bench-fixture.md).
- **Comparison set:** the runnable peer is **`isomorphic-git@1.41.3`** only — the one mature pure-JS git library — invoked with equivalent options on the same on-disk fixture. Other libraries are not pure-JS peers and are cited only as reference points (see above), never in the speedup table. CGI lifecycle for clone benchmarks documented in [ADR-017](../adr/017-bench-cgi-server-lifecycle.md).
- **CI runs:** the `benchmark-snapshot` job runs on `main` pushes and feeds `github-action-benchmark@v1` ([ADR-056](../adr/056-benchmark-snapshot-converter-schema.md)). `benchmark-snapshot` is bounded at 30 minutes for its one full sweep; `benchmark-compare` at 60 for its six hot-path-subset passes ([ADR-801](../adr/801-the-benchmark-snapshot-job-bounds-the-run-phase-hang-with-a-timeout.md)).
- **Unit-of-work asymmetry:** `readBlob:cold-cache` (fresh repo) measures a stateful `openRepository` + `readBlob` + `dispose` sequence against isomorphic-git's stateless `git.readBlob({fs, dir, oid})` call — roughly a third of the tsgit side is handle lifecycle the peer never performs. The reused-handle shape most real consumers use (open once, read many objects) is measured separately by the `readBlob:reused-handle` scenario in `test/bench/loose-read.bench.ts`.
- **Profile tick totals and under-sampling (`npm run profile`, `docs/perf/baseline.json`):** each command's `docs/perf/baseline.json` entry carries a `totalTicks` figure alongside its frame shares — the raw sample count the shares were computed from, not just the normalised percentages. Below `UNDER_SAMPLED_TICK_FLOOR` (500 ticks), the entry is marked `underSampled: true` in the JSON and rendered with an explicit "under-sampled" marker in `baseline.md`, rather than presenting a share vector whose ranking rests on too few samples as if it were trustworthy. `tooling/profile-registry.ts` raises each workload's iteration count only as far as needed to clear the floor (recorded per-workload, with the measured tick total in a comment); a command that still cannot clear it economically is left honestly marked rather than hidden.
- **Profiler setup-vs-command attribution:** the profiler hoists write-workload scratch-repo construction out of the sampled `commit`/`merge` run loop (build every scratch first, then run the measured command over each) so repo-open cost cannot leak into command frames. `add`'s build stays interleaved with its run — its `run` needs the working-tree files its own build just wrote — so its build cost is instead classified into `setupShares` by name (`SETUP_FRAMES` in `tooling/profile-digest.ts`). `add.bench.ts`, `commit.bench.ts` and `merge.bench.ts` (the `vitest bench` suite, not the profiler) still build their scratch repo inside `sut` — a separate, accepted asymmetry: the bench and the profiler measure with independent framings, and this doc's `add`/`commit`/`merge` bench numbers include that build cost.
- **Concurrency bounds derive from the limiting resource, not a fixed constant.** Every bounded pool resolves its width from a two-bucket policy (`cpuBound`, `ioBound`) computed from machine facts — on Node, `os.availableParallelism()` and the libuv threadpool width (`UV_THREADPOOL_SIZE`, default 4). `cpuBound` is capped at the threadpool width (a CPU-bound pool wider than libuv only adds latency); `ioBound` deliberately oversubscribes it (a blocked `lstat`/read profits from queued work keeping the pool saturated). **tsgit never sets `UV_THREADPOOL_SIZE` itself** — mutating `process.env` is hostile to the host application and, past the first threadpool use, inert. Raising the ceiling is the integrating application's job, done **before the first threadpool use** (before importing tsgit, in practice). A runtime that accepts but may not honour the variable (Deno, Bun) is treated as "threadpool width unknown" and takes the safe floor, same as workerd and the browser's `navigator.hardwareConcurrency` clamp.

## What tsgit optimises for

| Hot path | Mechanism |
|---|---|
| Pack-index lookup | Fanout binary search — O(log n) within fanout buckets of bounded size. |
| Pack offset table (successor lookup, every packed-object read) | A usable `.rev` gathers the pack's sorted entry-offset order in O(n) instead of sorting it (O(n log n)); absent, unreadable, or refused, it falls back to the sort — same answer, different cost. |
| Delta resolution | LRU base cache (16 MiB default, byte-bounded, configurable via `OpenNodeRepositoryOptions.deltaCacheMaxBytes`). A deep-delta-chain scenario benchmarks this cache under cold (empty LRU, full chain replay) and warm (cache primed) regimes — see [ADR-471](../adr/471-deep-delta-chain-bench-fixture.md). A same-sized offset-keyed delta-base cache for mid-chain intermediates sits alongside it as a separate, additive budget rather than a share of it — see [ADR-736](../adr/736-delta-base-cache-is-additive-not-a-fraction.md) for the full ~34 MiB default total across every cache in this family. |
| Parsing | Zero-copy `DataView` over inflated buffers. No intermediate string allocations on the binary path. |
| Inflate | `node:zlib` (Node) / `DecompressionStream` (Browser). Streaming where possible. |
| Working-tree comparison (`status`) | Stat-cache fast path: `mtime/ctime/size/ino` match the index's recorded stat fields → no re-hash. |
| Hashing | `node:crypto` (Node) / `SubtleCrypto` (Browser). Both natively accelerated. |
| I/O | Bounded-concurrency parallel reads, width derived from the limiting resource (see Methodology); serial where order matters. |

## Why status:clean / readBlob:cold / delta-chain:cold trailed in the table above

- **`status:clean`, `readBlob:cold-cache` (small pack), and `delta-chain` (cold):** the earlier claim here — that tsgit pays an inherent containment tax "because iso-git skips the security check entirely" — is superseded. The check these three scenarios used to pay (a `realpath` per read path, verifying the resolved location stayed inside the working tree) was **stricter than canonical git itself**: git reads through a symlink freely on every one of these paths and never re-validates the resolution against its roots (see [security.md](security.md)) — git skips it too. Under the git-parity prime directive, a tsgit check stricter than git is a divergence to close, not a security property to defend, so the git-parity containment change made the read side lexical and syscall-free instead of amortising a check that shouldn't have existed. What each scenario pays now: `status:clean` carries three independent contributions — the containment-check collapse, the working-tree walker's per-entry `lstat`/`joinPath` removal, and a per-invocation invariant that each tracked path is stated at most once across both scan passes. Only the first two are visible in a wall-clock bench; the one-sample-per-path invariant is proved by call count in the unit suite, not by timing, so a `status:clean` result must not be read as evidence for or against it. On the nightly, `status:clean` moved 0.45× → 0.54× (small) and 0.40× → 0.58× (medium): the containment collapse and walker changes landed, and what remains is per-entry stat work. `readBlob:cold-cache` (small pack) moved 0.60× → 0.81× for the same reason — fewer packed reads on this fixture leave repository-open fixed cost still dominant, so the row narrows the gap without reaching parity. `delta-chain` (cold) moved 0.35× → 0.32×, a shift inside the runner's own noise rather than a regression to read into.
- **`readBlob:cold-cache` (fresh repo, empty LRU):** this row needs a more careful reading than the others, because it did **not** visibly improve on the nightly. The pre-change nightly measured 0.39×; the first nightly dispatched on this branch measured 0.45×; the nightly this page transcribes measured 0.37×. Both branch runs exercise the **identical code** for this row, so the swing between them is not the change moving — between the two runs isomorphic-git's own side moved roughly −12% and tsgit's roughly +7%, each individually inside the ±20% variance this runner already carries (see Methodology). At an effect of this size (~12% wall-clock), the CI nightly's own variance exceeds the effect: it **cannot resolve** a change of this magnitude on this scenario, so 0.37× and 0.45× read as the same result, not as evidence the change helped or hurt. A same-machine `main`-vs-branch A/B taken while the change was in review supports a real, repeatable improvement — −0.0528 ms on a 0.443 ms scenario, with ±0.011 rme bands either side — but that figure is directional only and is not published here as a ratio: only a dated nightly measurement is citable ([ADR-483](../adr/483-committed-hand-transcribed-benchmark-snapshot.md)). What the row's residual gap actually is: **repository-open fixed cost plus first-object-access store setup**, not containment. Name the split from design §1.1: open ≈ 30%, first read ≈ 48%, and the steady-state read is already ahead of the peer. The shape most real consumers use — open a repository once and read many objects through it — is measured separately as the `readBlob:reused-handle` scenario, which lands at 1.87×: ahead of parity, because it pays the fixed open cost once rather than once per read.
- **`readBlob:cold-cache` (medium pack) and `delta-chain` (cold), repository-open dominance:** both remain dominated by **repository-open fixed cost** (discovery, pack-registry load, `.idx`/`.rev`/multi-pack-index probes), of which the containment check was one component per artefact probe; `exists`'s collapse from a full `realpath` to a lexical gate plus one `lstat` is the largest single contributor there. Neither scenario touches the working tree, so the walker and stat-map contributions above do not apply to them. The acceptance signal is the CI nightly `bench.yml` artifact on these scenarios, read at ±20% advisory variance — never a local run. Note the gate asymmetry: [`hot-paths.json`](../perf/hot-paths.json) covers `status` and `pack-read` only, so `readBlob:cold-cache` (0.37× on the fresh-repo row above) and `delta-chain` cold (0.32×) are **ungated** by the `benchmark-compare` PR check and must be read off the nightly artifact by hand.
- **`log:walk`:** used to trail here on the full-commit-parse cost (tsgit parses every commit fully — author/committer/message/parents — on the walk, where `isomorphic-git`'s walker can skip the message body). The current nightly numbers show tsgit ahead on both fixture sizes (9.54× small, 19.13× medium) — kept as a note here in case an older comparison is still in circulation.

The committed CPU profile that attributed ~46% of `status` self-time to the containment path itself (`resolveForMode` plus `checkContainment`, well ahead of the `lstat` syscall) is the condition [`checkcontainment-hot-path.md`](../design/checkcontainment-hot-path.md)'s Lever 5c — a trusted-internal-path fast-path — named as its own re-entry trigger: "returns only if a future profile shows containment *itself* dominating". That condition is now met by the committed profile, not by this change. Lever 5c stays out of scope here: it is a further security-boundary narrowing (skipping the check for paths lexically under the canonical `gitDir`), not a git-parity fix, and per that design it requires its own security-reviewed proposal with an explicit trust boundary and user sign-off before it is proposed again.

## Bundle size

| Entry | Limit (size-limit-enforced) | What it loads |
|---|---|---|
| `dist/esm/index.js` (Core) | 50 KB gz | Types + shared bits |
| `dist/esm/index.node.js` (Node facade) | 60 KB gz | Above + Node adapters |
| `dist/esm/index.default.js` (Memory facade) | 60 KB gz | Above + Memory adapter |
| `dist/esm/index.browser.js` (Browser facade) | 60 KB gz | Above + Browser adapters |
| `dist/esm/primitives/index.js` | 40 KB gz | Tier-2 primitives only |
| `dist/esm/operators/index.js` | 5 KB gz | `pipe`, `filter`, `map`, … |
| `dist/esm/transport/index.js` | 2 KB gz | Middleware (`withRetry`, `withAuth`, `withLogging`) |
| `dist/esm/adapters/{node,browser,memory}/index.js` | 10 KB gz each | One adapter family |
| Full library (every file) | 260 KB gz | Worst case if someone deep-imports everything |

The limits are CI gates. Real measured bytes (`npm run reports:bundle-sizes`) and tree-shaken subset sizes (`reports:bundle-treeshake`) are scheduled for Phase 26.8 — until then the limits above are the honest upper bound.

## Roadmap

- **Phase 26.3** — Per-command profile capture (`npm run profile <cmd>`); commit baseline.
- **Phase 26.4** — Hot-path optimisations from 26.3 findings. Targets: `log:walk` ≥ 1.5× (currently 9.54× small / 19.13× medium), `readBlob:cold` ≥ 1.0× (currently 0.81× small pack / 27.61× medium pack).
- **Phase 26.5** — Regression gate in CI: the PR `benchmark-compare` job benches the base branch and the PR head on the **same runner** and flags any `tsgit` scenario whose median runtime regresses beyond ~10% (improvements never flag). It is **advisory** (`continue-on-error`) — same-runner benchmarking is too noisy to block a merge, so it posts the per-scenario deltas as a PR comment rather than gating. Comparison logic lives in `tooling/bench-check.ts`. The gate is **hot-path-scoped**: it compares only the operations listed in [`../perf/hot-paths.json`](../perf/hot-paths.json), a list derived from absolute nightly `bench.yml` timings cross-checked against the Phase-26 revealed optimisation effort (ADR-501) and re-derived each major version (ADR-505).
- **Phase 26.7** — Competitor benchmark comparison: a head-to-head vs `isomorphic-git` (the one mature pure-JS peer, published above — this page is the only published comparison surface; the README links here without carrying numbers, per [ADR-624](../adr/624-readme-links-performance-analysis-no-comparison-table.md)), with `simple-git` (native `git`) and `wasm-git` (libgit2-WASM) as labelled reference points and `nodegit` excluded. Refreshed per release from the CI nightly artifact.
- **Phase 26.8** — Bundle measurements as regenerable artifacts (`reports/bundle/{sizes,treeshake,load-time}.md`).

See [`../BACKLOG.md`](../BACKLOG.md) Phase 26.

## Reproduce locally

```bash
npm install
npm run build
npm run bench:summary               # writes reports/benchmarks/summary.md
TSGIT_BENCH_LARGE=1 npm run bench   # opt-in to the 50k/200k/~500 MB fixture
npm run profile                     # node --prof captures
npm run bench:memory                # builds first, runs under --expose-gc,
                                     # writes reports/benchmarks/memory.{json,md}
TSGIT_BENCH_LARGE=1 npm run bench:memory  # adds the large-pack memory workload
```
