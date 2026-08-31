---
subjects:
  - src/application/primitives/config-read.ts
---
# 773 — The pack config surface is window, depth and window memory

- **Status:** accepted
- **Date:** 2026-08-31
- **Design:** docs/design/delta-writing-packer.md (DC-7) · **Supersedes/Refines:** extends the integer-config pattern of ADR-353

## Context

Pinned against git 2.55.0: none of `pack.window`, `pack.depth`, `pack.windowMemory`,
`pack.compression` is written to disk by default — the defaults live only in git's source and
must be hardcoded. Documented values are `pack.window = 10`, `pack.depth = 50` (maximum
4095), `pack.windowMemory` unlimited. Malformed values are fatal wherever they sit in the
file, with `parseGitInt`'s own grammar verbatim: `invalid unit` for anything the number
parser rejects including a valueless key, `out of range` past the C `int` bound. `0` and
`-1` are legal for window and depth alike and mean "no deltas".

`pack.compression` is different: an out-of-range value produces
`fatal: bad pack compression level <n>`, a distinct message needing its own error arm rather
than a reuse of the generic numeric refusal.

## Options considered

1. **`pack.window` + `pack.depth` only** — pros: the brief's exact scope; the size measurement stays unambiguous / cons: leaves window residency fixed in code.
2. **Those two plus `pack.windowMemory`** (chosen) — pros: completes the window's configuration with git's own key; no new error arm / cons: a third finder and a third refusal pin.
3. **Those two plus `pack.compression`** — pros: closes a real faithfulness gap / cons: changes emitted bytes independently of deltas, making the size measurement ambiguous about cause, and needs its own error arm.

## Decision

**User-ratified.** The surface is `pack.window`, `pack.depth` and `pack.windowMemory`. All
three reuse the existing integer-config machinery: `configBadNumericValue` with the existing
`invalid unit` / `out of range` reasons, no new error code and no new reason string. All
three belong to the first-malformed-line-is-fatal family, so the finder scans in file order
and returns the first failure — not last-write-wins. `pack.depth` above 4095 warns and
clamps, matching git. `pack.compression` stays out of scope, and its distinct refusal
message is recorded here so a future adopter does not reuse the wrong arm.

## Consequences

Three keys become configurable with no new error vocabulary. Turning delta compression off
is a faithful configuration (`window` or `depth` at `0` or `-1`) rather than a tsgit-only
escape hatch. The pack deflate level remains at the adapter default, a known and now
explicitly recorded divergence from git's `pack.compression`.
