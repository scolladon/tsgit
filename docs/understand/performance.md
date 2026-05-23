# Performance

This document explains what tsgit measures, how it measures, and how to read the numbers. The bottom line first: tsgit wins decisively on `status:dirty` (2× isomorphic-git), is at parity on `clone` and `readBlob:warm`, and is currently slower on `log:walk` and `readBlob:cold`. The v4 perf pass (Phase 26) closes the gaps against a stable surface.

## Current measured numbers

Source: [`reports/benchmarks/summary.md`](../../reports/benchmarks/summary.md) — regenerable from `npm run bench:summary`.

Platform: `darwin-arm64`, Node 22.22.3, Apple M3 Pro.

| Scenario | tsgit | isomorphic-git | tsgit/iso |
|---|---|---|---|
| `clone:small-repo` | 39.5 ms | 39.8 ms | 1.01× (parity) |
| `log:walk-50-commits` | 6.4 ms | 4.2 ms | **0.66× (slower)** |
| `readBlob:cold-cache` | 0.16 ms | 0.11 ms | **0.67× (slower)** |
| `readBlob:warm-cache` | 0.107 ms | 0.097 ms | 0.90× |
| `status:clean` | 1.95 ms | 2.14 ms | 1.10× |
| `status:dirty-25-files` | 1.56 ms | 3.04 ms | **1.95× (faster)** |

GitHub Actions runners introduce ±20% variance — trust direction more than absolute numbers. Re-run on your hardware before extrapolating to your workload.

## Methodology

- **Runner:** `vitest bench`. Each scenario is iterated until 95% confidence interval stabilises (typically 100–10000 samples depending on the scenario's runtime).
- **Reported metric:** median, with ±RME (relative margin of error) captured in `reports/benchmarks/raw.json`.
- **Fixtures:** committed under `test/fixtures/`. Reproducible bit-for-bit on every host. Larger fixtures (`medium`, `large`) are deterministically regenerable via `npm run bench:fixture` and cached in `~/.cache/tsgit-bench`.
- **Comparison set:** `isomorphic-git@1.38` invoked with equivalent options. CGI lifecycle for clone benchmarks documented in [ADR-017](../adr/017-bench-cgi-server-lifecycle.md).
- **CI runs:** the `benchmark-snapshot` job runs on `main` pushes and feeds `github-action-benchmark@v1` ([ADR-056](../adr/056-benchmark-snapshot-converter-schema.md)).

## What tsgit optimises for

| Hot path | Mechanism |
|---|---|
| Pack-index lookup | Fanout binary search — O(log n) within fanout buckets of bounded size. |
| Delta resolution | LRU base cache (16 MiB default, byte-bounded, configurable via `OpenNodeRepositoryOptions.deltaCacheMaxBytes`). |
| Parsing | Zero-copy `DataView` over inflated buffers. No intermediate string allocations on the binary path. |
| Inflate | `node:zlib` (Node) / `DecompressionStream` (Browser). Streaming where possible. |
| Working-tree comparison (`status`) | Stat-cache fast path: `mtime/ctime/size/ino` match the index's recorded stat fields → no re-hash. |
| Hashing | `node:crypto` (Node) / `SubtleCrypto` (Browser). Both natively accelerated. |
| I/O | Bounded-concurrency parallel reads (8-wide where it helps; serial where order matters). |

## Why log / readBlob:cold are currently slower

- **`log:walk-50-commits`:** tsgit parses every commit fully (author/committer/message/parents) on the walk. `isomorphic-git`'s walker can skip the message body for the common "I just want oids" case. The path is in scope for Phase 26.
- **`readBlob:cold-cache`:** cold-cache reads do an extra `lstat` (containment check) that `isomorphic-git` skips. The check is a security property — see [security.md](security.md) — and is on the perf-pass list for further amortisation.

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

The limits are CI gates. Real measured bytes (`npm run reports:bundle-sizes`) and tree-shaken subset sizes (`reports:bundle-treeshake`) are scheduled for Phase 26.5 — until then the limits above are the honest upper bound.

## Roadmap

- **Phase 26.1** — Per-command profile capture (`npm run profile <cmd>`); commit baseline.
- **Phase 26.2** — Hot-path optimisations from 26.1 findings. Targets: `log:walk` ≥ 1.5× (currently 0.66×), `readBlob:cold` ≥ 1.0× (currently 0.67×).
- **Phase 26.3** — Regression gate in CI: `bench:summary` diff must not exceed ±N% per scenario.
- **Phase 26.4** — Memory-pressure scenarios (large packs, deep delta chains) added to bench suite.
- **Phase 26.5** — Bundle measurements as regenerable artifacts (`reports/bundle/{sizes,treeshake,load-time}.md`).
- **Phase 26.6** — Side-by-side competitor benchmarks (`isomorphic-git`, `simple-git`, `wasm-git`, `nodegit`). Maintained per release.

See [`../BACKLOG.md`](../BACKLOG.md) Phase 26.

## Reproduce locally

```bash
npm install
npm run build
npm run bench:summary               # writes reports/benchmarks/summary.md
TSGIT_BENCH_LARGE=1 npm run bench   # opt-in to the 50k/200k/~500 MB fixture
npm run profile                     # node --prof captures
```
