---
subjects:
  - src/application/commands/maintenance.ts
  - src/application/commands/internal/gc-pipeline.ts
  - src/application/primitives/internal/gc-config-guard.ts
  - docs/use/commands/maintenance.md
  - docs/use/commands/gc.md
---
# 1111 — a malformed lazily-read gc key fails the gc task and the run continues

- **Status:** accepted
- **Date:** 2026-10-29
- **Design:** docs/design/fsck-pack-entry-crc-git-256.md (F5, D-F5a) · **Supersedes/Refines:** refines ADR-226

## Context

git 2.56 moved the files-backend optimisation into `odb/source-files.c` (57ca517, cc78c50,
0a77889), and `gc.auto`, `gc.autoPackLimit` and `gc.bigPackThreshold` are now read when the gc
step needs them, not when the command starts. Pinned on 2.56.0 against 2.55.0: with any of the
three malformed, `maintenance run --task=commit-graph` exits 0 (was 128);
`maintenance run --task=gc` prints the fatal line, then `error: task 'gc' failed`, exits 1, and a
commit-graph task in the same run still writes its chain in either order; an explicit `gc` and
`gc --auto` keep 128, except `gc.bigPackThreshold` under `--auto`, which declines on a tiny repo
and exits 0. `gc.cruftPacks`, `gc.pruneExpire`, `gc.worktreePruneExpire` and `gc.logExpiry` are
still read eagerly and refuse at 128 everywhere. tsgit validates all seven keys up front.

## Options considered

1. **Record the refusal in `tasksFailed` as `{ task: 'gc', error }` and continue** — pros:
   matches git's exit 1 and its surviving commit-graph task; `tasksFailed` already exists for a
   failed task / cons: a config error surfaces as a task result, not a throw.
2. **Throw from the gc step and abort the remaining tasks** — pros: loud / cons: diverges from
   git, which runs the later tasks.

## Decision

**Adopted-as-recommended (no user judgment): option 1.** `gc.auto` and `gc.autoPackLimit` are
validated at the gc step's start, before the auto gate under `auto` and before the pack step
otherwise; `gc.bigPackThreshold` is validated at the pack step only, so a declining auto gate never
reads it. Inside a non-auto `maintenance` run a refusal on one of the three becomes a `tasksFailed`
entry carrying the error data and the loop continues. Under `auto` the gate's refusal is thrown.
An explicit `gc` refuses all three. The other four keys stay eager.

## Consequences

- `maintenance({ tasks: ['commit-graph'] })` no longer reads the three lazy keys at all.
- The maintenance interop table gains a `--task=gc` run per key, pinned at git's exit 1 and
  `task 'gc' failed`.
