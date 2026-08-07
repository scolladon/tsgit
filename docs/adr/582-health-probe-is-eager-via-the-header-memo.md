# 582 — The health probe is eager, via the existing header memo

- **Status:** accepted (adopted-as-recommended, no user judgment)
- **Date:** 2026-08-07
- **Design:** docs/design/fsck-pack-accessibility-reporting.md (DC-2) · **Refines:** ADR-572

## Context

ADR-572 made the local pack gate lazy on purpose: a pack whose index does not claim a
requested object is never opened. But git's `fsck` opens every pack, including ones no
object needs (Pin M1/M2), so the health view cannot be built from lazily-accumulated
verdicts.

## Options considered

1. **Eager** (designer's recommendation) — `health()` awaits `pack.header()` for every
   registered pack: one 12-byte `ctx.fs.readSlice` each, no `FileHandle`, reusing the
   existing memo.
2. **Lazy** — report only packs a preceding read already probed; diverges on Pin M1/M2,
   the headline case.
3. **Synchronous `validated` flag on `RegisteredPack`** — mutable state on the read
   path, which the single-flight design explicitly declined, and it still needs the
   eager probe to populate it.

## Decision

Adopted as recommended: eager probe through the same `header()` promise-memo `lookup`
uses. A successful probe warms the memo (later lookups pay nothing); a failed probe
clears it (no negative cache preserved). `lookup`'s body is unchanged, so the lazy gate
does not regress.

## Consequences

`health()` is the one caller that opens packs a lookup would have left alone — never
call it from a read path. The refusal reason cannot drift between callers because only
one site computes it.
