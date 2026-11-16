---
subjects:
  - src/domain/working-tree-path.ts
phases: [implementation, validation]
kind: gotcha
trigger: a change deletes one check from a function whose other checks carry equivalent-mutant marks
evidence:
  - src/domain/working-tree-path.ts
  - test/unit/domain/working-tree-path.test.ts
source: { run: long-pathspec-refusals, phase: validation, date: 2026-11-16 }
status: active
supersedes: []
last-verified: 2026-11-16
---
# 041 — Deleting a check from a guard function re-reads its equivalence marks

## Context

`rejectInputShape` held four fast-path checks: empty input, leading `/`, NUL, and the 4096-byte
cap. Three carried `equivalent` marks: the per-component scan rejects the same inputs with the
same error data. The cap was the only check nothing else covered. Deleting it left a function of
three proven-redundant guards. Mutation testing surfaced it as two survivors, one per call site,
removing the whole call.

## Lesson

An equivalence mark is a claim that something else already covers the check. When a sibling
check is deleted, a function whose remaining checks are all marked equivalent has become dead
code, and its call sites survive mutation.

## How to apply

When a change deletes a check, read the equivalence marks on the checks left beside it.
If every remaining check is marked equivalent, delete the function and its marks in the same change.
Confirm with the module's suites that refusals and error data are unchanged.

## Evidence

`src/domain/working-tree-path.ts`: the validators now reject only through the component scan,
`rejectLeadingColon` and `rejectBackslash`. The empty, absolute and NUL rows in
`test/unit/domain/working-tree-path.test.ts` still refuse with `PATHSPEC_OUTSIDE_REPO` and the input as `path`.
