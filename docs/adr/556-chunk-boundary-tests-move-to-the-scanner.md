# 556 — Chunk-boundary cases are tested against the scanner, not through a module spy

- **Status:** accepted
- **Date:** 2026-07-30
- **Design:** docs/design/whitespace-drop-fast-path.md · **Supersedes/Refines:** none

## Context

`whitespace-drop-predicate.test.ts` today reaches its chunk-boundary cases —
LF straddling a chunk edge, NUL just inside or outside the detection window, a line split
across pushes — by `vi.spyOn(streamBlobMod, 'streamBlob')` and feeding a synthetic
`chunkedStream`. ADR-551 makes that state machine a synchronous, directly constructible
object, which changes what the natural seam is.

## Options considered

1. **Retarget the module spy to `openBlobSource`** and keep the chunk-boundary cases in
   the predicate's test file — pros: smallest test diff / cons: keeps module-level
   mocking, and keeps the scanner's contract being asserted through two layers.
2. **Delete the module spy** (designer's recommendation) — drive the scanner directly and
   synchronously for every chunk-boundary case, and exercise the predicate's two arms
   against real `createMemoryContext` blobs. Pros: the cases move to the unit whose
   contract they actually are; synchronous assertions are faster and mutation-friendlier
   (no async timing); no module-level mocking / cons: fixtures move file, and "which arm
   ran" must become observable.

## Decision

Adopted-as-recommended (no user judgment): **option 2**.

## Consequences

Arm selection must be observable without timing — asserted through the scanner or source
seam, never by measuring how long a call took. The predicate's own tests shrink to
arm-selection plus the verdict ladder; everything about chunking, caps and NUL windows
becomes a synchronous scanner test in `test/unit/domain/diff/line-digest-scanner.test.ts`.
This is what makes ADR-552's pending-bytes re-proof expressible as a plain test: push one
whole blob of many short lines, assert not binary. Guard clauses keep isolated per-operand
tests (`currentLineBytes >= MAX_LINE_BYTES` and `lineCount >= MAX_LINES` separately), per
the repository's mutation-resistant test conventions.
