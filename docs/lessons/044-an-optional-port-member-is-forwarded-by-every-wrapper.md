---
subjects:
  - src/repository/wrap-fs-validator.ts
  - src/application/primitives/internal/empty-directories.ts
phases: [design, implementation, review]
kind: gotcha
trigger: a primitive branches on an optional port member (`ctx.fs.rmdir ?? ctx.fs.rm`) or a design adds one to a port
evidence:
  - src/repository/wrap-fs-validator.ts
  - test/unit/repository/repository.test.ts
source: { run: gitlink-rmdir-keeps-occupant, phase: design, date: 2026-11-18 }
status: active
supersedes: []
last-verified: 2026-11-18
---
# 044 — An optional port member is forwarded by every wrapper

## Context

The backlog entry blamed the one-way materialize for deleting a file at a removed gitlink's
path. The removal code already followed git (`rmdir` only). `wrapFsValidator`, which every
`openRepository` context goes through, forwarded each `FileSystem` member except the optional
`rmdir`, so production fell back to `rm` and deleted the file. The unit suites ran on a bare
memory adapter, which has `rmdir`, so none of them saw it.

## Lesson

An optional port member is only reachable in production when every wrapper between the adapter
and the primitive forwards it. A suite over a bare adapter proves the primitive, not the path.

## How to apply

When a primitive branches on an optional port member, list every wrapper on the
`openRepository` path and check that each forwards it.
Pin one facade-level row (through `openRepository` or the wrapped context) that observes the
member being called with its target path.
When a port gains an optional member, extend the wrappers in the same change.

## Evidence

`guardedRmdir` in `src/repository/wrap-fs-validator.ts` forwards `rmdir` behind the write
guard. `test/unit/repository/repository.test.ts` asserts the adapter's `rmdir` is called with
`/repo/new` through the facade and that the worktree-scoped context exposes it.
