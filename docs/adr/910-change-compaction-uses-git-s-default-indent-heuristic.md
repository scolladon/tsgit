---
subjects:
  - src/domain/diff/line-diff.ts
---
# 910 — Change compaction always applies git's default indent heuristic

- **Status:** accepted
- **Date:** 2026-09-26
- **Design:** docs/design/diff-core-parity-hardening.md (item 2, H4) · **Supersedes/Refines:** refines ADR-909

## Context

git slides change groups with the indent heuristic on by default (`diff.indentHeuristic`).

## Options considered

1. **Always on; config and `--minimal`/algorithm options later** — *recommended by the design.*
2. Honour `diff.indentHeuristic` now.
3. Compaction without the heuristic.

## Decision

**Option 1 — adopted-as-recommended (no user judgment).** Matches git's default output.

## Consequences

- A repository that disables the heuristic in config still gets the default shape.
