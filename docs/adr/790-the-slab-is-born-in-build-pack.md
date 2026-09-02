---
subjects:
  - src/application/primitives/build-pack.ts
  - src/domain/storage/pack-order.ts
  - src/application/commands/pack-objects.ts
  - src/application/commands/internal/gc-pipeline.ts
---
# 790 — The oid slab is born in `buildPack`

- **Status:** accepted
- **Date:** 2026-09-02
- **Design:** docs/design/streaming-index-pass.md (DC-A) · **Refines:** ADR-789

## Context

ADR-789 widened the `.idx`/`.rev`/cruft serializers to take the oid slab, and left open where
the slab is born for callers that do not already hold one. Four caller paths reach
`sortPackIndexEntries` through three source lines, and only the indexer's path has a slab; the
other three arrive via `buildPack` from `pack-objects.ts:87` and `gc-pipeline.ts:484,527,560`.

`buildPack` returns `BuildPackResult.entries` as `plan.ids.map((id, i) => ({ id,
...packfile.entries[i]! }))` — hex `ObjectId`s joined to `{ crc32, offset }` metas, roughly
488 B per object. Whichever option is taken, `hexToBytes` runs once per object; the question is
only whether that intermediate array is materialised on the way.

## Options considered

1. **Convert at the write boundary** (designer's recommendation) — a domain
   `packIndexEntriesFrom(entries, digestLength)`; `pack-objects` and `gc-pipeline` convert once
   before calling the writers; `BuildPackResult` unchanged. Pros: smallest published surface.
   Cons: the hex-bearing array survives on the `gc` and `pack-objects` paths, so the assembly
   reduction lands on the fetch path only.
2. **Move the slab birth into `buildPack`** — `BuildPackResult.entries` becomes
   `PackIndexEntries`, filled directly from `plan.ids` and `packfile.entries`. Pros: no
   slab-less caller remains; the term dies on every write path. Cons: a seventh published symbol
   moves; four pass-through call sites are re-pointed.
3. **Serializers accept either shape** (overload or union). Rejected on the record: two
   index-and-dereference paths inside each serializer is the second implementation ADR-625 and
   `check:duplicates` exist to prevent, and it doubles the mutation surface of code carrying
   byte-exact goldens.

## Decision

**User-ratified: option 2.** `buildPack` produces `PackIndexEntries` directly; no intermediate
hex-bearing array is materialised on any write path.

`gc` repacks the entire repository and is therefore the highest object-count path tsgit has — a
fetch pack is bounded by what a remote chose to send, a gc pack by repository size. Option 1
would have delivered the assembly reduction to the fetch path and left the term standing exactly
where the counts are largest. The conversion cost is identical either way, one level lower.

The seventh moved symbol carries no extra cost: the pending release is already a major
(3.6.0 → 4.0.0, release PR open), the same reasoning ADR-776 and ADR-789 both applied.

`packIndexEntriesFrom` is **not** written. It existed only to serve option 1's conversion point;
under this decision no caller needs it, so publishing it with no production caller does not
arise.

## Consequences

`BuildPackResult` joins the six symbols ADR-789 moves in `reports/api.json`, for seven total in
one major. `push.ts:353` and `bundle-create.ts:312` call `buildPack` but read only `.bytes` and
`.sha`, so they are unaffected. `pack-objects.ts:92` and the three `gc-pipeline` write calls pass
the slab straight through.

The `.idx` assembly term is removed from every write path rather than one, which makes the
residency requirement assertable on the gc path as well as the fetch path — the bench scenarios
gain a gc case they would not otherwise have justified. ADR-625's shared-ordering invariant is
untouched: one ordering definition still feeds every artefact, now over one input shape rather
than two.
