---
subjects:
  - test/integration/posix-only/node-fs-write-rename-refusals.test.ts
---
# 821 — The posix-only root-rename row accepts both codes POSIX allows

- **Status:** accepted
- **Date:** 2026-09-06
- **Design:** docs/design/memory-write-exclusive-directory.md (DC-M) · **Supersedes/Refines:** refines ADR-819

## Context

Renaming a regular file onto its own containment root fails with `EISDIR` on darwin and with
`ENOTEMPTY` on linux: POSIX does not order the two checks, and the linux kernel tests emptiness
first. The posix-only suite pins the darwin answer, `PERMISSION_DENIED`, strictly, and the
`posix-integration` job runs on ubuntu as well as macos. The row has never run on ubuntu because
the unit job it depends on was red, so it is latently red there. A file onto a sibling non-empty
directory is `PERMISSION_DENIED` on both platforms; only the ancestor arrangement splits.

## Options considered

1. **An enumerated pair** — accept `PERMISSION_DENIED` or `DIRECTORY_NOT_EMPTY`, assert
   non-destructiveness, and say in a comment which axis splits (designer's recommendation) —
   pros: the contract suite's own precedent for `mkdir` over a file / cons: the row asserts less
   than either platform alone would allow.
2. **A per-platform expectation branching on `process.platform`** — pros: strict on each platform /
   cons: a conditional oracle inside a test, and a new arm for every future POSIX platform.
3. **Swap the arrangement for the sibling non-empty directory** — pros: both platforms agree /
   cons: loses the root arrangement the change exists to pin.

## Decision

**Adopted-as-recommended (no user judgment): option 1.** The row accepts either code, keeps its
non-destructiveness assertion, and names the darwin-versus-linux ordering in a comment. The memory
adapter keeps `PERMISSION_DENIED` for the same arrangement: it matches darwin and Windows, and its
own rule that a non-directory source refuses any directory destination with that code.

## Consequences

ADR-819's strict posix-only file tolerates one row where two POSIX kernels legally disagree, in the
same way the contract suite tolerates `mkdir` over a file. Nothing cross-adapter depends on the
code, because the contract row for this family asserts the error instance and non-destructiveness
only.
