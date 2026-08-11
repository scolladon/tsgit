# 608 — Per-position body mismatches are individual findings

- **Status:** accepted (adopted-as-recommended)
- **Date:** 2026-08-09
- **Design:** docs/design/rev-index-bitmap-read-support.md (DC-6, Pin H N1) · **Refines:** ADR-249, ADR-584, ADR-601

## Context

git's `.rev` body check is exhaustive and per-position: it rebuilds the reverse index from
the `.idx` and reports **every** mismatching position with both the expected and the
stored integer, then one summary line, setting exit bit 64 once (design Pin H row N1).
The question is whether tsgit reproduces that cardinality or collapses it.

## Options considered

1. **One finding per mismatched position** (designer's recommendation) — preserves the only
   diagnostic content the check produces / the finding array can be O(objectCount) on a
   maximally corrupt `.rev`.
2. **One finding per pack, carrying a count** — bounded / discards the integers on a check
   whose whole purpose is diagnosis.
3. **One finding per pack, no detail** — smallest surface / discards everything.

## Decision

Option 1. Each mismatching position yields its own finding carrying the pack name, the
position, the expected value and the stored value. Per ADR-249 those integers are **data**,
not presentation — the same call ADR-584 made for the pack name and ADR-601 made for the
midx entry oid. The exit bit is set once regardless of finding count, matching git's plain
OR composition.

The O(objectCount) worst case is accepted: it is bounded by the pack, it matches git's own
output volume, and the array is built by loop-drain rather than argument spread — a
`push(...spread)` over a repo-sized array overflows the call stack near 125k elements.

## Consequences

A maximally corrupt `.rev` produces a large findings array; consumers that render findings
should expect that. Interop assertions pin the finding **cardinality** and message shape,
never the literal integer pair — the expected value is fixture-dependent and rebuilding the
fixture changes it.
