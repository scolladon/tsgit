---
subjects:
  - src/application/commands/add.ts
---
# 1001 — An exact literal silences the drop beneath a resolved unmerged path

- **Status:** accepted
- **Date:** 2026-10-17
- **Design:** docs/design/add-dir-replaced-by-non-dir.md · **Supersedes/Refines:** refines ADR-990, ADR-994

## Context

An inserted path `P` whose prior entry was unmerged, with stage-0 entries beneath it (`a`@1/2/3 and
`a/b`@0, then `a` becomes a file). Pinned on git 2.55: `add a` and `add a top` drop `a/b` with no
`remove` line; `add a/b a`, `add .` and `add -A` print `remove 'a/b'`. The design reported it on every route.

## Options considered

1. Report the beneath entries iff the pathspec still matches them once the elements naming `P` exactly
   are dropped, on every route (recommended).
2. Fast path only; walk rows stay divergent.
3. The design as written; all these rows diverge.

## Decision

**Adopted-as-recommended (no user judgment)** — option 1, aligned with ADR-226 and with ADR-1000's
"an element naming the path exactly drops out" rule. The rule is inferred from the pinned rows.

## Consequences

- `removed` matches git's `remove` lines on the resolved-path rows of every route.
