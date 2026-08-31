---
subjects:
  - src/application/primitives/build-pack.ts
---
# 775 — Determinism is pinned by two equality tests

- **Status:** accepted
- **Date:** 2026-08-31
- **Design:** docs/design/delta-writing-packer.md (DC-9)

## Context

Three gc call sites use the emitted pack checksum as an identity key: the normal-pack build
classifies its result against existing cruft and normal pack names, the promisor build
detects a reproduced name, and the cruft build short-circuits when its bytes already exist.
Those comparisons encode crash-recovery and no-op boundaries. A packer whose output varies
across runs on identical input breaks all three silently.

Measured against git 2.55.0: git's own packer is **not** deterministic under default
threading — the same repository repacked three times spread 81 946 to 85 078 bytes, 3.8 % on
identical input, because the threaded search partitions the object list. tsgit cannot make
that trade.

## Options considered

1. **Two equality tests** (chosen) — pros: catches the failure at the boundary that matters / cons: catches instances, not the class.
2. **Plus a standing lint guard** over the selection path — pros: catches the class / cons: a bespoke audit script to own and keep accurate.
3. **Plus a committed golden pack fixture** — pros: strongest signal / cons: every legitimate heuristic tweak becomes a fixture regeneration, against a surface already ruled not byte-identical.

## Decision

**User-ratified.** Two tests pin it: `buildPack` invoked twice over the same object set must
return byte-identical packs, and a full gc run twice over the same repository must reproduce
the same pack checksums, exercising the three existing identity assertions. No lint guard,
no golden fixture.

## Consequences

Determinism is a tested property rather than a code-review convention. Because git itself is
not reproducible here, any size comparison against git must pin `pack.threads=1` and assert a
tolerance band, never an equality — tsgit's stricter determinism is a deliberate divergence
in its favour, recorded as such.
