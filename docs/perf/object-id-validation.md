# Measurement record — `ObjectId.from` code-unit validation

Companion to `status-allocation-profile.md`'s convention: environment banner, method,
absolute numbers, and the caveats that bound what the numbers may claim.

```text
host        darwin arm64 / Apple M3 Pro / 11 logical cores
node        v22.22.3
git         2.55.0
workload    tooling/profile.ts --child log (MEDIUM_FIXTURE, READ_ITERATIONS = 100)
method      node --prof + node --prof-process on the raw isolate log
```

## Why the committed baseline cannot carry this number

`tooling/profile-digest.ts` admits only digest lines that resolve into
`dist-profile/esm/`; V8's `RegExp:`-prefixed rows carry no file location and are
structurally excluded from `docs/perf/baseline.json`'s `hotShares`, and shares there are
normalised over tsgit-owned ticks only. The before/after evidence for this change
therefore lives in raw `--prof-process` digests, recorded here.

## Measured

| Reading | Before (regex validation) | After (code-unit scan) |
|---|---|---|
| `RegExp: ^[0-9a-f]{40}$` self-share, `log` digest | **3.9 % of total ticks / 4.4 % nonlib** — the top JS-visible frame | **absent** (zero matching rows) |
| Replacement frame | — | `JS: *isValidObjectIdHex` 4.0 % total |

The cost did not vanish — it moved from an anonymous pattern-keyed bucket into a single
named, attributable frame, and the walk no longer pays regex-engine entry/exit per oid.

## Caveats that bound the claim

- V8 keys regular-expression ticks by **pattern source**. `src/**` contains twelve
  identical `^[0-9a-f]{40}$` literals; the pre-change 3.9 % is the sum over all of them.
  On the `log` workload only `object-id.ts`'s literal sat on the per-oid path, so the
  attribution holds for that workload — but the number must not be read as
  "`object-id.ts` cost 3.9 % everywhere".
- Self-shares are Amdahl-fragile: the shares above are evidence the frame moved, not a
  wall-clock claim. Published performance numbers come from the CI nightly bench
  artifact, never from these local digests.
