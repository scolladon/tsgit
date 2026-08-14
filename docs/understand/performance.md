# Performance

This document explains what tsgit measures, how it measures, and how to read the numbers. The bottom line first: tsgit is competitive with isomorphic-git — faster on `status:dirty`, `readBlob:warm` (a cached read), `log:walk`, and `readBlob:cold` on the medium pack; at parity on `clone`. Where it trails, the cost is per-entry stat work and repository-open fixed cost — **not** a security check git itself forgoes: that check existed, was stricter than git, and has since been removed (see below). The v4 perf pass (Phase 26) is closing those gaps against a stable surface.

> **The table below predates the git-parity containment change.** It is the last
> nightly captured before that change landed, kept as-is because a dated CI
> measurement is the only citable kind ([ADR-483](../adr/483-committed-hand-transcribed-benchmark-snapshot.md)).
> That change removed a `realpath` and several per-access allocations from every
> read, so the `status:clean` and cold-read rows are expected to move — by how much
> is **unmeasured until the next nightly runs on `main`**. Read the rows below as the
> state that motivated the change, not as its outcome, and do not refresh them from a
> local run.

## Current measured numbers

Source: the CI **nightly benchmark artifact** (`bench.yml`, a dedicated GitHub Actions runner). The numbers below are hand-transcribed from a dated run so they stay citable; regenerate the raw report anytime with `npm run bench:summary` (writes `reports/benchmarks/summary.md`, uncommitted). They are **not** measured on a personal machine — a host under interactive load biases tsgit's stat-heavy paths (isomorphic-git, a pinned dependency, itself measures 1.2–2.4× slower under load), so its numbers are not citable. See [ADR-483](../adr/483-committed-hand-transcribed-benchmark-snapshot.md).

Measured on the CI nightly runner: `linux-x64`, AMD EPYC 9V74, Node 22.23.1 · isomorphic-git 1.41.3 · captured 2026-08-13.

| Scenario | tsgit/iso |
|---|---|
| `clone:small-repo` (local http) | 1.08× (parity) |
| `log:walk` (small) | **8.48× (faster)** |
| `log:walk` (medium, 5000 commits) | **15.70× (faster)** |
| `readBlob:cold-cache` (small pack) | **0.60× (slower)** |
| `readBlob:cold-cache` (medium pack) | **20.48× (faster)** |
| `readBlob:cold-cache` (fresh repo, empty LRU) | **0.33× (slower)** |
| `readBlob:warm-cache` (small, cached read) | **240× (faster)** |
| `readBlob:warm-cache` (medium, cached read) | **~16,000× (faster)** |
| `delta-chain` (cold) | **0.35× (slower)** |
| `delta-chain` (warm, cached read) | **267× (faster)** |
| `status:clean` (small) | **0.45× (slower)** |
| `status:clean` (medium) | **0.40× (slower)** |
| `status:dirty-25-files` | **1.28× (faster)** |

The `warm`/cached-read rows (`readBlob:warm-cache`, `delta-chain` warm) compare a tsgit read served entirely from its LRU delta-base cache against isomorphic-git re-reading and re-inflating the object from disk on every call — the two aren't doing the same amount of work, so the outsized ratio reflects the cache's presence, not a general throughput multiplier. Read it as "a repeated read of the same blob amortises to near-zero," not as "tsgit's raw read path is 300× faster."

GitHub Actions runners introduce ±20% variance — trust direction more than absolute numbers. Re-run on your hardware before extrapolating to your workload.

### Reference points (not pure-JS peers)

For context, two other libraries are sometimes weighed against tsgit — but neither is a pure-JS peer, so neither appears in the table above, and we do not publish a head-to-head number for them:

- **`simple-git`** wraps the native `git` binary via `child_process`. Its speed is git's speed — dominated by process-spawn overhead on small operations — and it has no browser build. Benchmarking it measures the `git` CLI, not a JavaScript library.
- **`wasm-git`** runs libgit2 compiled to WebAssembly — precisely what tsgit deliberately avoids ("zero WASM") — behind an emscripten virtual filesystem rather than a JS git API. A same-fixture comparison is structurally apples-to-oranges.

`nodegit` (native libgit2 bindings) is excluded outright: it fails to install without approving arbitrary native build scripts and pulls a dozen deprecated/vulnerable transitive dependencies. See [ADR-480](../adr/480-competitor-benchmark-set-pure-js-peer-plus-reference-points.md).

## Methodology

- **Runner:** `vitest bench`. Each scenario is iterated until 95% confidence interval stabilises (typically 100–10000 samples depending on the scenario's runtime).
- **Reported metric:** median, with ±RME (relative margin of error) captured in `reports/benchmarks/raw.json`.
- **Fixtures:** committed under `test/fixtures/`. Reproducible bit-for-bit on every host. Larger fixtures (`medium`, `large`) are deterministically regenerable via `npm run bench:fixture` and cached in `~/.cache/tsgit-bench`. A third fixture, `delta-chain`, is a small evolving 4 KiB blob mutated ~1% per commit and repacked at `--depth=50 --window=250`, producing a near-cap delta chain (~43 deep, within git's default depth cap of 50) — pre-warmed via `npm run bench:fixture -- delta-chain` and cached the same way. See [ADR-471](../adr/471-deep-delta-chain-bench-fixture.md).
- **Comparison set:** the runnable peer is **`isomorphic-git@1.41.3`** only — the one mature pure-JS git library — invoked with equivalent options on the same on-disk fixture. Other libraries are not pure-JS peers and are cited only as reference points (see above), never in the speedup table. CGI lifecycle for clone benchmarks documented in [ADR-017](../adr/017-bench-cgi-server-lifecycle.md).
- **CI runs:** the `benchmark-snapshot` job runs on `main` pushes and feeds `github-action-benchmark@v1` ([ADR-056](../adr/056-benchmark-snapshot-converter-schema.md)).

## What tsgit optimises for

| Hot path | Mechanism |
|---|---|
| Pack-index lookup | Fanout binary search — O(log n) within fanout buckets of bounded size. |
| Pack offset table (successor lookup, every packed-object read) | A usable `.rev` gathers the pack's sorted entry-offset order in O(n) instead of sorting it (O(n log n)); absent, unreadable, or refused, it falls back to the sort — same answer, different cost. |
| Delta resolution | LRU base cache (16 MiB default, byte-bounded, configurable via `OpenNodeRepositoryOptions.deltaCacheMaxBytes`). A deep-delta-chain scenario benchmarks this cache under cold (empty LRU, full chain replay) and warm (cache primed) regimes — see [ADR-471](../adr/471-deep-delta-chain-bench-fixture.md). |
| Parsing | Zero-copy `DataView` over inflated buffers. No intermediate string allocations on the binary path. |
| Inflate | `node:zlib` (Node) / `DecompressionStream` (Browser). Streaming where possible. |
| Working-tree comparison (`status`) | Stat-cache fast path: `mtime/ctime/size/ino` match the index's recorded stat fields → no re-hash. |
| Hashing | `node:crypto` (Node) / `SubtleCrypto` (Browser). Both natively accelerated. |
| I/O | Bounded-concurrency parallel reads (8-wide where it helps; serial where order matters). |

## Why status:clean / readBlob:cold / delta-chain:cold trailed in the table above

- **`status:clean`, `readBlob:cold-cache` (small pack, and any first read against a fresh repo), and `delta-chain` (cold):** the earlier claim here — that tsgit pays an inherent containment tax "because iso-git skips the security check entirely" — is superseded. The check these three scenarios used to pay (a `realpath` per read path, verifying the resolved location stayed inside the working tree) was **stricter than canonical git itself**: git reads through a symlink freely on every one of these paths and never re-validates the resolution against its roots (see [security.md](security.md)) — git skips it too. Under the git-parity prime directive, a tsgit check stricter than git is a divergence to close, not a security property to defend, so the git-parity containment change made the read side lexical and syscall-free instead of amortising a check that shouldn't have existed. What each scenario pays now: `status:clean` carries three independent contributions — the containment-check collapse, the working-tree walker's per-entry `lstat`/`joinPath` removal, and a per-invocation invariant that each tracked path is stated at most once across both scan passes. Only the first two are visible in a wall-clock bench; the one-sample-per-path invariant is proved by call count in the unit suite, not by timing, so a `status:clean` result must not be read as evidence for or against it. `readBlob:cold` and `delta-chain:cold` are dominated by **repository-open fixed cost** (discovery, pack-registry load, `.idx`/`.rev`/multi-pack-index probes), of which the containment check was one component per artefact probe; `exists`'s collapse from a full `realpath` to a lexical gate plus one `lstat` is the largest single contributor there, but neither scenario touches the working tree, so the walker and stat-map contributions above do not apply to them. The acceptance signal is the CI nightly `bench.yml` artifact on these scenarios, read at ±20% advisory variance — never a local run. A same-machine `main`-vs-branch A/B taken while the change was in review put `status:clean` at ~2× (medium) to ~2.5× (small) faster than `main` in tsgit's own wall-clock, and the fresh-repo `readBlob:cold` at ~1.4× — directional only, not citable, and recorded here so the next nightly has something to confirm or contradict rather than a blank expectation. The fresh-repo row's residual gap is the point: a ~1.4× improvement leaves it well short of parity precisely because repository-open fixed cost, not containment, is what dominates it. Note the gate asymmetry: [`hot-paths.json`](../perf/hot-paths.json) covers `status` and `pack-read` only, so `readBlob:cold-cache` (0.33× on the fresh-repo row above) and `delta-chain` cold (0.35×) are **ungated** by the `benchmark-compare` PR check and must be read off the nightly artifact by hand.
- **`log:walk`:** used to trail here on the full-commit-parse cost (tsgit parses every commit fully — author/committer/message/parents — on the walk, where `isomorphic-git`'s walker can skip the message body). The current nightly numbers show tsgit ahead on both fixture sizes (8.48× small, 15.70× medium) — kept as a note here in case an older comparison is still in circulation.

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
- **Phase 26.4** — Hot-path optimisations from 26.3 findings. Targets: `log:walk` ≥ 1.5× (currently 8.48× small / 15.70× medium), `readBlob:cold` ≥ 1.0× (currently 0.60× small pack / 20.48× medium pack).
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
