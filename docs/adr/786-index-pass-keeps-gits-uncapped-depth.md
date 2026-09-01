---
subjects:
  - src/application/primitives/internal/index-pack.ts
---
# 786 — The index pass keeps git's uncapped delta depth

- **Status:** accepted
- **Date:** 2026-09-01
- **Design:** docs/design/streaming-index-pass.md (DC-8) · **Refines:** ADR-771

## Context

`MAX_DELTA_CHAIN_DEPTH = 50` binds tsgit's two *readers* — `object-resolver.ts` and fsck's
`walkDeltaChain` — which ADR-771 aligned on git's full depth. It is not enforced anywhere in the
receive path. Pinned against git 2.55.0 on hand-built chains at depths 50, 51, 100 and 1 000:
`git index-pack --strict` accepts all four, and so does tsgit today. The consequence, also
pinned: tsgit will index a pack whose objects its own resolver then refuses to read.

The gap is pre-existing and was surfaced by writing this design, not created by it.

## Options considered

1. **No cap, matching git** (recommended) — pros: no new refusal on a path git accepts / cons:
   leaves the retained-ancestor memory term formally unbounded.
2. **Refuse beyond `MAX_DELTA_CHAIN_DEPTH`** — pros: closes the index-but-cannot-read gap / cons:
   refuses a pack real git accepts, a knowing divergence.
3. **No depth cap, but a path-bytes budget** — pros: the only option leaving no unbounded term in
   the memory formula / cons: a new budget with no git config key to borrow.

## Decision

**User-ratified: option 1.** The index pass applies no depth cap. Adding a refusal where git
accepts is the divergence direction the prime directive forbids by default, and ADR-771 set 50
from git's *writer* default — which says nothing about what a reader or indexer must accept.

The cost is accepted knowingly: the retained-ancestor term stays formally unbounded, and a
deliberately branching delta forest of near-maximal objects is undefended. A *linear* chain is
not exposed, because ADR-779 releases a parent at its last child.

## Consequences

The index/read depth gap stays open: tsgit indexes packs whose objects its resolver refuses past
depth 50. Whether `MAX_DELTA_CHAIN_DEPTH` should bind the readers at all belongs to ADR-771's own
record, not here. The uncapped depth is why ADR-779's walk must use an explicit stack — depth
costs heap, never the JS call stack. If the unbounded term is ever judged unacceptable, option 3
is the shape to revisit, and it does not require reopening this decision's depth semantics.
