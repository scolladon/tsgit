# 552 — Every equivalent-mutant proof is re-proved against the new structure

- **Status:** accepted
- **Date:** 2026-07-30
- **Design:** docs/design/whitespace-drop-fast-path.md · **Supersedes/Refines:** none

## Context

The predicate carries five hand-written proofs that specific mutants are equivalent —
three unannotated NOTEs whose opposite-direction siblings are real killed mutants (so a
`Stryker disable` matching by `(mutator, line)` would suppress the real one too), and two
live `Stryker disable next-line` directives. ADR-551 moves every function those proofs
describe into a new file and a new driver. This repository has already been bitten once
by a proof silently falsified by a structure change: a sorted-array-to-heap migration
invalidated a "new-vs-existing" argument that no longer described the new structure's
distinguishing path.

## Options considered

1. **Move verbatim, re-prove each against the synchronous driver, update the note text
   where the premise cites a moved symbol** (designer's recommendation) — pros: the
   proofs stay true statements about the code that exists / cons: five hand
   re-derivations.
2. **Delete the constructs that needed them** so the mutants die naturally — pros:
   cleanest where it applies / cons: `concatBytes`'s empty-`a` shortcut is a real
   allocation saving on the hot buffered arm (`concatBytes(EMPTY, wholeBlob)` would copy
   the whole blob on every buffered read), and three of the five have no construct to
   delete.
3. **Carry the notes forward unchanged** — forbidden by this repository's own history.

## Decision

Adopted-as-recommended (no user judgment): **option 1**, with per-proof dispositions
fixed by the design: the `concatBytes` empty-guard and the `scanForNul` window guard hold
verbatim; the `trackLineCaps` reset guard holds but its note must cite the scanner's
`exhausted` branch rather than `nextLine`'s; the exhausted-branch `terminated: false`
directive holds verbatim; and the pending-bytes cap directive holds but is **the one
re-verified by hand** against a single whole-blob push.

## Consequences

The pending-bytes re-proof is not merely a comment edit: it must appear as an executable
test asserting that many short lines delivered in one whole-blob push do *not* trip
`MAX_LINE_BYTES`. Each surviving `Stryker disable` keeps its `(mutator, line)` anchoring
on the **expression** line — a multi-line proof comment or a multi-line arrow declaration
head between the directive and the expression silently unbinds it, producing a survivor
rather than an ignore. Equivalents that share a line with a killed sibling remain
unsuppressible and are documented in the run record and PR body instead.
