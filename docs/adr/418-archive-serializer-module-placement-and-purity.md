# 418 — archive serializers live in pure `domain/archive/`; zip injects raw DEFLATE

- **Status:** accepted
- **Date:** 2026-06-26
- **Design:** docs/design/archive.md · **Relates:** ADR-417 (raw-DEFLATE port capability), the hexagonal layering (CLAUDE.md)
- **Decision class:** D-PLACEMENT adopted-as-recommended (no user judgment)

## Context

Where do the tar/zip framers live, and is the tree-entry walk a public primitive? The
repository organises by layer: pure byte-assembly (`serializeTreeContent`,
`serializeObject`) lives in `domain/`. tar framing is pure, zero-IO byte assembly and
belongs there. zip framing, however, needs raw DEFLATE — a **port capability**
(ADR-417) — so it cannot be a zero-dependency pure function the way tar is. This
interaction (surfaced when DC2 ratified zip into scope) must be reconciled with the
"pure `domain/archive/`" placement.

## Options considered

1. **Serializers in pure public `domain/archive/`, entry-walk internal to the command**
   *(designer recommendation)* — pros: matches the by-layer organisation and the
   `serializeTreeContent` precedent; the framers are the public swap-point the brief asks
   for; cons: zip needs the raw-DEFLATE dependency expressed without breaking domain
   purity.
2. **Everything inline in `commands/archive.ts`** — pros: one file; cons: the framing is no
   longer a separable, swappable surface — contradicts the brief.
3. **New top-level `serializers/` tree** — pros: groups framers; cons: fights the repo's
   by-layer organisation for a single feature.

## Decision

**Option 1 — adopted as the design recommended.** The placement holds; zip's port
dependency is expressed by **injection**, not by relocating the serializer.

- `domain/archive/tar.ts` — a **pure, zero-dependency** function over the entry stream +
  caller rendering inputs. No IO, no port.
- `domain/archive/zip.ts` — pure over an **injected `deflateRaw` callback** (and the
  in-tree `crc32`). It takes the raw-deflate function as a parameter / small deps object;
  the command wires `ctx.compressor.deflateRaw` at the call site. Dependency injection
  keeps the framer platform-free and unit-testable with a stub deflate, while the real
  port capability stays in the adapter layer where ADR-417 placed it.
- The **tree-entry walk stays internal** to the command (no public primitive in v1) —
  YAGNI, no second consumer yet, mirroring `fsck` keeping its reachability closure inline.
  Promote to a public primitive only when a real consumer lands.

## Consequences

- Public exports: `domain/archive/tar.ts` and `domain/archive/zip.ts` (the swap-point).
- `zip`'s signature carries a `deflateRaw` dependency; `tar`'s does not.
- `crc32` is reused from `domain/storage/`.
- The entry walk is not part of the public surface in v1.
