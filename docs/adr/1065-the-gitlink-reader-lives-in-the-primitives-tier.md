---
subjects:
  - src/application/primitives/internal/gitlink-head.ts
  - src/application/commands/add.ts
  - src/application/commands/internal/embedded-repository.ts
---
# 1065 — The gitlink reader lives in the primitives tier

- **Status:** accepted
- **Date:** 2026-10-24
- **Design:** docs/design/status-gitlink-parity.md · **Supersedes/Refines:** refines ADR-1049

## Context

The reader that resolves a gitlink's HEAD the way git does (ADR-1049; `probeGitlinkCheckout`,
`gitlinkHeadOf`, with the gitfile, HEAD and commondir bounds of lesson 008) sits in
`src/application/commands/internal/gitlink-head.ts`. The comparison primitive
`src/application/primitives/compare-working-tree-entry.ts` now needs it, and the dependency rule
`commands → primitives → domain` forbids a primitive importing from the commands tier. The
reader's own imports are all primitives and domain.

## Options considered

1. **Move the module to `src/application/primitives/internal/gitlink-head.ts` unchanged** and
   rewrite its two importers (`add.ts`, `commands/internal/embedded-repository.ts`) and its unit
   suite path — the designer's recommendation.
2. **Inject a reader through `ComparisonScope`** from each command — every consumer must wire
   it, and a consumer that forgets keeps the defect.
3. **Duplicate a minimal reader in the primitive** — forks the bounds #326 pinned.

## Decision

**Adopted as recommended (no user judgment) — option 1.**

## Consequences

- The module's imports change from `../../primitives/…` to its new neighbours; its behaviour and
  its unit rows do not.
- `requireWorkTree(ctx, 'add')` inside the reader is unreachable from the primitive, which
  requires the work tree first under its own name; it stays as is.
