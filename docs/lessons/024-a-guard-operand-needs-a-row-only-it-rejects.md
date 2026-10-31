---
subjects:
  - src/domain/refs/loose-ref.ts
  - test/unit/domain/refs/loose-ref.test.ts
phases: [implementation, validation]
kind: trap
trigger: a guard of the form `a || b` whose example table already has a row named for `a`
evidence:
  - src/domain/refs/loose-ref.ts:67
  - test/unit/domain/refs/loose-ref.test.ts:83-84
source: { run: fsck-broken-ref-chain-unreadable, phase: validation, date: 2026-10-31 }
status: active
supersedes: []
last-verified: 2026-10-31
---
# 024 — A guard operand needs a row only it rejects

## Context

`readDirectBody` refuses a body with `hex.length !== hexLength || !HEX_DIGITS.test(hex)`. The table
had a row labelled "39 hex digits", so the length operand looked covered. Stryker's operand mutant
(`hex.length !== hexLength` → `false`) survived all 179 domain tests, and the triager called it a
phantom after applying the whole-condition replacement instead. The row's trailing line feed fell
inside the 40-character slice, so the hex-digit operand rejected it first; the length operand was
never the deciding one. Under the mutant, `abc` threw `INVALID_OBJECT_ID` instead of reading as
unparseable.

## Lesson

A row exercises an operand only when every other operand of the same guard lets it through. A
label naming the operand proves nothing; the row's other characters decide which operand fires.

## How to apply

For each operand of an `a || b` (or `a && b`) guard, write one row that only that operand decides.
Check the row against the other operands by hand: no extra byte may trip them.
For an operand mutant, apply the report's exact replacement, never the whole condition.

## Evidence

- `src/domain/refs/loose-ref.ts:67` — the guard.
- `test/unit/domain/refs/loose-ref.test.ts:83-84` — "39 hex digits" (line feed included, decided by
  the hex-digit operand) and "39 hex digits with no line feed" (decided by the length operand; fails
  under the mutant, passes on the real code).
