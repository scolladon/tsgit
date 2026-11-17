---
subjects:
  - src/application/primitives/materialize-tree.ts
  - test/integration/checkout-file-directory-swap-interop.test.ts
phases: [design, implementation]
kind: gotcha
trigger: a git probe or interop twin pins a behaviour that touches path collisions, case or file/directory swaps on macOS
evidence:
  - src/application/primitives/materialize-tree.ts
  - test/integration/checkout-file-directory-swap-interop.test.ts
source: { run: checkout-branch-on-unborn-head, phase: decisions, date: 2026-11-17 }
status: active
supersedes: []
last-verified: 2026-11-17
---
# 042 — A probe on macOS sets core.ignorecase explicitly

## Context

The first design pinned "a staged file `dir` in the way of a target `dir/x` is replaced" from
probes run on macOS. `git init` there writes `core.ignorecase = true`; on Linux it writes
nothing, so the setting is false. git's `icase_exists` lets a stat-clean file go only when the
setting is true. Under false, git refuses with the file listed as untracked. The design rule
was wrong for every Linux user, and a revised design and two ADRs (1202, 1203) followed.

## Lesson

A local probe inherits the platform's `git init` defaults. A pinned row that depends on one of
those settings has a value on Linux the probe never saw.

## How to apply

Set `core.ignorecase` explicitly in every probe and in both interop twins whenever the
behaviour touches path collisions, case or file/directory swaps.
Pin each such row under both values; write the requirement per value.

## Evidence

`test/integration/checkout-file-directory-swap-interop.test.ts` runs every sparse row under
`describe.each(['false', 'true'])`. `buildSparseTwin` sets `core.ignorecase` in both repos.
`clearedObstructions` in `src/application/primitives/materialize-tree.ts` reads the setting
before it lets a file go.
