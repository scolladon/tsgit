---
subjects:
  - src/application/commands/mv.ts
---
# 1222 — mv refusing a case-only directory rename ships as breaking

- **Status:** accepted
- **Date:** 2026-11-19
- **Design:** docs/design/mv-directory-one-rename.md (D6) · **Supersedes/Refines:** applies ADR-1190

## Context

`mv(['d'], 'D')` on a case-insensitive host returned a result (while emptying the work tree); it
now throws as git refuses (ADR-1219). The new `FileSystem.renameDirectory?` member is optional and
additive.

## Options considered

1. **`fix(mv)!:`** — a returning call that now throws.
2. `fix(mv):` — treat the destroying return as never a contract.
3. `feat(mv)!:` — count the port member as a feature.

## Decision

**adopted-as-recommended (no user judgment)** — DOCTRINE D-3 and ADR-1190: a pinned refusal
mismatch folded into an edited function is marked breaking.

## Consequences

The release bumps the major version. The additive port member rides under the same marking.
