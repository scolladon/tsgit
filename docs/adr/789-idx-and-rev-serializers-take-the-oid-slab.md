---
subjects:
  - src/domain/storage/pack-order.ts
  - src/domain/storage/pack-index.ts
  - src/domain/storage/rev-index.ts
  - src/application/primitives/internal/write-pack-artifacts.ts
---
# 789 — The idx and rev serializers take the oid slab

- **Status:** accepted
- **Date:** 2026-09-01
- **Design:** docs/design/streaming-index-pass.md (DC-10) · **Refines:** ADR-625

## Context

Once the index pass stops retaining inflated content, `.idx` assembly becomes the largest
remaining term. Measured on this repository's own clone pack (15 074 objects): the
`PackIndexWriterEntry[]` array, each carrying a 40-character hex oid, costs **7.36 MB**, and
`sortPackIndexEntries` adds **2.42 MB** more — a `SortedEntry` wrapper plus a fresh 20-byte
`Uint8Array` per object from `hexToBytes(entry.id)`, decoding hex back into bytes the new record
store already holds. Together **9.79 MB**, about 38 % of the change's ~26 MB ceiling. At
1 000 000 objects the pair costs **421.89 MB**; at 10 000 000 it exhausts Node's default heap
inside `entries.map()`.

So the pipeline runs slab → hex → slab, per object, and the round-trip is also the term.

## Options considered

1. **Keep `PackIndexWriterEntry[]`** (designer's recommendation) — pros: three domain serializers
   and their byte-exact goldens untouched, `reports/api.json` unmoved / cons: leaves the dominant
   remaining term and the round-trip in place.
2. **Widen the serializers** to take the oid slab plus parallel crc/offset arrays — pros: removes
   both halves and the round-trip / cons: a breaking change to five published symbols, and three
   of `sortPackIndexEntries`' four call sites have no slab.
3. Not considered separately: a private slab path alongside the public array path, which is
   option 1's term plus a second implementation.

## Decision

**User-ratified: option 2**, against the design's recommendation. `sortPackIndexEntries`,
`serializePackIndex` and `serializePackRevIndex` accept the oid slab with parallel crc and offset
arrays; the indexer never materialises `PackIndexWriterEntry[]`, and `hexToBytes` leaves the path.

Two facts carried the decision. The term is larger than the design credited — 9.79 MB, not the
2.3 MB quoted, because the estimate counted only `sortPackIndexEntries`' own allocation and not
the hex-bearing array beneath it. And the breaking change is free of an extra major: the last
release was 3.6.0 and the 4.0.0 release PR is still open, so this rides the pending major exactly
as ADR-776 reasoned for `PackWriterEntry`.

ADR-625's invariant is **preserved, not superseded**: one shared ordering definition still feeds
both `serializePackIndex` and `serializePackRevIndex`, so the two artefacts still cannot disagree
about index positions. Only the input shape widens.

## Consequences

`PackIndexWriterEntry`, `SortedEntry`, `sortPackIndexEntries`, `serializePackIndex` and
`serializePackRevIndex` all move in `reports/api.json`; the regenerated report is committed and
the change is called out in the release notes. The design's R12 ("api.json unchanged") and R13
("the serializers are untouched") are both falsified by this decision and are rewritten in the
design revision rather than left standing.

`build-pack.ts` and `cruft-pack-lifecycle.ts` call `sortPackIndexEntries` without a slab and must
be reconciled — either by building one or by a narrow adapter over the widened entry point. That
reconciliation is an engineering choice for the design revision, and it must not fork the
serializer into two implementations, which is the outcome ADR-625 and `check:duplicates` both
exist to prevent. The three serializers carry byte-exact goldens and `git verify-pack` cross-tool
pins; those are the regression net and none of them may be weakened to accommodate the new shape.
