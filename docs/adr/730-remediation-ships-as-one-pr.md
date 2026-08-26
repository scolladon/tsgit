---
subjects: []
---
# 730 — Remediation ships as one PR

- **Status:** accepted
- **Date:** 2026-08-26
- **Design:** docs/design/perf-remediation-2026-08.md (DC-16) · **Supersedes/Refines:** none

## Context

Ten parts share oracles (the harness part makes later numbers readable; the concurrency
seam is consumed by two later parts). The maintenance part adds command surface and was
individually large enough to consider splitting out.

## Options considered

1. **All ten parts, one PR, sequential atomic commits** (recommended, chosen).
2. **Two PRs (P0–P4 / P5–P9)** — cons: the second PR re-derives the first's measurement context.
3. **One PR per part** — cons: multiplies mutation/validate/nightly cost by ten.

## Decision

**User-ratified.** All ten parts — including the full-scope `maintenance` command — land
in this PR as sequential atomic commits, decision-gated parts included since every gate
resolved to "do it".

## Consequences

A large review surface, mitigated by per-part commits and per-part gates. The mutation
run spans a new command surface in the same PR.
