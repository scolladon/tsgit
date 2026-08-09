# 597 — A usable midx defers per-pack .idx loading

- **Status:** accepted (user-ratified)
- **Date:** 2026-08-08
- **Design:** docs/design/midx-read-support.md (DC-6) · **Refines:** the scan shape
  of ADR-575 (fault classification timing), PR #263's memo discipline (one more lazy
  initialiser under the same rule)

## Context

The registry's scan reads every pack's `.idx` file whole, eagerly, on the first
lookup through a `Context` — P whole-file reads for P packs, before the first object
is served. That scan I/O, not the P binary searches, is the dominant cost the midx
can remove: a midx answers the lookup itself, and only the pack the answer lands in
needs its `.idx` (for `nextOffsetForEntry`). git has the same residual dependency —
deleting a midx-named pack's `.idx` fails the read (Pin L5).

## Options considered

1. **Additive only** — keep the eager scan; the midx short-circuits the lookup loop.
   Leaves the dominant cost entirely on the table.
2. **Lazy `.idx`** — when a usable midx covers the directory, a pack's `.idx` is read
   only when that pack is touched. `RegisteredPack.index` becomes a
   `createPromiseMemo` — the pattern the registry already uses four times.
3. **Fully midx-backed** — also serve `all()`/`resolveOidPrefix`/`enumerateObjects`
   from `OIDL`; has to pick a universe where git itself has three (Pin K) and changes
   `all()`'s contract (ADR-572); its own brief.

## Decision

User-ratified as recommended: **lazy `.idx`** (option 2). The stated caveat is
accepted: with lazy loading, scan-layer `.idx`-fault classification is lazy too, so
`indexFaults()` is no longer complete until packs are touched — `health()` forces the
loads to restore completeness.

## Consequences

`RegisteredPack.index` becomes `() => Promise<PackIndex>` — a deliberate public-API
shape change with two consumers (`enumerate-objects.ts`, `resolve-oid-prefix.ts`),
both already async. `health()` awaits every pack's index memo before reporting.
Rejections are not memoised; `dispose()` stays terminal; the #263 lifecycle matrix is
unchanged. The P = 1 bench row guards the no-midx regression case.
