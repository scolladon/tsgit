# ADR-461: `name-rev` date cutoff as pure domain helpers

## Status

Accepted (2026-07-09)

## Context

`nameRev` floods the entire ancestry of every qualifying ref. Canonical git
(`builtin/name-rev.c`, v2.55.0) prunes each flood at
`cutoff = min(targetDate) − CUTOFF_DATE_SLOP` via `commit_is_before_cutoff`,
consulted at the seed tip and at each parent. The pruning is observationally
inert (a pruned commit can never be the target nor improve its name), so this
is pure perf; output stays pinned byte-for-byte by `name-rev-interop`
(ADR-226). The cutoff predicate and arithmetic are pure functions of
timestamps — the question is where they live.
Full transcription in `design/name-rev-date-cutoff.md`.

## Decision

The cutoff predicate `commitIsBeforeCutoff(commitDate, cutoff)` (strict `<`)
and the cutoff computation `nameRevCutoff(targetDate)` (slop subtraction with
underflow guard) live in a new pure module `domain/name-rev/cutoff.ts`,
exported from the internal `domain/name-rev/` barrel only — not from the
public API. The command-layer walk (`name-rev.ts`) calls them at git's two
guard sites (seed tip in `seedRef`, parent in `expandParents`).

## Consequences

- Mirrors the established `is-better-name` / `step` / `ref-pattern` split:
  pure decisions in `domain/name-rev/`, I/O orchestration in the command.
- The faithfulness-load-bearing constants (`86400`, strict `<`, the guard
  structure) sit in a 100%-mutation-testable pure unit with example +
  property tests, isolated from walk I/O.
- No public API change, no `api.json` churn.

## Alternatives considered

- **Inline in `name-rev.ts`** — fewer files, but buries the load-bearing
  boundary logic inside I/O-mixed walk code and diverges from the
  domain/command split established for this exact feature.
- **In `peelRefToCommit`** — wrong layer: peeling is unrelated to the naming
  cutoff and is shared with `describe`, whose termination story (ADR-460)
  is different.
