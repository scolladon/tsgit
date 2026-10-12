---
subjects:
  - src/application/commands/add.ts
  - src/application/commands/stash.ts
  - src/application/primitives/internal/clean-order.ts
---
# 954 — `core.safecrlf=true` serialises conversion and object writes in index order

- **Status:** accepted
- **Date:** 2026-10-12
- **Design:** docs/design/eol-conversion.md · **Supersedes/Refines:** refines ADR-226, ADR-931

## Context

Pinned in §D1.6 of the design: `git -c core.safecrlf=true -c core.autocrlf=true add a1 b2 c3`
with `a1`, `c3` CRLF and `b2` LF exits 128 on `b2`; the index is untouched, `a1`'s blob — hashed
before the refusal — stays in the object store as an unreachable loose object, and `c3` is never
hashed (`objects=1`). git converts and writes one path at a time in index order. tsgit's `add`
hashes and writes paths concurrently, so a mid-add refusal would leave a different set of
unreachable blobs behind. ADR-226 binds on-disk state, and the user has twice before ruled that
refusal residue counts (ADR-931, ADR-932: the empty file a refused streamed checkout leaves).

## Options considered

1. **Refuse with the first offending path in index order, keep concurrent writes** — pros: the
   refusal data, the index and the refs match git; cons: the unreachable loose blobs written
   concurrently may differ from git's set (designer's recommendation).
2. **Serialise conversion and object writes in index order whenever `core.safecrlf=true`** —
   pros: git's exact object set after a refusal; cons: `add` and `stash push` lose their write
   concurrency under that setting.

## Decision

**User-ratified — option 2.** When `core.safecrlf` resolves to `true`, `add` (literal and bulk)
and `stash push` convert and write blobs strictly in index order, one path at a time, and stop
at the first path whose round trip loses bytes; the object store then holds exactly the blobs git
would hold, and the refusal (ADR-952) names the path git names. Under `warn` or `false` no refusal
can interrupt, so today's concurrency is kept unchanged.

## Consequences

- The cost lands only on a non-default setting; the default `warn` path keeps its parallel writes.
- The interop suite pins the loose-object set after a refusal (count and ids), not only the index.
- The existing index-order sequencer for clean filters (`internal/clean-order.ts`) is the natural
  host: under `safecrlf=true` it gates hashing and writing, not only the filter run.
- Residue faithfulness now has three precedents (ADR-931, ADR-932, this one); a future refusal
  that leaves state behind is expected to match git's residue by default.
