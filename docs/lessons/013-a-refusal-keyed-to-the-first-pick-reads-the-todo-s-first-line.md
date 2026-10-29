---
subjects:
  - src/application/commands/rebase.ts
phases: [implementation, validation]
kind: gotcha
trigger: a sequencer check runs "before the first pick" and the code searches the todo for that pick
evidence:
  - src/application/commands/rebase.ts
  - test/unit/application/commands/rebase.test.ts
  - test/integration/gitlink-consumers-interop.test.ts
source: { run: status-gitlink-parity, phase: validation, date: 2026-10-25 }
status: active
supersedes: []
last-verified: 2026-10-29
---
# 013 — A refusal keyed to the first pick reads the todo's first line

## Context

The rebase pre-flight lets a staged gitlink change through under `ignore = all`, and git's
first pick then refuses a dirty index and reschedules itself. The port searched the todo for
its first `pick` line and ran the refusal there. A mutation survivor on that search
(`action === 'pick'` forced true) sent the triager to pin git 2.55 with `--rebase-merges`: that
todo opens with `label onto` and `reset onto`, the reset moves the index to `onto`'s tree and
no pick ever meets the staged change. git does not refuse; the port did. A second survivor on
the same path showed git's `done` file listing the retried pick twice after `--continue`, where
the port listed it once.

## Lesson

git's sequencer checks the index before executing the first *line*, whatever its action. A
refusal written as "before the first pick" is a different rule as soon as the todo can open
with a `label` or a `reset`. The files git writes while a pick is rescheduled are appended,
never rewritten: a retried pick lands in `done` a second time.

## How to apply

Key the check to `todo[0]` and return when it is not a pick; never scan for the first pick.
Pin the `--rebase-merges` shape of every pre-flight refusal, populated and unpopulated
submodule alike, before trusting a mutation survivor's hint.
Treat `done`, `end` and `msgnum` as append-only logs when porting a retry: read what git
leaves on disk after `--continue`, not what a tidy model predicts.

## Evidence

`src/application/commands/rebase.ts` — `refuseDirtyIndexBeforeFirstPick`, `continueRescheduled`.
`test/unit/application/commands/rebase.test.ts` — the rows under `rebase over a rescheduled pick with two picks`.
`test/integration/gitlink-consumers-interop.test.ts` — the three rows titled `… rebase recreating merges onto a branch adding a file`.
