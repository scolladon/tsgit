# 424 — prerequisites computed by a boundary-collecting commit walk

- **Status:** accepted
- **Date:** 2026-06-27
- **Design:** docs/design/bundle.md · **Relates:** ADR-226 (git-faithfulness), ADR-421 (full rev grammar)
- **Decision class:** D-PRIMITIVE adopted-as-recommended (no user judgment)

## Context

A bundle's prerequisite lines (`-<sha> <subject>`) are exactly the boundary commits of the
selection — the excluded commits immediately reachable from the included tips, as
`git rev-list --boundary` reports them. With the full rev grammar (ADR-421), the selection
includes two-dot ranges, three-dot symmetric difference (whose boundary is the merge-base
frontier), and explicit `^`-exclusion. The objects packed are those reachable from the
included tips but not from the excluded set; the prerequisites are the boundary of that
exclusion.

## Options considered

1. **A new boundary-collecting commit walk** that yields the boundary commits as it
   enumerates the included set *(designer recommendation)* — pros: the only approach that
   matches `rev-list --boundary` for merge-base and three-dot cases; computes objects and
   prerequisites in one traversal; cons: a new primitive.
2. **Use the exclude tips directly as prerequisites** — pros: trivial; cons: wrong — the
   prerequisites are the boundary frontier, not the user's exclude arguments, and diverge
   for merge-base/three-dot selections.
3. **Post-hoc closure diff** (enumerate both closures, subtract) — pros: reuses existing
   walks; cons: two full traversals; still needs boundary identification for the
   subject-line output.

## Decision

**Option 1 — adopted as the design recommended.** A boundary-collecting commit walk
computes both the packed object set and the prerequisite (boundary) commits, matching
`rev-list --boundary`. ADR-421's full-grammar decision makes this load-bearing rather than
an optimisation.

## Consequences

- Prerequisite ordering and subject-line text are pinned against real git for two-dot,
  three-dot, and `^`-exclusion selections.
- The walk is the single source of both the object list handed to the pack assembler and
  the prerequisite lines written to the header.
