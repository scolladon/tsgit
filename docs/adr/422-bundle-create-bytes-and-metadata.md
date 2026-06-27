# 422 — bundle create returns bytes plus structured metadata

- **Status:** accepted
- **Date:** 2026-06-27
- **Design:** docs/design/bundle.md · **Relates:** ADR-249 (structured output), ADR-416 (archive data/rendering split)
- **Decision class:** D-SURFACE adopted-as-recommended (no user judgment)

## Context

ADR-249 keeps the library returning structured data and forbids pre-rendered display
strings. A bundle file, however, is a binary on-disk artifact (a text header followed by a
packfile), not a display string — the same category as the packfile and the tar/zip bytes
`archive` produces via its serializers. Unlike `archive`, whose tar/zip serialization is a
pure domain function over an already-materialised entry stream, bundle packing requires
object I/O through `Context` (it reads and deflates objects), so a pure-domain serializer
that the caller drives is infeasible.

## Options considered

1. **Return `{ bytes, …metadata }`** — the bundle bytes plus the structured header facts
   (version, refs, prerequisites, object count) *(designer recommendation)* — pros: the
   bytes are produced where the I/O lives; the metadata is structured per ADR-249; the
   header round-trips through a pure parse/serialize pair the tests pin; cons: returns a
   byte array, not a purely structured value.
2. **Return metadata only; caller re-serializes** — pros: strictly no bytes from the
   command; cons: infeasible — pack assembly needs `Context` object access the caller
   cannot supply to a pure serializer; would duplicate the pack writer.

## Decision

**Option 1 — adopted as the design recommended.** `create` returns the bundle `bytes`
alongside structured metadata. This is consistent with ADR-249: the bytes are a faithful
binary artifact (like the packfile), not a rendered display string, and the header is a
byte-pinned parse/serialize round-trip. The pack body reuses the existing non-delta v2
pack assembler rather than a second writer.

## Consequences

- `create` is the producer of record for the bundle bytes; callers write those bytes
  wherever they wish (see ADR-428 for the asymmetry with the path-based read ops).
- The header serializer is a pure function pinned both as an example (literal git bytes)
  and as a parse/serialize round-trip property.
