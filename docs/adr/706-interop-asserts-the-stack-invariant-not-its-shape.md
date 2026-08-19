# 706 — Interop asserts the stack invariant, not its shape

- **Status:** accepted
- **Date:** 2026-08-19
- **Design:** docs/design/reftable-ref-storage.md (candidate DN-3) · **Refines:** ADR-680, ADR-704

## Context

Auto-compaction's decision metric is **file size**, and log-block sizes are zlib-dependent
(ADR-704: git 145 bytes where Node produces 147). Measured decision margins are as thin as
**432 vs 428 bytes**. So a two-byte DEFLATE difference can legitimately flip one merge decision,
leaving tsgit with a different *number* of tables than git for identical logical content — with
both correct.

## Options considered

1. **Assert the invariant** — after tsgit's writes, `suggestCompactionSegment` returns empty (the
   stack is compacted by git's own rule) and the merged ref view equals git's — never the table
   count.
2. **Assert table-for-table equality** — cons: flakes on *correct* behaviour, which is the worst
   kind of test: it fails for a reason the implementer cannot fix and teaches them to loosen
   assertions.
3. **Exclude log bytes from the metric** — cons: diverges from git's actual compaction rule in
   order to make a test pass, changing production behaviour to suit the harness.

## Decision

**Option 1 — adopted as recommended (no user judgment).**

Interop asserts that tsgit's resulting stack satisfies git's own compaction invariant and that
the merged view is identical. Table count and per-table boundaries are explicitly **not**
asserted, and the reason is recorded in the test so a future reader does not "tighten" it.

## Consequences

- The compaction tests are invariant-based rather than golden-based, which is the correct shape
  for a policy whose input includes an implementation-defined byte count.
- Byte-level assurance still exists where it is legitimate: ADR-704's byte-identical prefix.
- If tsgit's compaction were genuinely wrong, the invariant check catches it — an over-merged or
  under-merged stack fails `suggestCompactionSegment` emptiness or the merged-view comparison.
