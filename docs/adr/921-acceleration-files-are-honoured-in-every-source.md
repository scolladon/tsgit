---
subjects:
  - src/application/primitives/internal/midx-source.ts
  - src/application/primitives/internal/read-commit-graph.ts
  - src/application/primitives/pack-registry.ts
---
# 921 — Acceleration files are honoured in every source, as git does

- **Status:** accepted
- **Date:** 2026-10-01
- **Design:** docs/design/alternates-object-lookup.md (DC-9) · **Supersedes/Refines:** refines ADR-592/593/597 (midx), ADR-918

## Context

An alternate can host a multi-pack-index, pack/midx bitmaps and a commit-graph (single file or
split chain). The midx is correctness-bearing (Pins M1–M4). Bitmaps and the commit-graph change
speed, not answers — but git consults them in every source: a split commit-graph chain resolves
each layer by searching every source (`commit-graph.c:load_commit_graph_chain_fd_st`), and bitmap
loading walks `r->objects->sources` (`pack-bitmap.c`).

## Options considered

1. **midx per source; bitmaps and commit-graph primary-only** (designer recommendation) — pros: less work / cons: an alternate's bitmap/graph is ignored, unlike git.
2. **Every acceleration file per source, exactly as git** — pros: faithful, including git's warnings (`unable to find all commit-graph files`) and fsck coverage / cons: bitmap-closure and commit-graph source search added.

## Decision

**User-ratified — option 2.** Every acceleration file git reads from an alternate, tsgit reads
from it, with git's search order and failure handling. fsck covers each source's acceleration
files to the extent tsgit's fsck verifies that file class today.

## Consequences

- `read-commit-graph.ts` and the bitmap loader become source-aware; a chain layer is found in the first source that holds it.
- Interop pins extend to a donor-hosted commit-graph (single and split) and donor bitmaps.
