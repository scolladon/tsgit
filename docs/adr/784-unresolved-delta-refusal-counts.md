---
subjects:
  - src/application/primitives/internal/index-pack.ts
---
# 784 — The unresolved-delta refusal adopts git's counting shape

- **Status:** accepted
- **Date:** 2026-09-01
- **Design:** docs/design/streaming-index-pass.md (DC-6) · **Supersedes/Refines:** none

## Context

Today a pack whose deltas cannot all be resolved refuses with one of two tsgit-authored strings:
`unresolved REF_DELTA: base <id> not in pack`, or `unresolved entry at offset <n>`. Pinned
against git 2.55.0 on hand-built packs, git instead **counts**, and uses the singular at one:
`fatal: pack has 1 unresolved delta` / `pack has 2 unresolved deltas`. The existing strings were
never git-faithful, so there is no faithfulness debt in changing them — only tests.

The root-down walk of ADR-779 also changes which entry could be called "first": a depth-first
walk discovers unreachable entries as a set, with no queue order to be first in.

## Options considered

1. **Keep both strings byte-identical** — pros: zero refusal-surface movement / cons: costs an
   extra scan to name a "first" entry that is now less meaningful, to preserve a string that was
   never faithful.
2. **Adopt git's shape** (recommended) — one reason, `pack has <N> unresolved delta(s)`, same
   `INVALID_PACK_HEADER` code.
3. Option 2 plus structured `unresolvedCount` / `firstUnresolvedOffset` fields on
   `TsgitError.data`.

## Decision

**User-ratified: option 2.** The refusal reason becomes git's count, singular at one, under the
unchanged `INVALID_PACK_HEADER` code. The forest walk produces the count for free — it is
`objectCount − resolvedCount` once the walk completes.

Option 3 was available and ADR-249 would favour it, but the extra fields were not taken: the
count is the observable git exposes, and adding fields tsgit alone defines re-opens the question
of what a caller does with them.

## Consequences

Three refusal cases converge on one message — a REF cycle, an all-deltas pack with no base
entry, and an OFS base offset landing mid-entry — which is exactly what git does on the same
bytes. `TsgitError.data.code` is unchanged, so any consumer branching on the code is unaffected;
a consumer matching the reason text sees a new string. The interop suite pins tsgit's count
against git's on the same crafted packs.
