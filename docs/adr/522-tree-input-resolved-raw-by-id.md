# 522 — Caller-supplied Tree objects re-read raw by tree.id

- **Status:** accepted
- **Date:** 2026-07-28
- **Design:** docs/design/raw-tree-cursor-diff.md · **Refines:** ADR-518

## Context

`DiffTreesInput` admits an already-parsed `Tree` object. The raw walk needs bytes; a parsed `Tree` has none.

## Options considered

1. **Read raw by `tree.id` (recommended)** — one extra object read (normally delta-cache warm); one walk implementation at every level. Risk: a hand-forged `Tree` whose `id` is not in the store now throws `OBJECT_NOT_FOUND`; every in-tree recursive caller passes an oid, and real parsers stamp `id` with the object's own oid.
2. **`serializeTreeContent` to synthesise bytes** — re-sorts, so the root would canonicalise while descended levels do not: the exact inconsistency ADR-518 removes.
3. **Parsed root, raw descent** — zero behaviour change for `Tree` inputs at the price of two merge-join implementations reachable in one call.

## Decision

**Ratified by user — Option 1.** The recursive path resolves any `Tree` input to raw bytes by its `id`.

## Consequences

A single walk implementation governs every level. Hand-forged in-memory `Tree` objects (id not in the store) are no longer diffable recursively — accepted and documented.
