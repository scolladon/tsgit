# Design — snapshot surface (de-leak wiring internals; weigh source accessors)

## Goal

An ergonomics + encapsulation pass on the lazy-snapshot read surface
(`repo.snapshot.*`), surfaced by the 23.4 API review (finding **S7**). Two
deliverables, one mandatory and one to weigh:

1. **Stop exporting the `*Deps` / `create*Snapshot` wiring internals from the
   `src/index.ts` barrel.** Consumers read snapshots through `repo.snapshot.*`;
   they never hand-wire a resolver stack, so the factory functions and their
   dependency-injection shapes have no business on the public surface.
2. **Weigh first-class source accessors** (`repo.tree(rev)` / `repo.index` /
   `repo.workdir` / `repo.stash`) for ergonomics — a *"consider"*, gated on the
   over-design caution that governs all of 23.4.

The snapshot **name stays** — it is the precise term (git's model is "snapshots,
not deltas"; the iteration-stability invariant *is* database snapshot
isolation), and it lives on a power-tool surface, not the everyday porcelain.
No rename; only the leaked exports go.

This is a **behaviour-preserving encapsulation change** for deliverable 1: no
SHA, ref, reflog, on-disk state, refusal, or output changes — the snapshot
factory and every resolver keep their exact runtime behaviour. The only
observable delta is that the legacy `src/index.ts` barrel stops re-exporting a
set of internal symbols. Deliverable 2's disposition is an ADR decision (below).

## Current surface (what leaks today)

`src/index.ts` is a rollup entry (`package.json` `main`/`module`/`types`). It
re-exports, from `application/primitives/snapshot/*`, the following **wiring
internals**:

| symbol | kind | defining module | why it leaks |
|--------|------|-----------------|--------------|
| `createIndexSnapshot`  | value | `index-snapshot.ts`   | factory — internal to the resolver stack |
| `IndexSnapshotDeps`    | type  | `index-snapshot.ts`   | DI shape for the above |
| `createTreeSnapshot`   | value | `tree-snapshot.ts`    | factory |
| `TreeSnapshotDeps`     | type  | `tree-snapshot.ts`    | DI shape |
| `createWorkdirSnapshot`| value | `workdir-snapshot.ts` | factory |
| `WorkdirSnapshotDeps`  | type  | `workdir-snapshot.ts` | DI shape |
| `createStashSnapshot`  | value | `stash-snapshot.ts`   | factory |
| `createSnapshotFactory`| value | `snapshot-factory.ts` | the top-level wiring factory |
| `SnapshotFactoryDeps`  | type  | `snapshot-factory.ts` | DI shape for the wiring factory |

None of these are reachable through the modern entry points — the runtime shims
(`index.node.ts` / `index.browser.ts` / `index.default.ts`) never re-exported
them, and they are **not** typedoc entry points, so they were never in
`reports/api.json`. They leak only through the legacy `src/index.ts` barrel.

### Who actually consumes them (verified)

- `createSnapshotFactory` — `repository.ts` (`buildSnapshotFactory`) + the unit
  test `snapshot-factory.test.ts`, both via the **direct module path**, not the
  barrel.
- `createIndexSnapshot` / `createTreeSnapshot` / `createWorkdirSnapshot` /
  `createStashSnapshot` — `snapshot-factory.ts` (internal composition) + their
  own unit/mutation tests, all via direct module path.
- The four `*Deps` types — referenced **only** inside their own defining module
  (as the factory's parameter type) and re-exported **only** by `src/index.ts`.
  No other module, and no test, imports a `*Deps` type by name.

Consequence: removing the barrel re-exports breaks **nothing** internal — every
real consumer already imports by direct path, and `repository.ts` constructs the
deps as an inline object literal (never naming a `*Deps` type).

## Public types that must STAY exported

Removing the wiring internals must not strand the types a consumer genuinely
needs to *name* when working with `repo.snapshot.*`:

- `SnapshotFactory` — the type of `repo.snapshot`.
- `StashSnapshot` — the resolved value of `repo.snapshot.stashEntry(i)`.
- `WorkdirSnapshotOptions` — the option bag for `repo.snapshot.workdir(opts?)`.
- `Snapshot`, `SnapshotEntry`, `SnapshotOptions`, `TreeSnapshot`,
  `IndexSnapshot`, `WorkdirSnapshot` — the snapshot type vocabulary.
- `TreeEntry`, `IndexEntry`, `WorkdirEntry` — the per-source row types.
- `join`, `innerJoin`, `JoinOptions`, `requireSnapshot` — the snapshot
  composition helpers (genuine public surface).

These three modules (`snapshot-factory.ts`, `stash-snapshot.ts`,
`workdir-snapshot.ts`) therefore keep a **type-only** re-export in the barrel
after their value/`*Deps` re-exports are dropped.

## Decision — deliverable 1: drop the re-exports, demote the `*Deps` types

Two coordinated moves:

### (a) `src/index.ts` — drop the nine wiring re-exports

The barrel keeps every public type/helper above and loses exactly the nine rows
in the leak table. The three modules that still owe a public type collapse to a
type-only re-export:

```ts
export type { SnapshotFactory }      from './application/primitives/snapshot/snapshot-factory.js';
export type { StashSnapshot }        from './application/primitives/snapshot/stash-snapshot.js';
export type { WorkdirSnapshotOptions } from './application/primitives/snapshot/workdir-snapshot.js';
```

`createIndexSnapshot` / `createTreeSnapshot` / `createWorkdirSnapshot` are
dropped wholesale from the barrel (no public type owed by `index-snapshot.ts` /
`tree-snapshot.ts` beyond the already-separately-exported `IndexEntry` /
`TreeEntry`).

### (b) Demote the four `*Deps` interfaces to module-local

`IndexSnapshotDeps`, `TreeSnapshotDeps`, `WorkdirSnapshotDeps`, and
`SnapshotFactoryDeps` become non-exported `interface` declarations in their
defining modules. They are pure DI shapes used only as the local factory's
parameter type; with the barrel re-export gone they have **zero** external
referents, so the honest representation is "private wiring shape." The exported
`create*` factories keep working — callers pass structural object literals, so
the parameter type needs no public name (knip's `ignoreExportsUsedInFile`
already tolerates the in-file use either way; demotion is the stronger,
intent-revealing choice).

The `create*` **factory functions themselves stay exported from their modules**
(not demoted) — `repository.ts` and the unit tests consume them by direct path.
The change is scoped to the **barrel** (stop advertising them) and the **`*Deps`
types** (make them private). This is the literal reading of S7: *"consumers use
`repo.snapshot.*`, never hand-wired deps."*

### Faithfulness / API gates

- `reports/api.json` (typedoc) is **unaffected** — `src/index.ts` is not a
  typedoc entry point; the removed symbols were never in the report.
- `check:dead-code` (knip) stays green — `src/index.ts` is a knip entry, and the
  `create*` factories remain reachable via `repository.ts → snapshot-factory.ts`.
- `check:size` — the root `index` bundle can only **shrink** (the `create*`
  wiring is no longer force-rooted by a barrel re-export and tree-shakes out
  where unused). A `rm -rf dist .wireit` precedes trusting any size failure
  (known stale-chunk inflation).
- This is a breaking change to the legacy barrel surface; the 23.4 window allows
  breaking changes without a deprecation cycle (sequenced by dependency, not
  release-bundled), so the removal is clean — no `warnDeprecated` shim.

## Decision — deliverable 2: source accessors (ADR-gated)

The backlog says *"**consider** first-class source accessors
(`repo.tree(rev)` / `repo.index` / `repo.workdir` / `repo.stash`)"* — a weigh,
not a mandate, explicitly bounded by the over-design caution that governs 23.4
(*"force nothing until the right shape is evident from the full surface"*, 23.4j)
and the closing clause **"No rename — only the leaked exports go."**

Three concrete frictions argue against forcing the abstraction in this slice:

1. **`repo.stash` already exists** — it is the stash *command* namespace
   (`repo.stash.{push,list,apply,pop,drop}`). A snapshot accessor at
   `repo.stash` is a hard naming collision; it cannot be a plain getter without
   reshaping an existing, shipped porcelain namespace.
2. **`repo.tree(rev)` is not an alias — it is new capability.** Today
   `repo.snapshot.tree(oid)` takes a resolved **tree `ObjectId`**;
   `repo.tree(rev)` would take a **revision string** and must rev-parse +
   peel-to-tree first. That rev→tree resolution is the heart of **23.4c**
   (`readFileAt(rev, path)`) and the `rev` vocabulary of **23.4e** — building it
   here preempts two not-yet-designed items and risks a shape they will want to
   own.
3. **`repo.index` / `repo.workdir` would be thin getters** delegating to
   `repo.snapshot.index()` / `repo.snapshot.workdir()` — pure surface
   duplication that the read-model convergence capstone (**23.4j**) is the right
   place to decide on, once the whole command set has proven the model out.

**Recommendation: defer all four accessors** — ship deliverable 1 (the mandatory
encapsulation) alone, and record the accessors as an explicit backlog follow-up
so the decision is *deferred, not dropped*. This honours the literal closing
clause, sidesteps the `repo.stash` collision, and avoids preempting 23.4c/e/j.
The disposition is a user-judgment call → captured as an ADR.

## Test strategy

Deliverable 1 is a barrel-shape + encapsulation change; the test pins the
**observable export surface** of `src/index.ts`:

- **Removed value exports** — `import * as barrel from 'src/index.js'`, widen it
  to `Record<string, unknown>` (a named-property access would be a *compile*
  error once the export is gone — defeating a clean green build — so the probe
  goes through an index signature, not a cast-to-ignore), and assert each of
  `createIndexSnapshot`, `createTreeSnapshot`, `createWorkdirSnapshot`,
  `createStashSnapshot`, `createSnapshotFactory` is `undefined`. Pre-change these
  resolve to functions → the assertions fail (RED); post-change they are absent →
  `undefined` (GREEN). Type-only `*Deps` removals erase at runtime, so they are
  covered by the type-check + de-export, not a runtime probe.
- **Kept value exports** — assert `join`, `innerJoin`, `requireSnapshot` remain
  callable functions on the barrel (regression guard: the de-leak must not
  over-remove).
- **Kept type exports** — a compile-time `satisfies`/witness block importing
  `SnapshotFactory`, `StashSnapshot`, `WorkdirSnapshotOptions`,
  `TreeSnapshot`, … from the barrel, proving the public type vocabulary still
  resolves through `src/index.ts`.

The existing `create*` factory unit/mutation tests are untouched (they import by
direct path, which is unchanged) — no behavioural test moves. GWT/AAA, `sut`
naming, 100% coverage, 0 surviving mutants on any touched file.

## Out of scope (logged, not done)

- The source accessors (`repo.tree(rev)` / `repo.index` / `repo.workdir` /
  `repo.stash`) — deferred per the ADR; a backlog follow-up records the weigh.
- `readFileAt(rev, path)` (23.4c), `rev` vocabulary (23.4e), read-model
  convergence (23.4j) — adjacent items that the accessor decision must not
  preempt.
```
