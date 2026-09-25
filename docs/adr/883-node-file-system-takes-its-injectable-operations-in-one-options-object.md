---
subjects:
  - src/adapters/node/fs-operations.ts
  - src/adapters/node/node-file-system.ts
supersedes:
  - adr: "047"
    scope: "the positional constructor signature — fsOps as the optional third parameter after rootDir and pathPolicy"
---
# 883 — `NodeFileSystem` takes its injectable operations in one options object

- **Status:** accepted
- **Date:** 2026-09-22
- **Design:** docs/design/node-io-cold-read-pipeline.md (D2, DC-3) · **Supersedes/Refines:** supersedes ADR-047 for the constructor signature only; the injection itself stands

## Context

ADR-047 made the `node:fs/promises` surface a constructor argument, `FsOperations`, taken as the
optional third positional parameter of `NodeFileSystem` after `rootDir` and `pathPolicy`. Two
more trailing positionals followed (`rootsArePreResolved`, `removeTreeConcurrency`). ADR-879 adds
a second injectable surface, the sync twin of that module, and a per-repository policy that
carries it with its budget. A sixth positional parameter would keep the 214 existing
`new NodeFileSystem(` sites (mostly tests) untouched; an options object changes all of them.

## Options considered

1. **Separate `SyncFsOperations` type, optional sixth positional parameter** — pros: no
   call-site churn; every existing double keeps working / cons: six positionals, three of them
   booleans and numbers, at a boundary that will keep growing. *Recommended by the design.*
2. **Fold the trailing positionals into one options object** — pros: a named, extensible
   boundary; the sync surface lands as one more member; no positional-order trap / cons: touches
   every construction site once, for no behaviour change.
3. **Optional sync members on `FsOperations` itself** — pros: one type / cons: mixes two
   modules in one `Pick` and makes "is sync available" a per-method question.

## Decision

**Option 2 — the user's judgment (deviates from the design's recommendation).** The constructor
becomes `new NodeFileSystem(rootDir, options?)` with

```ts
interface NodeFileSystemOptions {
  readonly pathPolicy?: PathPolicy;            // default nativePolicy
  readonly fsOps?: FsOperations;               // default realFsOps
  readonly syncIo?: SyncIoPolicy;              // absent → every method runs the async path
  readonly rootsArePreResolved?: boolean;      // default false
  readonly removeTreeConcurrency?: number;     // default REMOVE_TREE_CONCURRENCY
}
```

`SyncFsOperations` is its own type in `fs-operations.ts`, a `Pick` of `node:fs` over
`statSync`, `lstatSync`, `readlinkSync`, `openSync`, `fstatSync`, `readSync` and `closeSync`
plus `realpathSync.native`, with `realSyncFsOps = fs` as the production value; it is carried
inside `SyncIoPolicy` next to the budget and the read gate. The migration of every construction
site is one mechanical part landed before any sync arm.

Superseded from ADR-047: the positional signature (`fsOps` as the optional third parameter,
followed by `rootsArePreResolved` and `removeTreeConcurrency`).

Carried forward from ADR-047: the `FsOperations` type as a `Pick<typeof fsPromises>`, the
`realFsOps` default, the reason for injection over `vi.mock`, and the internal helpers that take
an `fsOps` argument so they stay unit-testable in isolation.

## Consequences

- 214 construction sites change in one commit; a bare `new NodeFileSystem(root)` stays valid.
- Every future injectable capability is an options member with a documented default; the
  positional convention is closed.
- Test doubles that pass only `fsOps` keep the async path; a fake `SyncFsOperations` is built the
  same way as the existing fake `FsOperations`.
