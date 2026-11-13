---
subjects:
  - src/application/commands/sparse-checkout.ts
---
# 1189 — a non-cone pattern file ends each pattern with a newline

- **Status:** accepted
- **Date:** 2026-11-13
- **Design:** docs/design/sparse-checkout-worktree-config.md · **Supersedes/Refines:** none

## Context

git's non-cone `set` writes `/a/\n`; tsgit writes the patterns without the final newline
(rows S1, S4). The probe that pinned the writers exposed it, in the same function and verb.

## Options considered

1. **Fold** — each non-cone pattern ends with `\n` (recommended).
2. **Report it as an impact only.**

## Decision

**adopted-as-recommended (no user judgment)** — no trade-off: a proven defect the change's
own probes exposed in the function it edits is fixed in the change.

## Consequences

### Positive

- `info/sparse-checkout` is byte-identical to git's after a non-cone `set`.
