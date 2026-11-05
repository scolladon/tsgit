---
subjects:
  - src/application/primitives/derive-context.ts
  - src/application/primitives/object-store.ts
  - src/application/primitives/internal/session-lineage.ts
  - test/integration/repository-lifecycle.ts
phases: [implementation, validation, integrate]
kind: gotcha
trigger: an integration job dies on unhandled FileHandle-closed-by-garbage-collection errors while every test in it passes
evidence:
  - src/application/primitives/internal/session-lineage.ts
  - src/application/primitives/object-store.ts
  - test/unit/application/primitives/object-store.test.ts
  - test/integration/repository-lifecycle.ts
source: { run: rev-parse-corrupt-input, phase: integrate, date: 2026-11-05 }
status: active
supersedes: []
last-verified: 2026-11-05
---
# 030 — A session a derived context mints is disposed with its parent

## Context

The `integration` job moved to Node 26 when it became the `lts/*` line, where a pack
`FileHandle` the garbage collector closes is a fatal `ERR_INVALID_STATE`. The job reported
eight of them with all ten thousand tests green, blamed on whichever file was running when
the collector fired. A preload wrapping `fs.promises.open` plus a vitest setup file that
diffs the live set in `beforeAll`/`afterAll` turned that into a per-file count: 95 handles
in 13 suites that opened packed clones through bare contexts, and after the `trackedContexts`
sweep, 7 handles in 3 suites that were already tracking. Those came from stores the tracked
context never owned: `deriveContext` mints a fresh session whenever a derivation crosses a
repository boundary (a submodule's git dir, a worktree, a clone or bundle target), that
session's store opens its own pack handles, and `disposeObjectStore` on the parent never
reached them.

## Lesson

A derived session is an owner with no owner. Whatever mints it must leave a trail the
parent's disposal can follow, or the handles it opens belong to nobody once the operation
returns.

## How to apply

Attribution by test file is a hint, not a locus: measure open handles per file (preload + setup file) before touching a suite.
A suite that opens packed repositories wraps every `createNodeContext` and `openRepository` in the lifecycle trackers from the first draft.
Residual leaks in a suite that already tracks point at a session the code minted itself: look at `deriveContext` callers, not at the test.
`session-lineage.ts` records each minted session on its parent and `disposeObjectStore` walks it; a new minting path goes through `deriveContext`.
Keep the measuring vitest config out of the worktree root between runs: `npm run check` lints it.

## Evidence

`src/application/primitives/internal/session-lineage.ts` — `adoptSession` and `sessionsMintedBy`, the trail.
`src/application/primitives/object-store.ts` — `disposeObjectStore` disposing the session's store, then every minted session's.
`test/unit/application/primitives/object-store.test.ts` — two derived sessions across a repository boundary, both stores' registries disposed with the parent's.
`test/integration/repository-lifecycle.ts` — the suite-level trackers the sweep applied to thirteen suites.
