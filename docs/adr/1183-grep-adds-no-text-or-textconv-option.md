---
subjects:
  - src/application/commands/grep.ts
---
# 1183 — grep adds no `text` or `textconv` option

- **Status:** accepted
- **Date:** 2026-11-12
- **Design:** docs/design/grep-diff-attribute-binary.md · **Supersedes/Refines:** —

## Context

git exposes `-a`/`--text`, `-I` and `--textconv`. git's default (no flag) is what the
attribute change matches, and `textconv` is ignored without `--textconv` (pinned).

## Decision

**adopted-as-recommended (no user judgment)** — ADR-249 and YAGNI: no caller has asked for
them and faithfulness does not need them. `GrepOptions` is unchanged.

## Consequences

### Neutral

- Adding `text` later is additive.
