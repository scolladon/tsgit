---
subjects:
  - src/application/commands/internal/gitlink-head.ts
  - src/application/primitives/walk-working-tree.ts
phases: [design, implementation, review]
kind: gotcha
trigger: code reads a file inside a nested or embedded repository (`.git`, HEAD, commondir) found in the working tree
evidence:
  - src/application/commands/internal/gitlink-head.ts
  - test/integration/add-embedded-repository-interop.test.ts
  - test/unit/application/commands/internal/gitlink-head.test.ts
source: { run: pathspec-glob-dialect, phase: review, date: 2026-10-23 }
status: active
supersedes: []
last-verified: 2026-10-23
---
# 008 — A probe of nested-repository files reads only what git reads

## Context

Staging embedded repositories made the working-tree walk probe every directory holding a `.git`,
so `status` and `add` started reading files the user's tree controls. Three review cycles each
found another unbounded read: a FIFO `.git` hung both commands, a 700 MB gitfile or a `.git`
link to `/dev/zero` exhausted memory, then a padded `commondir` and HEAD threw raw
`RangeError`s, and the first bound chosen for HEAD resolution cut long branch names.

## Lesson

Each nested file has git's own read rule, and matching it is both the safety fix and the
faithfulness fix: `.git` is read only when its followed stat is a regular file of at most
1 MiB; HEAD is judged from 255 bytes; `commondir` is a C string cut at its first NUL.
A bound git does not have is a divergence, not a safety margin.

## How to apply

Before reading any file under a nested `.git`, look up how git reads it (setup.c, refs) and copy the stat check and size bound.
Stat before reading; never `readUtf8` a path whose type you have not checked.
Pin each bound with a twin row against git at the bound and one byte past it, using sparse files.
Give each interop row that touches a special file a timeout, so a hang fails instead of stalling the suite.

## Evidence

`src/application/commands/internal/gitlink-head.ts` — `gitfileOfSize`, `MAX_GITFILE_SIZE`, the bounded HEAD and commondir reads.
`test/integration/add-embedded-repository-interop.test.ts` — the FIFO, device, oversized and padded-file rows.
`test/unit/application/commands/internal/gitlink-head.test.ts` — the bound and bound-plus-one rows.
