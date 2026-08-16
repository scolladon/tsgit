# `status` allocation profile — investigation record (W3)

Records the allocation-site ranking captured for the `status` workload ahead of any code
change, per the exit criterion: fix only the top attributed site, and only if it accounts
for at least 10 % of allocated bytes. This is a measurement record, not a claim — re-running
on a different machine will produce different absolute numbers.

## Environment

- `darwin-arm64 / node v22.22.3 / Apple M3 Pro`
- `git version 2.55.0`

## Reference signal (restated, not current)

The perf review's CPU-tick profile of `status` reported 17.5 % of ticks in GC, with the two
hottest builtins `MapPrototypeSet` at 3.6 % and `ArrayPrototypeJoin` at 1.7 %. Restated here
as the motivation for this investigation, not as a number this record re-derives — the
committed CPU baseline (`docs/perf/baseline.json` / `baseline.md`) structurally excludes
GC/builtin/RegExp frames, so it cannot be read back for the GC share directly.

## Method

Heap-sampling allocation profile (not a CPU profile) on the same child workload the
committed baseline uses: `tooling/profile-registry.ts` `READ_WORKLOADS.status` —
`await repo.status()` over `MEDIUM_FIXTURE`, 100 iterations per run — against the
names-preserved profiling bundle (`npm run build:profile` → `dist-profile/esm/index.node.js`).

```
node --heap-prof --heap-prof-interval 65536 --experimental-strip-types \
  tooling/profile.ts --child status
```

run in a throwaway `mktemp` directory (never through `npm run profile`, which would
overwrite the committed baseline). A single capture returned only 9 samples attributable to
tsgit's own code (out of 74 total — the rest is one-time process/module-load bootstrap:
`node --heap-prof-interval` samples by average bytes-since-last-sample, and 100 iterations
of `status` over the fixture just does not allocate enough tsgit-owned bytes between samples
for one run to be statistically stable). The capture was repeated 11 times (1 100 `status`
calls total) and the samples pooled before ranking, to bring the tsgit-attributed sample
count up to 150 — enough that no single site's share turns on sampling luck.

Sites are grouped by function identity (name + source location) inside
`dist-profile/esm/index.node.js` only; frames outside that bundle (Node's module loader, the
`--experimental-strip-types` TS loader, V8 builtins) are excluded, mirroring how the
committed CPU baseline keeps only tsgit frames. One further exclusion: the bundle's
module-top-level evaluation frame (`index.node.js:1:1`, function name empty) is the one-time
cost of loading the bundle itself, not per-call `status()` work, and is excluded from the
ranking and its denominator for the same reason.

## Ranking (top 10 of 89 attributed sites, by self bytes)

Total tsgit-attributed allocation across the pooled 11 runs: 10 861 640 bytes.

| Rank | Site | Source | Self bytes | Share |
| --- | --- | --- | --- | --- |
| 1 | `stepEntry` | `src/application/primitives/walk-working-tree.ts:86` | 461 736 | 4.25 % |
| 2 | `extractDetail` | `src/domain/error.ts:177` | 404 576 | 3.72 % |
| 3 | `assertEagerConfigValid` | `src/application/primitives/internal/repo-state.ts:160` | 336 760 | 3.10 % |
| 4 | `findFirstInvalidCompression` | `src/application/primitives/config-read.ts:362` | 334 240 | 3.08 % |
| 5 | `resolveDirectChain` | `src/application/primitives/resolve-ref.ts:25` | 332 632 | 3.06 % |
| 6 | `TsgitError` (constructor) | `src/domain/error.ts:83` | 332 536 | 3.06 % |
| 7 | `flattenEntry` | `src/application/primitives/internal/flatten-raw.ts:167` | 328 664 | 3.03 % |
| 8 | `compareWorkingTreeDelta` | `src/application/primitives/compare-working-tree-entry.ts:131` | 269 392 | 2.48 % |
| 9 | `buildAttributeProvider` | `src/application/primitives/internal/read-gitattributes.ts:96` | 267 232 | 2.46 % |
| 10 | `readObject` | `src/application/primitives/read-object.ts:134` | 262 552 | 2.42 % |

`ancestorsOf` (`src/application/primitives/internal/ignore-evaluator.ts`) — the design's
ranked-first candidate — does not appear anywhere in the 89 attributed sites; its allocation
share on this workload is below the sampling floor (fewer than one sample in 150 pooled).

## Verdict

Top site (`stepEntry`) accounts for **4.25 %** of allocated bytes, well under the 10 % floor.
The next six sites cluster tightly between 3.0 % and 3.7 %, spread across working-tree walk,
error construction, config validation and ref resolution — unrelated code paths, not one
construct wearing several names. The churn is diffuse, exactly the case ADR-650 accounts for.

**Outcome: no code change.** The 10 % floor is not met, so per the exit criterion this
investigation closes with a recorded finding and no fix. `stepEntry`, `extractDetail` and
`TsgitError`/`extractDetail` together (error-object construction on what should be a
non-exceptional read path) are worth a look in a future, differently-scoped pass, but
splitting one fix across several unrelated sites would make the GC-share oracle
un-attributable to a single edit — exactly what the one-site rule exists to prevent.
