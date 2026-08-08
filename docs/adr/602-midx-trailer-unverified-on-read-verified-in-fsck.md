# 602 — Midx trailer: unverified on read, verified in fsck

- **Status:** accepted (adopted-as-recommended, refined by ADR-601)
- **Date:** 2026-08-08
- **Design:** docs/design/midx-read-support.md (DC-11, Pin G8)

## Context

Pin G8: git never verifies the midx trailer checksum on the read path — a midx with
a flipped trailer digest is silently used. Only `fsck` and `multi-pack-index verify`
check it (`incorrect checksum`, exit 32 / 1). The design recommended never verifying
on read; ADR-601's ratification (fsck midx findings ship now) brings the fsck-time
verification into scope, which is exactly git's own split.

## Options considered

1. **Never on read** — faithful and free; fsck-time verification arrives with
   ADR-601.
2. **Verify on read** — a full-file hash on the hot path this change exists to speed
   up, and it changes answers: G8's repo reads fine under git and would stop reading
   the midx under tsgit.
3. **Verify once per `Context` behind `health()`** — moot now that ADR-601 gives the
   verification a faithful home in fsck.

## Decision

Adopted as recommended, refined: the **read path never verifies the trailer**
(option 1, git-exact per G8); **fsck verifies it** as one of ADR-601's findings —
git's own placement of the check.

## Consequences

`parseMultiPackIndex` and `loadMidxSet` never hash the file. The fsck midx pass
computes the trailer digest once per artefact and reports `incorrect checksum`
parity rows pinned by the design revision's fsck matrix.
