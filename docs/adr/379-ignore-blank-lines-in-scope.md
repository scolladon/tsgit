# ADR-379: `--ignore-blank-lines` ships in 24.14 as a hunk-emission filter

## Status

Accepted

- **Date:** 2026-06-20
- **Design:** [design/whitespace-diff-options.md](../design/whitespace-diff-options.md)
- **Refines:** [ADR-378](378-whitespace-options-flat-enum.md)

## Context

`--ignore-blank-lines` (`XDF_IGNORE_BLANK_LINES`) is the fifth member of the family, but
it is mechanically distinct from the four line-key modes: it does not normalize a line's
equality key — it suppresses changes whose added/deleted lines are entirely blank, at
hunk emission. Pinned against real git: "blank" is defined relative to the *other* active
modes — a spaces-only line is NOT blank under `--ignore-blank-lines` alone (counted) but
IS blank under `--ignore-blank-lines -w` (dropped). The choice is whether to ship it now
or defer it.

## Options considered

1. **(chosen) In scope now**, hooked at hunk emission — pros: ships git's whitespace family complete; the backlog item reads as the whole family / cons: a second mechanism (emission filter) plus its own pinned blank-definition edge matrix.
2. **Defer to a follow-up** (designer's recommendation) — pros: smaller blast radius, four cohesive line-key modes only / cons: leaves the family half-shipped, requires a second PR re-entering the same files.
3. **In scope via a naive line-comparator hook** (treat blank lines as always-equal) — Rejected: provably wrong — git's blank suppression is per-change-group at emission, not per-line equality (a real change adjacent to a blank insertion still emits).

## Decision

All five modes ship in 24.14. `--ignore-blank-lines` is implemented as a
**hunk-emission filter**, not a line-equality-key transform: after `diffLines` produces
hunks (under any other active line-key normalization), a change group consisting solely
of blank lines is suppressed. "Blank" means empty *after* the other active normalization
is applied — so a spaces-only line is blank only when `ignoreWhitespace` also strips it.
The filter feeds the file-drop predicate (ADR-380), patch emission, and stat counts
identically.

## Consequences

- Two hook points exist: line-key normalization (ADR-378 trio + CR) inside the Myers
  comparison, and blank-line suppression at emission. They compose: blank-definition
  reads the active line-key mode.
- The file-drop predicate (ADR-380) computes "zero changed hunks" *after* blank-line
  suppression, so a pure blank-line edit drops the file under `--ignore-blank-lines`.
- The pinned matrix gains the blank-line rows (`BL1`, `BL2`, `BL-spaces`, `BL-combo`);
  `--ignore-blank-lines` leaves the §8 out-of-scope list.
