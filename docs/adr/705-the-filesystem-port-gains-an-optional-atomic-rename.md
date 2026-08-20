# 705 — The `FileSystem` port gains an optional `atomicRename`

- **Status:** accepted
- **Date:** 2026-08-19
- **Design:** docs/design/reftable-ref-storage.md (candidate DN-2) · **Refines:** ADR-680

## Context

ADR-680 places the reftable backend on all three adapters, but the adapters do not have equal
capabilities. `BrowserFileSystem.rename` is implemented as read → write → rm, and the
`FileSystem` port's own JSDoc already states that lock-file protocols "MUST use the Node or
Memory adapter". A crash between the overwrite and the delete commits the transaction and
strands `tables.list.lock`, permanently blocking every later write — on a platform with no shell
to clean it up.

## Options considered

1. **Ship it with a documented caveat** (design recommendation) — pros: consistent with the
   status quo, since `atomicWriteRef` already runs on OPFS with the same non-atomic rename /
   cons: leaves a permanent-lockout failure mode implicit in a capability difference.
2. **Refuse reftable writes on browser** — cons: makes reftable stricter than the files backend
   on the same adapter; tsgit would refuse a reftable write while performing an equally
   non-atomic files write beside it.
3. **Add an optional `atomicRename` capability to the port**, take the real transaction path
   where it exists and a documented degraded path where it does not.

## Decision

**Option 3 — ratified by the user, against the design's recommendation.**

`FileSystem` gains an **optional** `atomicRename`. Node and memory provide it; the browser
adapter does not, and the backend takes a documented degraded path there. Omission is a
meaningful, documented answer — the same shape ADR-669 and ADR-665 already use for
`isOwnedByCaller` and `readLink`.

## Consequences

- The capability difference becomes **explicit in the type system** rather than implicit in a
  JSDoc warning. That is the substantive gain: today a caller learns about it by reading prose,
  after which nothing enforces it.
- The port widens for one subsystem, but `atomicRename` is not reftable-specific — the files
  backend's `atomicWriteRef` and every future lock-file protocol can consult the same capability,
  so this is a general seam rather than a special case.
- OPFS still cannot provide atomicity, so the browser lands on the degraded path regardless. The
  difference from option 1 is that the degradation is now *declared and detectable* instead of
  assumed, and the stranded-lock recovery path is a designed behaviour rather than a caveat.
- Recovery from a stranded `tables.list.lock` must be specified on the degraded path — a platform
  with no shell needs the library itself to be able to break a stale lock.
