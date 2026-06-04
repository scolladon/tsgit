# Plan — snapshot surface (de-leak wiring internals)

Per ADR-260 (accessors deferred), this PR ships **deliverable 1 only**: drop the
nine snapshot wiring re-exports from the `src/index.ts` barrel and demote the
four `*Deps` interfaces to module-local. One atomic slice — the barrel
re-export of a `*Deps` type and that type's `export` keyword are coupled (you
cannot re-export a non-exported symbol), so the de-leak and the demotion land
together.

## Pre-flight (facts pinned during design)

- `src/index.ts` is the only barrel re-exporting the wiring symbols; the runtime
  shims and `application/primitives/index.ts` never did.
- The `create*` factories are consumed by `repository.ts` + unit tests **by
  direct module path** → stay exported from their modules.
- The four `*Deps` types have no external referent (only their own module + the
  barrel) → safe to demote.
- `src/index.ts` is not a typedoc entry point → `reports/api.json` unchanged.

## Slice 1 — drop the barrel re-exports + demote `*Deps`

### Red

Create `test/unit/api-surface/snapshot-barrel-surface.test.ts`:

- `Given the public package barrel` › `When inspecting its snapshot exports` ›
  `Then the wiring factories are absent`:
  - `import * as barrel from '../../../src/index.js'`, widen via
    `const sut = barrel as Record<string, unknown>` (index-signature probe, so a
    now-absent name is not a compile error — no ignore directive).
  - Assert each of `createIndexSnapshot`, `createTreeSnapshot`,
    `createWorkdirSnapshot`, `createStashSnapshot`, `createSnapshotFactory` is
    `undefined`. **Fails RED** — they are still exported today.
- `Given the public package barrel` › `When inspecting its snapshot helpers` ›
  `Then the composition helpers remain callable` (regression guard, green both
  sides):
  - Assert `barrel.join`, `barrel.innerJoin`, `barrel.requireSnapshot` are
    `typeof 'function'`.
- `Given the public package barrel` › `When naming its snapshot types` ›
  `Then the public type vocabulary still resolves` (compile-time witness):
  - A typed `satisfies`/`undefined as unknown as T` block importing
    `SnapshotFactory`, `StashSnapshot`, `WorkdirSnapshotOptions`, `TreeSnapshot`,
    `IndexSnapshot`, `WorkdirSnapshot`, `Snapshot`, `SnapshotEntry`,
    `SnapshotOptions`, `TreeEntry`, `IndexEntry`, `WorkdirEntry` from
    `../../../src/index.js`; assert a concrete witness (e.g. a `SnapshotKind`
    string) to keep one runtime expectation per `it`.

Run: `npx vitest run test/unit/api-surface/snapshot-barrel-surface.test.ts` →
the "wiring factories are absent" expectations fail; helpers/types pass.

### Green

1. `src/index.ts` — replace the nine wiring re-exports with type-only
   re-exports for the three modules that still owe a public type:
   - Remove `createIndexSnapshot` + `IndexSnapshotDeps` re-export
     (`index-snapshot.js`) entirely — nothing public left there beyond the
     separately-exported `IndexEntry`.
   - Remove `createTreeSnapshot` + `TreeSnapshotDeps` re-export
     (`tree-snapshot.js`) entirely.
   - `createWorkdirSnapshot` + `WorkdirSnapshotDeps` → keep only
     `export type { WorkdirSnapshotOptions }`.
   - `createSnapshotFactory` + `SnapshotFactoryDeps` → keep only
     `export type { SnapshotFactory }`.
   - `createStashSnapshot` → keep only `export type { StashSnapshot }`.
   - Leave `IndexEntry`, `TreeEntry`, `WorkdirEntry`, the `snapshot.js` type
     bundle, `join`/`innerJoin`/`JoinOptions`, and `requireSnapshot` untouched.
2. Demote the four `*Deps` interfaces (`export interface X` → `interface X`):
   - `application/primitives/snapshot/index-snapshot.ts` → `IndexSnapshotDeps`
   - `application/primitives/snapshot/tree-snapshot.ts` → `TreeSnapshotDeps`
   - `application/primitives/snapshot/workdir-snapshot.ts` → `WorkdirSnapshotDeps`
   - `application/primitives/snapshot/snapshot-factory.ts` → `SnapshotFactoryDeps`

Re-run the test file → green.

### Refactor

None expected (barrel + four one-keyword demotions). Confirm the barrel's
import-grouping/sort still satisfies Biome (the file is alphabetised by source
path).

### Validate + commit

- `npm run validate` (if `check:size` flags, `rm -rf dist .wireit` then rebuild
  before trusting it — known stale-chunk inflation).
- Commit: `refactor(snapshot)!: drop wiring internals from the public barrel`
  (the `!` marks the breaking barrel-surface removal for release-please; no body,
  no phase refs).

## Step-9 docs touchpoints (handled in the workflow docs phase, not here)

- Flip `docs/BACKLOG.md` **23.4a** `[ ]` → `[x]` with a one-line outcome.
- Add a deferred-accessors follow-up sub-item under 23.4 (the `repo.tree(rev)` /
  `repo.index` / `repo.workdir` / `repo.stash` weigh, gated on 23.4j) so the
  ADR-260 deferral is tracked, not dropped.
- Sweep `README` / `docs/use` / `docs/understand` for any reference to the
  removed barrel exports (none expected — they were never documented).
```
