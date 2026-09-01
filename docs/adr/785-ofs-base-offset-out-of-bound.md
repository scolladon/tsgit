---
subjects:
  - src/application/primitives/internal/index-pack.ts
---
# 785 — A zero or forward OFS base offset is refused as out of bound

- **Status:** accepted — **adopted-as-recommended (no user judgment)**
- **Date:** 2026-09-01
- **Design:** docs/design/streaming-index-pass.md (DC-7) · **Supersedes/Refines:** none

## Context

An `OFS_DELTA` names its base by backward distance. tsgit's guard checks only
`baseOffset < PACK_HEADER_BYTES`. A distance of **zero** therefore passes it — the entry names
itself — and falls through to the unresolved path, reporting `unresolved entry at offset 37` for
a structurally invalid pack. Pinned against git 2.55.0: git refuses the same bytes at the entry
with `fatal: pack has bad object at offset 37: delta base offset is out of bound`. This is a
defect, found by writing the design's refusal matrix.

Under ADR-784 the wrong diagnosis would get worse, not better: the entry would be folded into a
count and lose its offset entirely.

## Options considered

1. **Widen the guard** to `baseOffset < PACK_HEADER_BYTES || baseOffset >= entryOffset`, keeping
   tsgit's current message.
2. **Option 1 plus git's reason** — `delta base offset is out of bound` (recommended).
3. Leave the guard as-is; a zero distance keeps falling through.

## Decision

**Option 2.** The guard refuses both a base offset before the pack body and one at or after the
delta's own offset, with git's reason. Since ADR-784 already opens the refusal-wording question
for this module, fixing verdict and reason together keeps one decision rather than two.

## Consequences

A self-referential or forward-pointing OFS delta refuses at its own entry, naming its offset,
rather than being counted as an unresolvable delta — the same split git makes. The
`baseOffset >= entryOffset` boundary is a live mutation target: the `distance === 0` case is the
test that kills `>` in place of `>=`, and it is the case that found the defect. Note this is a
structural check at the entry, distinct from a base offset that is in range but lands mid-entry,
which remains an unresolved-delta count under ADR-784 — again matching git.
