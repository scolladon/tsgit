---
subjects:
  - src/ports/context.ts
  - src/application/primitives/object-resolver.ts
---
# 854 — The loose-object cache stores `{ type, content }`, not header-prefixed bytes

- **Status:** accepted
- **Date:** 2026-09-11
- **Design:** docs/design/session-caches-per-command-floor.md (D3, DC-4) · **Supersedes/Refines:** none

## Context

`ctx.deltaCache` stores each object as a single buffer with git's loose-object header prefixed to
the content. Every write runs `prependHeader` to build it and every read runs `splitHeader` —
which scans for the NUL, decodes the header with a `TextDecoder`, and hands back a view — to take
it apart again. The type and size are known on both sides of that round trip; the buffer exists
only so the pair can be re-derived from it.

The cost is one copy per pack-resolved read, up to about 40 µs on a 400 KB target and about
0.1 µs on a commit, plus a `TextDecoder` construction per read. Git's own delta-base cache entry
carries the object type beside the data rather than re-parsing a header, which is the shape being
adopted here.

`Context` is public, so its value type is public. The change reaches `parseObject`'s content
entry point, six `create*Context` factories, nine `readRawObject` callers, and `RawObject.bytes`,
which becomes synthesised for the callers that still want a header-prefixed buffer.

## Options considered

1. **Change the value type now** (chosen) — pros: removes the round trip outright; the cache
   stops holding a wire format it immediately re-parses. Cons: a breaking public type change, and
   the next backlog item rewrites parts of the same pipeline.
2. **Keep bytes, drop only the `TextDecoder` in `splitHeader`** — pros: no public change. Cons:
   the per-read copy stays indefinitely.
3. **Defer to the next item, which owns this seam** (the design's recommendation) — pros: the
   migration happens once, alongside the read-path rewrite. Cons: it is a deferral, and this
   repository's default is that everything rides in the current change.

## Decision

**Option 1.** `ctx.deltaCache` stores `{ type, content }`. `prependHeader` and `splitHeader` are
retired from the cache path; a caller that genuinely needs a header-prefixed buffer synthesises
it explicitly at the point of need rather than every reader paying to undo it.

## Consequences

This is a **breaking change to a public type**, and therefore a major release. Phase 31 is already
scoped as the v5 line, so the bump is budgeted rather than forced by this decision alone.
`reports/api.json` regenerates.

The entry sizer must account for the type tag alongside the content length; the accounting stays
byte-based and keeps its fixed per-entry overhead term.

The next backlog item rewrites the cold read pipeline over this same seam — `readFile` views,
inflate views, the blob source's populate path. Landing the type change here means that item
inherits the finished shape instead of migrating it mid-rewrite; the design recorded the opposite
trade (churn from touching the pipeline twice) and it was weighed and rejected in favour of not
carrying a deferral.
