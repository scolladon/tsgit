# Performance

This document explains what tsgit measures, how it measures, and how to read the numbers. The bottom line first: tsgit is competitive with isomorphic-git — it wins on `status:dirty`, `readBlob:warm`, and `clone`, and is currently slower on `status:clean`, `readBlob:cold`, and `log:walk` (the `lstat`-heavy and full-commit-parse paths). The v4 perf pass (Phase 26) is closing those gaps against a stable surface.

## Current measured numbers

Source: the CI **nightly benchmark artifact** (`bench.yml`, a dedicated GitHub Actions runner). The numbers below are hand-transcribed from a dated run so they stay citable; regenerate the raw report anytime with `npm run bench:summary` (writes `reports/benchmarks/summary.md`, uncommitted). They are **not** measured on a personal machine — a host under interactive load biases tsgit's `lstat`-heavy paths (isomorphic-git, a pinned dependency, itself measures 1.2–2.4× slower under load), so its numbers are not citable. See [ADR-483](../adr/483-committed-hand-transcribed-benchmark-snapshot.md).

Measured on the CI nightly runner: `linux-x64`, AMD EPYC 7763, Node 22.23.1 · isomorphic-git 1.38.7 · captured 2026-07-13.

| Scenario | tsgit | isomorphic-git | tsgit/iso |
|---|---|---|---|
| `clone:small-repo` | 28.5 ms | 31.1 ms | 1.09× (parity) |
| `log:walk-50-commits` | 20.2 ms | 15.7 ms | **0.78× (slower)** |
| `readBlob:cold-cache` | 0.61 ms | 0.42 ms | **0.70× (slower)** |
| `readBlob:warm-cache` | 0.33 ms | 0.40 ms | **1.21× (faster)** |
| `status:clean` | 14.4 ms | 9.6 ms | **0.67× (slower)** |
| `status:dirty-25-files` | 12.8 ms | 15.7 ms | **1.22× (faster)** |

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
- **Comparison set:** the runnable peer is **`isomorphic-git@1.38.7`** only — the one mature pure-JS git library — invoked with equivalent options on the same on-disk fixture. Other libraries are not pure-JS peers and are cited only as reference points (see above), never in the speedup table. CGI lifecycle for clone benchmarks documented in [ADR-017](../adr/017-bench-cgi-server-lifecycle.md).
- **CI runs:** the `benchmark-snapshot` job runs on `main` pushes and feeds `github-action-benchmark@v1` ([ADR-056](../adr/056-benchmark-snapshot-converter-schema.md)).

## What tsgit optimises for

| Hot path | Mechanism |
|---|---|
| Pack-index lookup | Fanout binary search — O(log n) within fanout buckets of bounded size. |
| Delta resolution | LRU base cache (16 MiB default, byte-bounded, configurable via `OpenNodeRepositoryOptions.deltaCacheMaxBytes`). A deep-delta-chain scenario benchmarks this cache under cold (empty LRU, full chain replay) and warm (cache primed) regimes — see [ADR-471](../adr/471-deep-delta-chain-bench-fixture.md). |
| Parsing | Zero-copy `DataView` over inflated buffers. No intermediate string allocations on the binary path. |
| Inflate | `node:zlib` (Node) / `DecompressionStream` (Browser). Streaming where possible. |
| Working-tree comparison (`status`) | Stat-cache fast path: `mtime/ctime/size/ino` match the index's recorded stat fields → no re-hash. |
| Hashing | `node:crypto` (Node) / `SubtleCrypto` (Browser). Both natively accelerated. |
| I/O | Bounded-concurrency parallel reads (8-wide where it helps; serial where order matters). |

## Why status:clean / readBlob:cold / log:walk are currently slower

- **`status:clean` and `readBlob:cold-cache`:** both are `lstat`-heavy, and tsgit adds a **containment check** (an extra `lstat` / path-policy step per path) that `isomorphic-git` skips. The check is a security property — it keeps a repository from reading or writing outside its working tree (see [security.md](security.md)). `status` stats every working-tree entry, so on a clean tree this per-path cost shows up directly, where iso-git can short-circuit unchanged files. A same-host historical bench (current `main` vs a pre-containment-optimisation commit, on one machine) confirmed **no regression**: `main`'s `status:clean` floor is faster than the earlier commit, so the 0.67× shift versus the earlier 1.10× snapshot is a cross-OS / stale-baseline artifact, not code drift. A `status` CPU profile then attributed the iso-git gap to the containment path itself — `resolveForMode` plus `checkContainment` accounted for ~46% of `status` self-time, well ahead of the `lstat` syscall — confirming the gap is the tax, not the diff logic. That hot path has since been amortised further (precomputed root prefixes, a single child-normalise per check, and a per-parent containment-verdict cache), with the check's verdict left unchanged. The tax itself is inherent — iso-git skips the security check entirely — so `status:clean` may still show as a loss even after amortisation.
- **`log:walk-50-commits`:** tsgit parses every commit fully (author/committer/message/parents) on the walk. `isomorphic-git`'s walker can skip the message body for the common "I just want oids" case. The path is in scope for Phase 26.

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
- **Phase 26.4** — Hot-path optimisations from 26.3 findings. Targets: `log:walk` ≥ 1.5× (currently 0.66×), `readBlob:cold` ≥ 1.0× (currently 0.67×).
- **Phase 26.5** — Regression gate in CI: `bench:summary` diff must not exceed ±N% per scenario.
- **Phase 26.7** — Competitor benchmark comparison: a head-to-head vs `isomorphic-git` (the one mature pure-JS peer, published above and in the README's "Why tsgit" slice), with `simple-git` (native `git`) and `wasm-git` (libgit2-WASM) as labelled reference points and `nodegit` excluded. Refreshed per release from the CI nightly artifact.
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
