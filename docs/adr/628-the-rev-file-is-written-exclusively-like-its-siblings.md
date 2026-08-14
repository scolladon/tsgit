# 628 — The rev file is written exclusively like its siblings

- **Status:** accepted — **adopted-as-recommended (no user judgment)**
- **Date:** 2026-08-13
- **Design:** docs/design/rev-on-idx-write.md (DC-5)

## Context

git renames the reverse index over any existing `pack-<sha>.rev`, even a read-only one
(Pin G1). tsgit's three existing pack artefacts (`.pack`, `.idx`, `.promisor`) all use
`writeExclusive`.

## Decision

The `.rev` uses `writeExclusive` like its siblings. The overwrite divergence is
unreachable today: any repository state carrying a leftover `.rev` for a pack stem also
carries the `.pack`, whose own exclusive create fails first. Consistency wins, and the
port's symlink-safe ancestor containment check comes for free. An EEXIST→overwrite
fallback buys nothing and re-opens the containment question.

## Consequences

If a future change makes the pack write itself overwriting, this decision must be
revisited in the same change — the unreachability argument is the load-bearing premise.
