---
subjects:
  - src/domain/storage/error.ts
  - src/domain/error.ts
  - src/application/commands/internal/fsck/stored-corruption.ts
---
# 1024 — DELTA_CHAIN_TOO_DEEP leaves the error union in 6.0.0

- **Status:** accepted
- **Date:** 2026-10-20
- **Design:** docs/design/lift-delta-chain-read-cap.md (DC-6, Part 6) · **Supersedes/Refines:** refines ADR-1019

## Context

Once no reader caps depth (ADR-1019) nothing throws `DELTA_CHAIN_TOO_DEEP`. It is a public
member of the exported error-data union, listed in `reports/api.json`, and in fsck's
`CORRUPTION_CODES`. The change lands in the 6.0.0 cut whose breaking commit (#322) is already on
`main`; a 5.0.1 hotfix carrying only the behavioural fix is an open option, so the removal must
stay separable from the fix.

## Options considered

1. **Remove it in 6.0.0, as the last part** (recommended) — pros: a public variant no code path
   produces tells consumers to handle a case that cannot occur, which the house style treats as
   dead code; free inside a breaking major, a major on its own later / cons: a consumer with an
   exhaustive switch over the union must drop the arm.
2. **Keep it as a never-thrown type** — pros: zero churn, no API change; the only honest answer
   on a hotfix branch / cons: dead code on `main`.
3. **Repurpose it for cycles** — see ADR-1021 option 3.

## Decision

**User-ratified: option 1.** The `deltaChainTooDeep` factory goes with its last caller in the
behavioural fix; the union variant, its message arm, its `CORRUPTION_CODES` entry and its
exhaustiveness pin are removed in a separate, final commit carrying the breaking marker, so the
earlier commits cherry-pick onto a 5.0.x branch where the variant survives as a type only.

## Consequences

`reports/api.json` is regenerated and the user docs drop the variant's row. 6.0.0's release
notes name the removal. On a 5.0.x hotfix the variant is declared and never thrown.
