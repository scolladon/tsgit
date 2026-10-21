---
subjects:
  - src/application/primitives/object-resolver.ts
  - src/application/commands/internal/fsck/object-cache.ts
---
# 1022 — A zero-distance OFS delta refuses as object-not-found

- **Status:** accepted
- **Date:** 2026-10-20
- **Design:** docs/design/lift-delta-chain-read-cap.md (DC-4, §1 M6) · **Supersedes/Refines:** refines ADR-1019

## Context

An OFS_DELTA whose base distance is 0 names itself. Today the depth cap stops the walk at 51 with
the wrong reason; with the cap gone and no guard the resolver re-inflates and retains the same
instruction stream every iteration until the heap is exhausted (measured: ~8.5 min). Pinned on
git 2.56 and 2.55: `cat-file -t`/`-s` → `fatal: git cat-file: could not get object info` (exit
128), `cat-file -p` → `fatal: Not a valid object name <id>`, `fsck --full` → `error: failed to
validate delta base reference at offset …` — git treats the entry as an unreadable object.
`ofsDeltaBaseOffset` already refuses a negative base offset with `OBJECT_NOT_FOUND`, and both
the resolver and `readObjectMetadata` share it; fsck's walker checks `baseOffset < 0` only.

## Options considered

1. **`OBJECT_NOT_FOUND`** — widen `ofsDeltaBaseOffset` to refuse distance 0 (recommended) —
   pros: git's read path answers the way it answers a missing object; one function keeps one
   refusal for "base offset not usable" / cons: on a partial clone `withLazyFetchRetry` treats it
   as a miss and attempts one lazy fetch before the error surfaces — the cost the negative-offset
   arm already pays.
2. **`INVALID_PACK_ENTRY 'delta base offset is out of bound'`** — the wording ADR-785 adopted for
   the index pass — pros: no lazy-fetch attempt; aligns the read path's wording with the indexer's
   / cons: that wording mirrors `git index-pack`, a different git surface from the one this path
   mirrors.

## Decision

**Adopted-as-recommended (no user judgment): option 1.** `ofsDeltaBaseOffset` refuses
`baseDistance === 0` with `objectNotFound(targetId)`, serving the resolver and
`readObjectMetadata`; fsck's walker widens its OFS guard to cover distance 0 under its existing
reason `'OFS_DELTA base offset out of range'`.

## Consequences

Guard G1 is `baseDistance === 0`, never `baseOffset <= 0`: an OFS_DELTA whose distance equals
its own offset (base at byte 0) keeps today's `INVALID_PACK_INDEX` from `nextOffsetForEntry`,
which admits only `.idx`-listed offsets. Every OFS run is therefore finite — the premise
ADR-1020 builds on.
