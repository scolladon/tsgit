# 514 — Tree-diff hot loop: diffTrees-local byte comparison, not a global oid representation change

- **Status:** accepted
- **Date:** 2026-07-27
- **Design:** docs/design/close-isogit-perf-gap.md · **Supersedes/Refines:** optimises the surface shipped by ADR-243

## Context

Recursive tree diff on a 16k-file megarepo runs 5–8× slower than git; the profile shows the ~29k unchanged entries paying hex conversion, `TextDecoder` path decode, a branding regex, and the resulting GC — a representation tax, not decompression.

## Options considered

1. **diffTrees-local byte comparison (recommended)** — pros: compares mode+name+raw-oid bytes in the merge-join, materialises hex/decoded paths only for emitted changes; captures the win at a fraction of the blast radius / cons: internal oids stay hex strings elsewhere.
2. **Internal 20/32-byte Uint8Array oid representation end-to-end** — pros: git's representation / cons: whole-domain structural change touching every parser/serializer; its own project.

## Decision

**Adopted-as-recommended (no user judgment) — Option 1.** The merge-join in the tree-diff hot loop compares entries at the byte level; unchanged entries never reach `bytesToHex`, `TextDecoder`, or the oid regex. `ObjectId.fromRaw` gains a trusted path (length check + `bytesToHex`, no regex — provably vacuous on that input). Equal-oid subtrees are pruned before any entry materialisation. Oid validation remains at API boundaries.

## Consequences

Megarepo tree diff approaches subprocess-git parity without a domain-wide representation migration. The end-to-end Uint8Array representation stays foreclosed unless a future ADR reopens it as a dedicated change.
