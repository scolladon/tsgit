# Plan — public type re-exports

> Source: design doc `docs/design/public-type-re-exports.md` · ADRs `362, 363, 364, 365`
> The plan is the implementation script AND the knowledge handoff. Slice agents start
> with zero context: whatever a slice block omits is paid later as agent rediscovery.
> `plan-lint.sh` enforces the schema below — the plan phase cannot close without it.

## Decisions — all settled, none open

Every load-bearing choice is ratified in an accepted ADR; the implementer DECIDES nothing
here. No decision-candidates remain for the planner to escalate.

- **Mechanism (ADR-362):** ONE shared `src/public-types.ts` barrel. It `export type *` /
  `export type { … }` from the existing barrels (the facade-reachable closure), **minus**
  the three entry-owned names `Repository`, `OpenRepositoryOptions`, `openRepository`. All
  three runtime entries AND `index.ts` re-export it. The new file is added to `knip.json`
  `entry[]`.
- **Inclusion bar (ADR-363):** the facade-signature-reachable transitive closure (sections
  A–H of the design audit), INCLUDING the two orphans `MergeBaseOptions`
  (`src/application/primitives/merge-base.ts`) and `Pathspec`
  (`src/domain/pathspec/index.ts`). `MergeBaseOptions` needs a NEW re-export added to the
  primitives barrel (today only the value `mergeBase` is exported); `Pathspec` already
  rides its declaring-tier barrel (`domain/pathspec/index.ts`) and is re-exported into
  `public-types.ts` directly. Patch-serializer types are out of scope (not
  facade-reachable); the brief's `PatchResult` does not exist.
- **Branded ids (ADR-364):** `ObjectId`, `RefName`, `FilePath` ride a regular value+type
  `export { … }` (NOT `export type *`) so their `.from`/`.fromRaw` constructors are
  reachable. This is the ONE carve-out from the type-only default.
- **`index.ts` alignment (ADR-365):** `index.ts` re-exports the same `public-types.ts`, so
  the `exports` runtime-entry surface and the `module`/`types` fallback surface export the
  identical facade-reachable type set.

## Sizing rules

- Every slice costs a full agent lifecycle (spin-up, zero-context rebuild, gate) — it
  must earn it. No standalone test-only slices for FEATURE code: coverage/interop/property
  tests fold into the implementation slice whose code they exercise. EXCEPTION:
  test-infra-only and docs-only slices (tooling config, test helpers, fixtures,
  mutation/ADV/property suites, docs/prose) with no `src/` delta ARE standalone — they
  have no implementation slice to fold into.
- A slice that would be a pure test pass over already-landed code merges into its
  neighbour.

### Why ONE slice (sizing rationale — read before splitting)

This is a **types-only** change with a single coherent compile-time proof. The natural
"prerequisite" — the two orphan barrel re-exports (`MergeBaseOptions`, `Pathspec`) — is a
**pure type re-export with no test of its own**: it is a `src/` delta (so NOT a standalone
test-infra/docs slice) and its only proof is the same `expectTypeOf` nameability assertion
that proves the whole barrel. Carved into its own slice it would be a test-less micro-slice
that does not earn an agent lifecycle. The orphan edits, the `public-types.ts` barrel, all
four re-export wirings, the type-level + value-constructor tests, the `knip.json` entry,
and the `reports/api.json` regen therefore **land together** — the nameability test is
precisely what verifies the orphan re-exports reached the entry. No interop test, no
property test (design *Faithfulness* + *Test strategy* state why: no git-observable
behaviour, no parser/decoder/matcher/serializer touched).

## Slice 1 — shared public-types barrel + orphan re-exports + entry/index wiring + nameability tests + api.json

### Context

**Goal.** Make every facade-reachable type (design audit sections A–H) nameable from each
runtime entry and from `index.ts`, via one shared `src/public-types.ts`, with the two
orphans threaded in and the branded-id constructors exposed.

**Entry files (each ends with an IDENTICAL 4-line tail block — do NOT touch the tail's
own value exports; ADD the new barrel re-export):**

- `src/index.node.ts` — declares `OpenNodeRepositoryOptions extends OpenRepositoryOptions`
  + its own `export const openRepository`. Tail (lines 118–121):
  ```
  export type { AdapterSet } from './adapter-detect.js';
  export { detectRuntime, isBrowser, isNode } from './adapter-detect.js';
  export { consoleProgress, noopProgress, type ProgressReporter } from './progress.js';
  export type { OpenRepositoryOptions, Repository } from './repository.js';
  ```
- `src/index.browser.ts` — declares `OpenBrowserRepositoryOptions` + own `openRepository`.
  Identical tail (lines 72–75).
- `src/index.default.ts` — declares `OpenMemoryRepositoryOptions` + own `openRepository`.
  Identical tail (lines 65–68).
- `src/index.ts` — the core/`module`+`types` fallback barrel. Currently: `export *` from
  commands (line 3, value+type), `export *` from ports (line 26, value+type), the snapshot
  family enumerated file-by-file (lines 5–24 — there is NO `snapshot/index.ts` barrel), the
  snapshot-operators barrel (line 25), plus standalone helpers (`warnDeprecated`,
  `innerJoin`/`join`/`JoinOptions`, `requireSnapshot`, adapter-detect + progress). It needs
  the public-types re-export AND a careful reconciliation (below) — it is the ONE file where
  adding the line naively breaks the build.

**The three runtime ENTRIES — append exactly one line, alongside the existing tail (no
removals):**
```
export * from './public-types.js';
```
SAFE (probed): `public-types.ts` deliberately OMITS `Repository`/`OpenRepositoryOptions`/
`openRepository` (no source barrel exports those exact names — `RepositoryConfig`/
`RepositoryLayout` are distinct), so no clash with the entry's own tail + own
`openRepository`/`Open*RepositoryOptions`. The tail's `ProgressReporter` (via `progress.js`)
and public-types' `ProgressReporter` (via `ports` → `progress-reporter.js`) trace to the
SAME original declaration → benign dedupe, no TS2308. `AdapterSet`, `detectRuntime`,
`isBrowser`, `isNode` (tail) are not in public-types. So entries are a clean one-line add.

**`src/index.ts` — RECONCILE, do NOT just append (probed TS2308 otherwise):** adding
`export * from './public-types.js'` while KEEPING `export * from './ports/index.js'`
triggers **TS2308 on `AuthorIdentity`** — `index.ts` would then receive the PORT
`AuthorIdentity` (via the ports wildcard) AND the DOMAIN `AuthorIdentity` (via public-types'
explicit winner) as two different declarations through two wildcards. Fix (probed green):
  1. ADD `export * from './public-types.js';`.
  2. REMOVE the existing `export * from './ports/index.js';` (line 26) — its TYPES now come
     from public-types. REPLACE it with an explicit re-export of the port VALUES that
     public-types' type-only surface does NOT carry:
     `export { createContext } from './ports/context.js';` and
     `export { noopLogger, wrapLoggerSanitizer } from './ports/logger.js';`
     (these are the only value exports in the ports barrel — verified: ports/index.ts lines
     11, 18). Source them from their declaring modules, not the ports barrel, to avoid
     re-pulling the port wildcard.
  3. KEEP `export * from './application/commands/index.js';` (line 3) — its command TYPES
     also appear in public-types but trace to the SAME original declarations (benign
     dedupe, probed); keeping it preserves the command VALUES (`add`, `clone`, …) that
     public-types drops. No conflict.
  4. KEEP `export * from './application/primitives/snapshot-operators/index.js';` (line 25),
     `export { warnDeprecated }`, the `join`/`innerJoin`/`JoinOptions`/`requireSnapshot`
     lines, and adapter-detect/progress lines — these are non-overlapping or same-decl.
  5. The explicit snapshot-family lines (5–24) are now SUBSUMED by public-types (same
     declarations) — they are benign duplicates, but REMOVE them to keep `index.ts` DRY
     (the single public type list lives in public-types now; ADR-365 alignment intent).
     Removing them is safe: public-types re-exports the identical snapshot names. EXCEPTION
     — `index.ts` line 5 `export type { IndexEntry } from '…/snapshot/index-entry.js'` and
     line 22 `TreeEntry`: keep parity with public-types' snapshot winner (same file, same
     decl) — dropping from index.ts is fine because public-types supplies them.
  After the edit, `npm run check:types` is the arbiter — it MUST be green with each public
  name resolving to exactly one declaration. If any TS2308 remains, resolve it by making
  the WINNER an explicit named re-export in `public-types.ts` (never a suppression).

**New file `src/public-types.ts` — the single source of truth.** Compose it from the
existing aggregating barrels using `export type *` (type-only; a mixed value+type barrel
yields only its type side through `export type *`), plus the explicit carve-outs:

- `export type * from './application/commands/index.js';` — section D (diff re-exports) +
  section E (all 53 command `*Options/*Result/*Input/*Info/*Entry/*Namespace`). Verified:
  this barrel does NOT export `Repository`/`OpenRepositoryOptions`/`openRepository`.
- `export type * from './ports/index.js';` — sections A/B: `Context`, `FileSystem`,
  `DirEntry`, `FileStat`, `HashService`, `Hasher`, `Compressor`, `HttpTransport`,
  `HttpRequest`, `HttpResponse`, `RepositoryConfig`, `AuthorIdentity` (port),
  `AuthStrategy`, `RepositoryLayout`, `CreateContextParts`, `Logger`, `HookRunner`,
  `HookRequest`, `HookResult`, `HookName`, `PromisorRemote`, `PromisorFetchOutcome`,
  `IndexResolver`, `ResolveOptions`, `TreeResolver`, `WalkIgnorePredicate`,
  `WorkdirEnumerator`, `WorkdirEnumOptions`, `GenerationView`, `WriteEventEmitter`,
  `Disposable`, `WriteEventStream`, `WriteScope`, `ProgressReporter`. (`createContext`,
  `noopLogger`, `wrapLoggerSanitizer` are values and are dropped by `export type *`.)
  `AuthorIdentity` AND `WalkIgnorePredicate` from this wildcard CLASH with other wildcard
  sources — see **Forced explicit winners** below.
- `export type * from './application/primitives/index.js';` — section F: all `*Options`/
  `*Input`/`*Entry` etc. (the barrel does `export type * from './types.js'` at line 69,
  so `CreateCommitInput`, `DiffTreesInput/Options`, `ReadObjectOptions`,
  `ResolveRefOptions`, `UpdateRefOptions`, `WalkCommits*Options`, `WalkTree*`,
  `WalkWorkingTree*`, `WalkSubmodulesOptions`, `CatFileBatchOptions/Entry`,
  `HashBlobOptions`, `HookInput`, `IsIgnored*`, `SubmoduleEntry`, … all come through;
  the many primitive **values** like `readObject`, `writeObject`, `mergeBase` are dropped).
- `export type * from './domain/objects/index.js';` — section G: `GitObject`, `Blob`,
  `Commit`, `CommitData`, `ExtraHeader`, `Tree`, `TreeEntry` (domain), `Tag`, `TagData`,
  `FileMode`, `ObjectType`, `AuthorIdentity` (domain), `HashConfig`. NOTE: this barrel
  `export * from './object-id.js'` (line 43) — but `export type *` drops `object-id`'s
  VALUE side (`ObjectId`/`RefName`/`FilePath` constructors, `ZERO_OID`, `EMPTY_TREE_OID`);
  the branded-id types come through as types only. The value constructors are re-added
  explicitly below (ADR-364).
- `export type * from './domain/git-index/index.js';` — section G: `GitIndex`,
  `IndexEntry` (git-index), `IndexEntryFlags`, `IndexExtension`, `StatData`. (Design lists
  `GitIndexEntry`/`GitIndexExtension` — the actual names are `IndexEntry`/`IndexExtension`;
  verify against the barrel, do not invent.)
- `export type * from './domain/diff/index.js';` — section D (full diff set incl.
  `ConflictKind`, `LineDiff`, `LineHunk`, `RenameDetectOptions`, `ModeKind`, `FlatTree`,
  `GroupedIndex`, …). The diff change types (`AddChange`, `DeleteChange`, `DiffChange`,
  `DiffChangeType`, `ModifyChange`, `RenameChange`, `TreeDiff`, `TypeChangeChange`,
  `StatDiffChange`, `StatFields`, `StatTreeDiff`) are ALSO re-exported by the commands
  barrel — but VERIFIED both trace to the SAME original declaration
  (`src/domain/diff/diff-change.ts` / `stat-fields.ts`): the commands barrel re-exports the
  diff BARREL's re-export, which re-exports `diff-change.ts`. Same original decl → benign
  dedupe, NO TS2308 (probed semantics above). So both wildcard lines coexist; do NOT drop
  the diff line. NOTE: `domain/diff` also exports the patch-serializer types (`PatchFile`,
  `PatchOptions`, `OutputHunk`, `BodyLine`, `PatchPathPrefix`) — these are NOT
  facade-reachable (ADR-363 out-of-scope) but `export type *` will surface them anyway.
  That is acceptable: they ride in as a side effect of re-exporting the diff barrel
  wholesale; the inclusion bar forbids *requiring* them, not *tolerating* a barrel that
  happens to carry them. Do not hand-prune them (that would mean abandoning the clean
  `export type *` for an explicit list of ~20 diff names — not worth it).
- `export type * from './domain/snapshot/index.js';` — section H rows: `SnapshotKind`,
  `TreeEntryRow`, `IndexEntryRow`, `WorkdirEntryRow`, `WorkdirStat`, `IndexCachedStat`,
  `IndexFlags` (+ `EntryOf`/`InnerJoinRow`/`OuterJoinRow`).
- Snapshot family (section H) — there is **no `snapshot/index.ts` barrel**, so enumerate
  the SAME files `src/index.ts` does (mirror lines 5–24):
  ```
  export type { IndexEntry } from './application/primitives/snapshot/index-entry.js';
  export type {
    IndexSnapshot, Snapshot, SnapshotEntry, SnapshotOptions, TreeSnapshot, WorkdirSnapshot,
  } from './application/primitives/snapshot/snapshot.js';
  export type { SnapshotFactory } from './application/primitives/snapshot/snapshot-factory.js';
  export type { StashSnapshot } from './application/primitives/snapshot/stash-snapshot.js';
  export type { TreeEntry } from './application/primitives/snapshot/tree-entry.js';
  export type { WorkdirEntry } from './application/primitives/snapshot/workdir-entry.js';
  export type { WorkdirSnapshotOptions } from './application/primitives/snapshot/workdir-snapshot.js';
  ```
  **Name-clash semantics (PROBED — do NOT re-derive; this drives the whole barrel).** TS
  re-export rules, verified in a throwaway dir against this worktree's `tsc`:
  - `export type *` (wildcard) + `export type *` (wildcard) re-exporting the SAME name from
    **different** original declarations → **TS2308** ("has already exported a member named
    X"). This is the ONLY conflict that fires.
  - `export type *` (wildcard) + an **explicit** `export type { X }` of a different
    declaration → **NO error**; the explicit named re-export WINS, the wildcard silently
    yields X. (Probed: exit 0.)
  - Two re-exports of the same name tracing to the SAME original declaration → benign
    dedupe, no error (e.g. the diff change types below).

  Consequence for `TreeEntry` / `IndexEntry` (each declared in TWO places — the snapshot
  family AND `domain/objects` (`TreeEntry`) / `domain/git-index` (`IndexEntry`), genuinely
  distinct types): the snapshot family is re-exported with **explicit** named lines (here)
  while `domain/objects` and `domain/git-index` are **wildcards**. By the rule above the
  explicit SNAPSHOT `TreeEntry`/`IndexEntry` AUTO-WIN with no TS2308; the domain/git-index
  `TreeEntry`/`IndexEntry` are silently shadowed under those bare names (still reachable
  structurally via the git-object union `Tree['entries'][n]` and `GitIndex`, just not by
  the bare name). This MATCHES the established precedent: `src/index.ts` today exports the
  SNAPSHOT `TreeEntry`/`IndexEntry` (lines 5, 22) and does not surface domain objects at
  all. Keep that winner — it is ADR-consistent and requires NO edit to the domain barrels
  for these two names. The type-level test (below) asserts `TreeEntry`/`IndexEntry` resolve
  (to the snapshot decl) — that is the intended single declaration per name.
- **Orphans** (ADR-363):
  - `MergeBaseOptions` — its declaring barrel `src/application/primitives/index.ts`
    currently exports only the VALUE `mergeBase` (line 44: `export { mergeBase } from
    './merge-base.js';`). ADD the type: change that line to
    `export { mergeBase } from './merge-base.js';` PLUS
    `export type { MergeBaseOptions } from './merge-base.js';` (or fold into one
    `export { type MergeBaseOptions, mergeBase } from './merge-base.js';`). Once in the
    primitives barrel, the `export type *` from primitives in `public-types.ts` carries it.
  - `Pathspec` — declared in `src/domain/pathspec/compile-pathspec.ts`, re-exported by
    `src/domain/pathspec/index.ts` (line 7), but that barrel is in no public surface. Add
    to `public-types.ts` directly:
    `export type { Pathspec } from './domain/pathspec/index.js';` (its declaring-tier
    barrel already exports it, satisfying ADR-363; no edit needed inside the pathspec dir).
- **Branded-id value carve-out** (ADR-364) — the ONE non-`export type` line:
  ```
  export { FilePath, ObjectId, RefName } from './domain/objects/object-id.js';
  ```
  This pulls BOTH the value constructors (`ObjectId.from`/`.fromRaw`, `RefName.from`,
  `FilePath.from`) and the merged type. Source `object-id.ts` directly (not the
  `domain/objects` barrel) to keep this line surgical. **No conflict with the
  `domain/objects` wildcard** — PROBED: an explicit `export { ObjectId }` (value+type)
  coexists with a wildcard `export type *` that ALSO surfaces the `ObjectId` type, because
  both trace to the SAME original declaration (`object-id.ts`); the explicit value export
  wins and the consumer gets both the value and the type (exit 0; consumer can call
  `ObjectId.from(...)` AND annotate `: ObjectId`). So do NOT prune `ObjectId`/`RefName`/
  `FilePath` from the `domain/objects` wildcard — leave that line a plain `export type *`.
  (Also re-exported from `object-id.ts` are the VALUE constants `ZERO_OID`/`EMPTY_TREE_OID`
  — NOT in this carve-out line, so they do NOT leak to the public surface; only the 3
  named constructors do.)

**Forced explicit winners — three names clash wildcard-vs-wildcard (PROBED: the FULL
planned composition type-checks clean against `tsconfig.json` ONLY with these three explicit
lines).** Each is a distinct declaration reached by two wildcard sources → TS2308 unless one
side is made an explicit `export type { … }` (explicit beats wildcard). Place ALL THREE
AFTER every `export type *` line in `public-types.ts`:
```
export type { AuthorIdentity } from './domain/objects/author-identity.js';
export type { WalkIgnorePredicate } from './ports/snapshot-resolvers.js';
export type { diffTrees } from './application/primitives/diff-trees.js';
```
- `AuthorIdentity` — clashes `src/ports/context.ts:47` (config author bag, via ports
  wildcard) vs `src/domain/objects/author-identity.ts:3` (commit/tag identity, via
  domain-objects wildcard). Both facade-reachable (`repo.ctx.config.author` vs commit/tag
  `data.author`). No ADR-pinned winner; pick the DOMAIN one (rides commit/tag *results* —
  the primary data payload per ADR-249; the port bag stays structurally reachable via
  `Context['config']`). Forced-mechanical, not an open product decision.
- `WalkIgnorePredicate` — clashes `src/ports/snapshot-resolvers.ts` (via ports wildcard) vs
  `src/application/primitives/types.ts` (via primitives wildcard). Pick the PORTS one (it is
  the snapshot-resolver predicate that rides `WorkdirEnumOptions`/`Context`'s resolvers).
- `diffTrees` — a VALUE declared in `src/application/primitives/diff-trees.ts` AND
  `src/domain/diff/tree-diff.ts`; both barrels `export { diffTrees }` (value), and
  `export type *` re-emits the name in type position from two declarations → TS2308. It is
  NOT a public value (the facade exposes the bound `repo.primitives.diffTrees`, not the raw
  fn). `export type { diffTrees }` (type-position re-export of a value name — TS allows it,
  probed clean) collapses it to one declaration and keeps it out of the value surface.
- These three are the COMPLETE set — the probe ran the exact planned barrel and found
  exactly these two TS2308s (`WalkIgnorePredicate`, `diffTrees`) plus the known
  `AuthorIdentity`; adding the three lines above yields a clean `tsc`. If the implementer's
  composition differs and a new TS2308 appears, resolve it the same way (explicit winner,
  never a suppression).

**`knip.json`** (`/Users/.../knip.json`) — add `"src/public-types.ts"` to the `entry[]`
array (after `src/index.browser.ts`, alphabetical-ish — placement is cosmetic, knip does
not order-check). Without this, knip flags `public-types.ts` exports as unused
(`check:dead-code` red). The file is also reachable via the four `export *`/re-export
edges, but register it as an explicit entry per ADR-362 to be safe.

**Tests — type-level nameability assertions (FOLD HERE, primary proof).** The change is
type-only; runtime `Object.keys` cannot see it. Use `expectTypeOf` from `expect-type`
(already installed; pattern in `test/unit/operators/map.test.ts:1` —
`import { expectTypeOf } from 'expect-type';`). Add a NEW shared file
`test/unit/public-types.test.ts` that imports a representative cross-section **as types**
from EACH entry and asserts they resolve. The `check:types` gate is the real proof — a
missing re-export becomes a compile error in this test file. Cover, per the design
edge-matrix, from all THREE entries (`../../src/index.node.js`,
`index.browser.js`, `index.default.js`) AND from `index.ts` (`../../src/index.js`):
  - a branded id: `expectTypeOf<ObjectId>().not.toBeNever()` (+ `RefName`, `FilePath`);
  - a diff shape: `TreeDiff`, `StatTreeDiff`;
  - a port type: `RepositoryConfig` (probe a field), `Context`;
  - the TWO orphans: `MergeBaseOptions`, `Pathspec` (edge-matrix item i);
  - one `*Namespace`: e.g. `BranchNamespace`;
  - a snapshot type: `SnapshotFactory`, `SnapshotOptions`;
  - a command result: e.g. `StatusResult`;
  - edge-matrix item (ii): the entry-owned names still resolve to exactly one declaration —
    `expectTypeOf<Repository>().not.toBeNever()` and `OpenRepositoryOptions` import from the
    entry compile without a TS2308 (the test file failing to compile IS the failure signal);
  - edge-matrix item (iii): import the SAME representative set from `../../src/index.js`
    (the `types`/`module` surface) and from `../../src/index.node.js` (the `exports`
    surface) and assert a couple are mutually assignable
    (`expectTypeOf<import('../../src/index.js').TreeDiff>().toEqualTypeOf<import('../../src/index.node.js').TreeDiff>()`).
  Use GWT describe/it nesting, AAA body, `sut` only where a value SUT exists (the type
  assertions have no runtime sut — that is fine; do NOT manufacture one).

**Tests — value-constructor smoke (ADR-364, FOLD HERE).** Add to the SAME
`test/unit/public-types.test.ts` (or a sibling block) a runtime test importing `ObjectId`
**from the entry** (`../../src/index.node.js`) proving the value side is reachable:
  - `ObjectId.from('<40-hex sha>')` round-trips (returns the same hex, branded);
  - `ObjectId.from('xyz')` throws with SPECIFIC error data — `.data.code === 'INVALID_OBJECT_ID'`
    and `.data.value === 'xyz'`. CRITICAL: the error data field is `value`, NOT `reason`
    (verified in `src/domain/objects/error.ts` — `INVALID_OBJECT_ID` carries
    `{ code, value }`). Use try/catch + direct `.data` assertions (mutation-resistant
    convention), not bare `toThrow`.
  Do the same one-liner reachability for `RefName.from`/`FilePath.from` (each throws a
  plain `Error` on `''` — assert the message, or just that the value side is callable and
  round-trips a non-empty input). Keep these minimal; the point is *value-side reachability
  from the entry*, not re-testing `object-id.ts` (which has its own suite).

**`reports/api.json` regen (FOLD HERE — prepush gate `check:doc-typedoc`).** typedoc's
`typedoc.json` lists `index.node/browser/default.ts` as entry points; adding re-export
edges changes their reflection membership/reference links → `reports/api.json` diff. After
the source lands and `check:types` is green, run `npm run docs:json` (wireit:
`typedoc --json reports/api.json …`) and commit the regenerated `reports/api.json` in THIS
slice. The huge typedoc-id diff is normal. `check:doc-typedoc` is `git diff --exit-code --
reports/api.json` at prepush — pre-pay it now so the push hook is green.

**Surface gates that DO NOT fire (state so the implementer does not chase them):**
- `check:doc-coverage` — reads only `src/repository.ts` + `docs/use/{commands,primitives}`;
  NO `Repository` method added → unaffected.
- `audit-browser-surface` / `check:browser-surface` — audits `repo.<cmd>()` coverage from
  `src/repository.ts`; no command/primitive added → unaffected. No `test/parity/scenarios`
  edit needed.
- README "38 Tier-1 commands" count — zero commands/primitives added → stays 38, untouched.
- New-error-code / discriminated-union exhaustiveness switches — none added → untouched.
- `check:exports` (attw) — pure `export type` + 3 tiny value adds don't change CJS/ESM
  resolution; expected green (full `validate` confirms).
- `check:size` — `export type` is erased; only the 3 branded-id frozen objects add bytes,
  expected within budget (full `validate` confirms).

### TDD steps

1. **RED** — write `test/unit/public-types.test.ts` first: the `expectTypeOf` nameability
   block (all three entries + `index.ts`, the two orphans, branded ids, diff/port/command/
   snapshot/namespace cross-section, edge-matrix ii + iii) and the `ObjectId.from`
   value-constructor smoke. Run `npx vitest run test/unit/public-types.test.ts` and
   `npm run check:types` — **expected failure:** `tsc` cannot resolve the imported type
   names (`ObjectId`, `MergeBaseOptions`, `Pathspec`, `TreeDiff`, … not exported from the
   entries) → TS2724/TS2305 "has no exported member"; the value-smoke fails to import
   `ObjectId` as a value. This compile failure IS the RED.
2. **GREEN** — create `src/public-types.ts` (the full barrel above: `export type *` lines
   for commands/ports/primitives/domain-objects/git-index/diff/domain-snapshot, the
   enumerated snapshot-family explicit lines, the THREE forced explicit-winner lines —
   domain `AuthorIdentity`, ports `WalkIgnorePredicate`, `diffTrees` — placed AFTER the
   wildcards, the `Pathspec` direct line, the branded-id value
   `export { FilePath, ObjectId, RefName }` line). Add `MergeBaseOptions` to
   `src/application/primitives/index.ts`. APPEND `export * from './public-types.js';` to
   each of `src/index.node.ts`, `src/index.browser.ts`, `src/index.default.ts` (one line,
   tail kept intact). RECONCILE `src/index.ts` per the `src/index.ts` block above (add the
   public-types line, REPLACE the ports wildcard with explicit port-value re-exports, drop
   the now-subsumed snapshot-family lines, keep commands wildcard + snapshot-operators +
   the standalone helpers). Add `"src/public-types.ts"` to `knip.json` `entry[]`. Re-run the
   slice gate until `vitest` + `check:types` + `biome` are green. Resolve any TS2308
   ambiguous-re-export by making the WINNER an explicit named re-export (explicit beats
   wildcard, probed) — never a suppression directive.
3. **REFACTOR** — read `src/public-types.ts` end-to-end: confirm it is ALL `export type` /
   `export type *` except the single branded-id value line (ADR-364) — no other value
   leaks (grep the file for a bare `export {` without `type`; only the
   `export { FilePath, ObjectId, RefName }` line is allowed). Confirm the THREE entries each
   kept their original tail intact and appended exactly one re-export, and that `index.ts`
   was reconciled (ports wildcard replaced by explicit port values; no duplicate snapshot
   lines; commands wildcard + snapshot-operators retained). Run
   `npm run docs:json` and commit-stage `reports/api.json`. Run `knip` (or
   `npm run check:dead-code`) to confirm `public-types.ts` is a recognised entry with no
   unused exports. Optionally `npm run validate` locally to confirm attw/size are green
   before commit (the prepush hook runs it anyway).

### Gate

```
npx vitest run test/unit/public-types.test.ts && npm run check:types && ./node_modules/.bin/biome check src/public-types.ts src/index.ts src/index.node.ts src/index.browser.ts src/index.default.ts src/application/primitives/index.ts test/unit/public-types.test.ts
```

(Plus, before commit, the prepush-relevant `npm run docs:json` regen with `reports/api.json`
staged — the commit hook's `check:doc-typedoc` enforces it.)

### Commit

```
feat(types): re-export facade-reachable public type surface from all entries
```
