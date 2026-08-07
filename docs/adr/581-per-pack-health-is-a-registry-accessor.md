# 581 — Per-pack health is a registry accessor

- **Status:** accepted (adopted-as-recommended, no user judgment)
- **Date:** 2026-08-07
- **Design:** docs/design/fsck-pack-accessibility-reporting.md (DC-1) · **Refines:** ADR-574, ADR-575

## Context

`fsck` must report packs the registry refuses (header gate) or excludes (index-layer
fault at scan). The scan layer computes the index-fault verdict and discards it; the
lookup layer computes the pack-open verdict lazily, so a pack no read ever touches has
no verdict — yet git's `fsck` reports exactly such a pack (Pin M1).

## Options considered

1. **A `PackRegistry.health()` accessor** (designer's recommendation) — returns
   `{ accessible, unusable }`, fed by the memoised scan (index faults retained) plus an
   explicit header probe of every registered pack.
2. **Passive skip ledger** appended as faults occur — fails Pin M1: the lookup layer
   never probes a pack nothing requests, so the ledger is empty for the case that must
   be reported.
3. **`fsck` probes on its own** — duplicates `scanPacks`/`loadPack`/both allow-lists;
   guaranteed verdict drift, the bug class ADR-574 closed by giving the gate one
   representation.

## Decision

Adopted as recommended: one `health()` accessor on `PackRegistry`, one source of truth,
zero public surface (`PackRegistry` is barrel-private). `all()`/`lookup()`/`refresh()`/
`dispose()` keep their exact semantics.

## Consequences

The registry gains a method only `fsck` may call — an eager-probe footgun on any read
path, mitigated by its doc-comment and review. `scanPacks` retains index-fault records
alongside packs (a widened candidate outcome type, no new logic).
