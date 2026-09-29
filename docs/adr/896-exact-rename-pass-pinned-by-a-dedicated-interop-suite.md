---
subjects:
  - test/integration/rename-exact-interop.test.ts
---
# 896 — The exact rename pass is pinned by a dedicated interop suite

- **Status:** accepted
- **Date:** 2026-09-25
- **Design:** docs/design/rename-exact-one-shot-delete.md (§6 Part 4, D4) · **Supersedes/Refines:** none

## Context

Only the interop harness proves faithfulness. The exact pass is its own git routine with its
own matrix; the similarity interop suite is already ~2,500 lines.

## Options considered

1. **Unit rows + new `test/integration/rename-exact-interop.test.ts` + a B1 row in
   `blame-interop.test.ts`** — *recommended by the design.*
2. Unit rows + describes in `rename-similarity-interop.test.ts`.
3. Unit rows only.

## Decision

**Option 1 — adopted-as-recommended (no user judgment).**

## Consequences

- The design's §3 matrix lives as executable rows against real git.
