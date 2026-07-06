# 454 — Unify the pending-operation vocabulary into one shared union

- **Status:** accepted
- **Date:** 2026-07-05
- **Design:** docs/design/magic-literal-sweep.md · **Relates:** ADR-453
- **Decision class:** D-structure (ratified — user judgment)

## Context

The `PendingOperation` vocabulary (`'merge' | 'rebase' | 'cherry-pick' | 'revert'`) is
declared as a union in two places in `primitives/internal/repo-state.ts` and echoed as
CLI-flavored operation strings (`'revert --continue'`, `'cherry-pick --continue'`, …) in
refusal-message arguments across `commit.ts`, `cherry-pick.ts`, and `revert.ts`. The type
and its member strings are duplicated across the command surface.

## Options considered

1. **Single shared union + value table** in `domain/sequencer/operation-labels.ts`,
   imported by `repo-state`, `commit`, `cherry-pick`, `revert` — one source of truth for
   both the type and the label strings.
2. **Extract only the string literals**, leaving each `PendingOperation` type declaration
   where it is (the type duplication stays, documented as a follow-up).

## Decision

Option **1** — user judgment: unify. A single exported `PENDING_OPERATIONS` frozen tuple
derives the `PendingOperation` type (`typeof PENDING_OPERATIONS[number]`); the CLI-flavored
refusal strings become named constants in the same module. All consumers import them.

## Consequences

- Removes the duplicated union; one canonical definition of the operation vocabulary.
- Touches a domain type crossing several commands — a wider diff than a pure literal
  extraction, accepted for the single-source-of-truth win.
- Values are unchanged, so faithfulness holds (ADR-226); the refusal-condition parity tests
  remain the guard.
