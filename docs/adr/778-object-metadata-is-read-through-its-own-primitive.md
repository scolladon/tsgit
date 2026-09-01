---
subjects:
  - src/application/primitives/read-object.ts
---
# 778 — Object metadata is read through its own primitive

- **Status:** accepted
- **Date:** 2026-08-31
- **Design:** docs/design/delta-writing-packer.md (DC-12)

## Context

Ordering objects for delta selection needs each object's type and uncompressed size before
any content is read. Reading full content for every object just to learn its size makes gc's
peak memory proportional to the repository — the failure a later bounded-memory indexing
change exists to prevent, and a regression against today's writer.

The stored size is not a usable substitute: it is a property of the pack an object currently
lives in, and gc is in the business of rewriting exactly those packs, so a sort key built
from it would depend on state gc itself mutates.

## Options considered

1. **A dedicated metadata primitive** (chosen) — a packed base entry's size is already in its pack header; a packed delta entry needs one small inflate plus the existing target-size read; a loose object still costs a full inflate — pros: nearly free for the packed majority, which consolidation is dominated by; the pieces already exist / cons: a new primitive and a new read path to test.
2. **Two full read passes** — pros: simple, bounded residency / cons: doubles the read cost of the hottest whole-store pass tsgit has.
3. **One pass with all content resident** — pros: simplest and fastest / cons: peak memory proportional to the repository.

## Decision

**User-ratified.** A `readObjectMetadata` primitive returns an object's type and
uncompressed size without materialising its content, taking the cheapest route the store
allows: the pack entry header for a packed base, a bounded inflate plus the existing
target-size read for a packed delta, a full inflate only for a loose object. Delta selection
reads metadata for every object, sorts, then reads content only inside the window.

## Consequences

The metadata pass is nearly free for packed objects and bounded for loose ones, so
consolidation keeps a residency bound governed by the window rather than by repository size.
The primitive is independently useful to the batch-check read surface, which asks the same
question. Sort keys never derive from any pack-relative property.
