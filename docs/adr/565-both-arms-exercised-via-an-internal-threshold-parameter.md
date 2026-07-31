# 565 — Both predicate arms are exercised via an internal threshold parameter

- **Status:** accepted
- **Date:** 2026-07-31
- **Design:** docs/design/whitespace-drop-fast-path.md · **Supersedes/Refines:** none

## Context

ADR-549 makes the 64 KiB buffered/streamed gate a constant internal to the blob-source
seam, and ADR-556 deleted the module spy the predicate's tests used to reach their
chunk-boundary cases. That leaves an open question the design did not have to answer: how
the test suite exercises **both** arms of the predicate when the thing selecting them is
neither configurable nor mockable. The design's own test strategy asks for the whole
verdict table to run once per arm, which needs some seam to exist.

## Options considered

1. **An optional trailing parameter** `maxBufferedBytes: number = MAX_BUFFERED_BLOB_BYTES`
   on `isWhitespaceOnlyModify` (planner's recommendation) — the production call site
   inherits the default; the unit suite re-runs its whole verdict table twice, once at the
   default and once at `0`. Pros: literally the design's "vary only the threshold
   constant"; zero public surface, zero config surface / cons: one internal
   default-valued parameter whose non-default value only tests pass.
2. **Export `compareBuffered` / `compareStreamed`** and drive them directly — cons: the
   predicate's own arm-selection branch is then only covered end-to-end at the real gate,
   and two more module exports exist whose only consumer is a test, which is a
   `check:dead-code` hazard.
3. **A `Context`- or env-level gate override** — rejected shape: a config/public surface
   change that re-opens the `core.bigFileThreshold` question ADR-385 and the design's
   out-of-scope section both close.

## Decision

Adopted-as-recommended (no user judgment): **option 1**.

## Consequences

Arm selection stays observable without timing, which is ADR-556's requirement. Interop
pins the two arms with the naturally-straddling fixtures instead of forcing a threshold —
a 345-byte file that takes the buffered arm and an 80 045-byte one that takes the streamed
arm — so the integration layer never needs the parameter at all; it exists for the unit
suite. The parameter is internal: `isWhitespaceOnlyModify` is not re-exported from
`src/domain/diff/index.ts` or `src/public-types.ts`, so `reports/api.json` does not move
on its account.
