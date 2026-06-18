# Design — public type re-exports

> Brief: branded/structured types the facade's signatures mention are not nameable from the package's runtime entries; audit the public surface and re-export every type those signatures reference.
> Status: draft → self-reviewed ×3 → accepted

## Context

tsgit's contract **is its types**: ADR-249 makes the library emit structured data, never rendered text, so a consumer can only use a result if it can *name* the type. Today the three runtime entries — `src/index.node.ts`, `src/index.browser.ts`, `src/index.default.ts` (resolved by the `package.json` `exports` `node` / `browser` / `default` conditions, the last also at `tsgit/auto/memory`) — end with an **identical** tail block that re-exports only:

```
export type { AdapterSet } from './adapter-detect.js';
export { detectRuntime, isBrowser, isNode } from './adapter-detect.js';
export { consoleProgress, noopProgress, type ProgressReporter } from './progress.js';
export type { OpenRepositoryOptions, Repository } from './repository.js';
```

Each entry additionally declares its own `openRepository` and its own `Open{Node,Browser,Memory}RepositoryOptions extends OpenRepositoryOptions`. So from `import … from 'tsgit'` (node condition) a consumer can name `Repository` and `OpenRepositoryOptions` but **cannot name any type those two signatures mention** — every method return, every option bag, every branded id. The documented downstream workaround is `Awaited<ReturnType<Repository['revParse']>>` gymnastics.

There are **two different `.` surfaces** and they disagree:

- Tools that read `exports` (modern bundlers, Node ESM) get the **runtime entry** (`index.node.ts` …) — the thin surface above.
- Tools that read the top-level `module` / `types` fallback fields get `src/index.ts` (the "core" barrel) — a **richer** surface that already `export *`s the commands barrel, the ports barrel, the snapshot family and the snapshot-operators barrel.

This inconsistency is itself a defect: the same `import 'tsgit'` resolves to different exported type sets depending on which field the toolchain honours. The core barrel `index.ts` is *also* incomplete — it never exposes the branded domain ids (`ObjectId` / `RefName` / `FilePath`), the git object union (`Commit` / `Tree` / `Blob` / `Tag`), `SnapshotFactory`'s `Pathspec`, or `MergeBaseOptions`.

Subpath exports (`tsgit/primitives`, `tsgit/commands/*`, `tsgit/operators`, `tsgit/transport`, `tsgit/adapters/{node,browser,memory}`) are unaffected and out of scope.

Constraining prior art:
- **ADR-249** (structured data, not cosmetics) — `docs/adr/249-describe-structured-data-only.md`. The contract is the data shape; the type must be nameable.
- **ADR-226** (git-faithfulness prime directive) — `docs/adr/226-git-faithfulness-prime-directive.md`. See *Faithfulness* below: this change is faithfulness-trivial.
- The public-surface gate map — `.claude/workflow/surface-gates.md`.

This is a **types-only / public-surface** change. The two-`.`-surfaces inconsistency above is a real consumer-facing inconsistency the design must resolve (decision 4), not merely "noted".

### Faithfulness

This change introduces **no new runtime behaviour and no git-observable behaviour**. It adds `export type` lines to barrels; no object SHA, ref, reflog, on-disk state file, refusal condition, or message format changes. Re-exported types are erased at compile time (`export type`), so even the emitted JS is unchanged for the type-only additions. The byte-for-byte faithfulness directive (ADR-226) is therefore satisfied **trivially** — there is nothing observable to pin against real `git`, and no `test/integration/*-interop.test.ts` slice is warranted. The empirical pinning in this doc is confined to the **TypeScript export surface and its tooling gates** (below), which is where the only risk lives.

## Requirements

When this ships:

1. From every runtime entry (`tsgit` under node/browser/default, and `tsgit/auto/{node,browser,memory}`), a consumer can `import type` **every type transitively named by `Repository` (all members), `OpenRepositoryOptions`, and the three `Open*RepositoryOptions`** — without `ReturnType`/`Awaited` gymnastics. "Transitively named" = the closure of types appearing in public method params and return types (unwrapping `Promise` / `AsyncIterable` / `ReadonlyArray` / overloads / union members).
2. The branded ids `ObjectId`, `RefName`, `FilePath` are nameable from every runtime entry (decision 3 settles value-side constructor exposure).
3. The two orphan types reachable from the facade but currently in **no** barrel — `MergeBaseOptions` (via `Repository['primitives'].mergeBase`) and `Pathspec` (via `SnapshotOptions.paths`, reachable through `Repository['snapshot']`) — are nameable.
4. The set of types exported from `index.ts` and from each runtime entry is **consistent** per decision 4 (no consumer sees a different type set because their toolchain read `types`/`module` vs `exports`).
5. No value export is added where only a type is intended (no runtime/bundle-size regression from type-only additions); `export type` is used for pure types.
6. All gates green: `check:types`, `check:dead-code` (knip), `check:exports` (attw), `check:size`, `check:doc-coverage`, and the prepush `check:doc-typedoc` (`reports/api.json` regenerated).
7. No collision with each entry's own `openRepository` / `Open*RepositoryOptions` declarations.

## Design

### The audit (exhaustive transitive inventory)

Starting from the public node-entry surface — `openRepository` / `OpenNodeRepositoryOptions`, and `Repository` with **every** member — and unwrapping `Promise` / `AsyncIterable` / `ReadonlyArray` / overload sets / union members, the transitive type closure is below. "Reachable from runtime entry today" is `no` for everything except the four tail re-exports. The three runtime entries are **symmetric** (browser/memory reference the identical `Repository`, `OpenRepositoryOptions`, and `Open*RepositoryOptions extends OpenRepositoryOptions`), so one inventory applies to all three.

Legend for **In barrel today**: `cmds` = `src/application/commands/index.ts`; `prim` = `src/application/primitives/index.ts`; `ports` = `src/ports/index.ts`; `domain` = `src/domain/index.ts` (and its sub-barrels); `core` = `src/index.ts`; `none` = no barrel re-exports it.

#### A. Facade / options spine

| Type | Declaring module | In barrel today | Runtime entry today |
|---|---|---|---|
| `Repository` | `src/repository.ts` | (self) | yes (tail) |
| `OpenRepositoryOptions` | `src/repository.ts` | (self) | yes (tail) |
| `Context` | `src/ports/context.ts` | ports, core | no (exposed via `repo.ctx`) |
| `ProgressReporter` | `src/ports/progress-reporter.ts` | ports, core | yes (via `progress.ts`) |
| `AdapterSet` | `src/adapter-detect.ts` | — | yes (tail) |

#### B. Port types (needed to construct `OpenRepositoryOptions` AND surfaced via `repo.ctx: Context`)

| Type | Declaring module | In barrel today | Runtime entry today |
|---|---|---|---|
| `FileSystem`, `DirEntry`, `FileStat` | `src/ports/file-system.ts` | ports, core | no |
| `HashService`, `Hasher` | `src/ports/hash-service.ts` | ports, core | no |
| `Compressor` | `src/ports/compressor.ts` | ports, core | no |
| `HttpTransport`, `HttpRequest`, `HttpResponse` | `src/ports/http-transport.ts` | ports, core | no |
| `RepositoryConfig`, `AuthorIdentity`, `AuthStrategy`, `RepositoryLayout`, `CreateContextParts` | `src/ports/context.ts` | ports, core | no |
| `Logger` | `src/ports/logger.ts` | ports, core | no |
| `HookRunner`, `HookRequest`, `HookResult` | `src/ports/hook-runner.ts` | ports, core | no |
| `CommandRunner` | `src/ports/command-runner.ts` | ports, core | no |
| `HookName` | `src/domain/hooks/…` | ports, core | no |
| `PromisorRemote`, `PromisorFetchOutcome` | `src/ports/promisor.ts` | ports, core | no |
| `HashConfig` | `src/domain/objects/hash-config.ts` | domain | no |
| `GenerationView`, `IndexResolver`, `TreeResolver`, `WorkdirEnumerator`, `WriteEventEmitter`, `WriteEventStream`, `WriteScope`, `Disposable`, … | `src/ports/*` | ports, core | no |

#### C. Branded domain ids (in NO entry today, not even core)

| Type | Declaring module | In barrel today | Runtime entry today |
|---|---|---|---|
| `ObjectId` | `src/domain/objects/object-id.ts` | domain | no |
| `RefName` | `src/domain/objects/object-id.ts` | domain | no |
| `FilePath` | `src/domain/objects/object-id.ts` | domain | no |

Each name is a **declaration-merged pair**: `export type ObjectId` + `export const ObjectId = { from, fromRaw }` (and `RefName.from`, `FilePath.from`). Decision 3 governs whether the value side ships.

#### D. Diff types (via `Repository.diff` / `.show` / `.rangeDiff` / `primitives.diffTrees`)

| Type | Declaring module | In barrel today | Runtime entry today |
|---|---|---|---|
| `TreeDiff`, `StatTreeDiff` | `src/domain/diff/diff-change.ts`, `…/stat-fields.ts` | cmds, domain, core | no |
| `DiffChange`, `DiffChangeType`, `AddChange`, `DeleteChange`, `ModifyChange`, `RenameChange`, `TypeChangeChange`, `StatDiffChange`, `StatFields` | `src/domain/diff/*` | cmds, domain, core | no |

#### E. Command result/option/namespace types (the 53-line commands barrel)

All of `src/application/commands/index.ts` is transitively reachable through `Repository` members — every `*Options`, `*Result`, `*Input`, `*Info`, `*Entry`, the `*Namespace` interfaces (`BranchNamespace`, `CherryPickNamespace`, `ConfigNamespace`, `MergeNamespace`, `RebaseNamespace`, `RemoteNamespace`, `RevertNamespace`, `SparseCheckoutNamespace`, `StashNamespace`, `SubmoduleNamespace`, `TagNamespace`, `WorktreeNamespace`), plus `DescribeOptions/Result`, `NameRevResult`, `DiffOptions`, `ShowOptions/Result/Input`, etc. **In barrel today**: cmds, core (via `export * from './application/commands/index.js'`). **Runtime entry today**: no. (Full per-line list is the commands barrel itself; not duplicated here to avoid a stale copy — the implementation re-exports the barrel wholesale, see *re-export surface*.)

#### F. Primitive return/param types (via `Repository['primitives']`)

| Type | Declaring module | In barrel today | Runtime entry today |
|---|---|---|---|
| `CatFileBatchEntry`, `CatFileBatchOptions`, `CreateCommitInput`, `DiffTreesInput`, `DiffTreesOptions`, `HashBlobOptions`, `ReadObjectOptions`, `ResolveRefOptions`, `UpdateRefOptions`, `WalkCommitsOptions`, `WalkCommitsByDateOptions`, `WalkSubmodulesOptions`, `SubmoduleEntry`, `WalkTreeEntry`, `WalkTreeOptions`, `WalkWorkingTreeEntry`, `WalkWorkingTreeOptions`, `HookInput`, `IsIgnoredQuery`, `IsIgnoredMatch`, `IsIgnoredMatchSource` | `src/application/primitives/*` | prim | no |
| `MergeBaseOptions` | `src/application/primitives/merge-base.ts` | **none** (orphan) | no |

#### G. Git object union (via `primitives.readObject` / `readBlob` / `readTree` / `writeObject` / `catFileBatch`)

| Type | Declaring module | In barrel today | Runtime entry today |
|---|---|---|---|
| `GitObject`, `Blob`, `Commit`, `CommitData`, `Tree`, `TreeEntry` (domain), `Tag`, `TagData`, `ExtraHeader`, `FileMode`, `ObjectType`, `AuthorIdentity` (domain) | `src/domain/objects/*` | domain | no |
| `GitIndex`, `GitIndexEntry`, `GitIndexExtension` | `src/domain/git-index/*` | domain | no |

#### H. Snapshot family (via `Repository['snapshot']: SnapshotFactory`)

| Type | Declaring module | In barrel today | Runtime entry today |
|---|---|---|---|
| `SnapshotFactory` | `src/application/primitives/snapshot/snapshot-factory.ts` | core | no |
| `Snapshot`, `SnapshotEntry`, `SnapshotOptions`, `TreeSnapshot`, `IndexSnapshot`, `WorkdirSnapshot` | `src/application/primitives/snapshot/snapshot.ts` | core | no |
| `TreeEntry` (snapshot), `IndexEntry` (snapshot), `WorkdirEntry`, `WorkdirSnapshotOptions`, `StashSnapshot` | `src/application/primitives/snapshot/*` | core | no |
| `TreeEntryRow`, `IndexEntryRow`, `WorkdirEntryRow`, `WorkdirStat`, `IndexCachedStat`, `IndexFlags`, `SnapshotKind` | `src/domain/snapshot/*` | domain | no |
| `Pathspec` | `src/domain/pathspec/index.ts` | **none** (orphan) | no |

**Orphans confirmed (referenced by a facade-reachable public signature, re-exported by NO barrel):** `MergeBaseOptions`, `Pathspec`. These are the only types that need a *new* barrel re-export at their declaring tier in addition to being surfaced at the entry; every other type already lives in some barrel and only needs to be threaded to the runtime entries. Decision 2 governs whether the inclusion bar reaches these (the recommendation says yes — they are facade-reachable).

> Brief vs reality: the brief's example `PatchResult` **does not exist** in the codebase. The patch machinery is `PatchFile` / `PatchOptions` / `OutputHunk` / `BodyLine` / `PatchPathPrefix` in `src/domain/diff/patch-serializer.ts`, and `show`'s result carries `patch?: D` where `D` is `TreeDiff` | `StatTreeDiff` (no distinct `PatchResult`). The patch-serializer types are **not** facade-reachable (the facade returns structured diff, not a rendered patch — consistent with ADR-249), so they are out of scope under the recommended inclusion bar. Treated as an illustrative "…" placeholder, not a literal requirement.

### The re-export surface

The design intent (pending decision 1's mechanism) is: every type in sections A–H above becomes nameable from each runtime entry, with the entry → barrel wiring kept DRY and `index.ts`-consistent (decision 4). Two implementation invariants regardless of mechanism:

- **Collision avoidance.** Each runtime entry declares its own `openRepository` and `Open{Node,Browser,Memory}RepositoryOptions`, and re-exports `Repository` + `OpenRepositoryOptions` in the tail. A wholesale `export * from './index.js'` (or from a shared barrel that itself re-exports `repository.ts`) must **not** also re-export `openRepository` / `OpenRepositoryOptions` / `Repository`, or it collides with the entry's own bindings (TS2308 "Module has already exported a member" / ambiguous re-export). The shared surface must exclude the names each entry owns, OR each entry uses explicit `export type { … }` lists that omit them.
- **`export type` for pure types.** Sections B–H are all types; they must ride `export type` (or `export { type X }`) so nothing leaks to runtime. `export *` from a barrel that mixes values and types (e.g. the commands barrel exports both the type `AddOptions` and the value `add`; the diff barrel exports the value `diffLines`; ports exports `createContext`, `noopLogger`) would pull **values** onto the entry — a runtime/bundle-size regression and a wider surface than intended. A type-only re-export must use `export type * from '…'` (TS 5.0+, available; the repo is on typescript 6.0.3) or an explicit `export type { … }` list. This is the crux of decision 1.

The branded ids' declaration-merged value constructors (`ObjectId.from`, `RefName.from`, `FilePath.from`) are the one place where "type vs value" is a genuine product choice, not just hygiene — decision 3.

### Tooling-gate behaviour (empirically pinned)

The only risk surface is the toolchain. Pinned against the committed artifacts in this worktree (read-only probes; no worktree-mutating probe was run — per the workflow constraint, the full before/after `reports/api.json` byte-diff is a plan-phase verification step in a throwaway clone, not re-derived here):

| Gate | Command | Pinned reaction | Evidence |
|---|---|---|---|
| `check:doc-typedoc` | `git diff --exit-code -- reports/api.json` (prepush) | **Fires.** typedoc resolves all 13 entry points (incl. `index.node/browser/default.ts`); adding re-export edges to those modules changes their reflection `children`/reference links → non-empty diff. Must regenerate via `npm run docs:json` and commit. | `typedoc.json` lists the 3 runtime entries as entry points; `reports/api.json` already contains the symbols (`ObjectId` ×212, `Repository` ×8, `TreeDiff` ×16, `RepositoryConfig` ×7 occurrences) via the `domain`/`repository`/`commands`/`ports` entry points — so the diff is new **membership/reference edges**, not whole new symbol declarations (likely modest, still non-empty → gate trips). |
| `check:doc-coverage` | `tooling/check-doc-coverage.ts` | **Unaffected.** Reads only `src/repository.ts` + `docs/use/commands|primitives/*.md`; no `Repository` method added. | `package.json` wireit `check:doc-coverage.files` = `src/repository.ts` + docs dirs only. |
| `check:dead-code` (knip) | `knip` | **Watch.** knip entries include all four `index.*.ts`; exports re-exported **from an entry file** are treated as used, so threading types through entries keeps them live. A **new** shared barrel file (decision 1 option a) is NOT a knip entry and would need adding to `knip.json` `entry[]` (or be imported by an entry, which a re-export is) — verify no "unused export" on the new file. | `knip.json` `entry[]` lists `index.ts`, `index.{default,node,browser}.ts`, the barrels. |
| `check:exports` (attw) | `attw --pack . --profile node16` | **Watch, expected green.** Pure `export type` additions don't change CJS/ESM resolution or masquerading; the `.d.cts`/`.d.ts` pair per entry already exists. | `package.json` `exports` already ships `types` for cjs+esm per entry. |
| `check:size` | `size-limit` | **Expected no-op for type-only adds.** `export type` is erased; only decision-3's value-constructor exposure could add bytes (3 tiny frozen objects). | `.size-limit.json` budgets the built bundle. |
| `check:browser-surface` | `tooling/audit-browser-surface.ts` | **Unaffected.** Audits `repo.<cmd>()` invocation coverage from `src/repository.ts`; no method added. | wireit `check:browser-surface.files` = `src/repository.ts` + scenarios. |
| README count | manual | **Unaffected.** README line is `38 Tier-1 commands · 20+ … primitives`; this change adds **zero** commands/primitives — the count stays 38. | `README.md:46`. |

The new-Tier-1-command gate cluster in `.claude/workflow/surface-gates.md` (barrel + facade + `repository.test` `Object.keys` snapshot + doc page + browser scenario + count) does **NOT** apply: no command, no primitive, no error code, no discriminated-union member is added. The only gate that fires is `check:doc-typedoc` (regenerate `reports/api.json`), plus knip/attw/size verification.

## Decision candidates

| # | Choice | Alternatives (≤3) | Recommendation | Why |
|---|---|---|---|---|
| 1 | **Re-export mechanism** — how the runtime entries gain the transitive type set | (a) one shared `src/public-types.ts` barrel that the 3 runtime entries + `index.ts` all re-export from (single source of truth); (b) each runtime entry adds explicit `export type { … }` lists (duplicated 3×); (c) each runtime entry does `export type * from './index.js'` (or imports a slimmed core) to inherit the core barrel | **(a)** a shared `src/public-types.ts` using `export type *` from the existing barrels (commands/ports/domain-objects/snapshot/diff) **minus** the entry-owned names (`Repository`, `OpenRepositoryOptions`, `openRepository`), re-exported by all 3 entries **and** `index.ts` | DRY (one list, can't drift between entries), avoids the 3× duplication of (b), avoids (c)'s collision with each entry's own `openRepository`/`Open*Options` and avoids `index.ts` pulling itself in circularly. Forces the `export type *` hygiene decision once. Cost: one new file → add to `knip.json` `entry[]`. |
| 2 | **Audit scope / inclusion bar** — where to draw the "re-export this" line | (a) only types **facade-signature-reachable** (the A–H closure, incl. orphans `MergeBaseOptions`/`Pathspec`); (b) (a) **plus** the whole commands + primitives + ports barrels even where not facade-reachable; (c) (a) **minus** `Context`'s deep internals (resolver/event-bus ports) that are advanced-only | **(a)** — the transitive closure of `Repository` (all members, incl. `repo.ctx: Context`), `OpenRepositoryOptions`, and the 3 `Open*RepositoryOptions`, which already equals the full commands + primitives + ports + relevant domain barrels in practice | Matches the requirement verbatim ("every type the facade's signatures mention"); `repo.ctx: Context` already drags in the deep port set, so (c) can't actually exclude them without making `Context` un-nameable; (b) adds non-reachable noise. Pins the two orphans in. |
| 3 | **Branded-ids value side** — `ObjectId`/`RefName`/`FilePath` are declaration-merged type+constructor | (a) `export type` only — consumers can annotate/return but not mint ids; (b) export type **and** the value constructors (`ObjectId.from`, `.fromRaw`, `RefName.from`, `FilePath.from`) so consumers can validate/construct; (c) export type now, defer constructors to a follow-up | **(b)** export both | A consumer that receives an `ObjectId` from one call and must pass a *literal* sha to another (e.g. `repo.primitives.readObject(ObjectId.from(sha))`) needs the constructor to cross the brand boundary without an `as` cast; type-only would force unsafe casts, defeating the brand. Cost: 3 tiny frozen objects in the bundle (size-limit check). Confirm no other entry already names `ObjectId` (it does not — collision-free). |
| 4 | **`index.ts` alignment** — the `module`/`types` fallback surface vs the `exports` runtime surface | (a) make `index.ts` expose the **same** added set (single consistent `.` surface regardless of which field the toolchain reads); (b) leave `index.ts` as-is (richer-but-different); (c) make the runtime entries `export type *` from `index.ts` so they are by-construction a superset | **(a)** align `index.ts` to the shared `public-types.ts` from decision 1 so both `.` resolutions export the same type set | Removes the latent "two `.` surfaces disagree" bug (Context section); (b) perpetuates it; (c) is decision-1 option (c) which collides with entry-owned names. With decision 1(a), `index.ts` simply re-exports the same shared barrel — alignment is free. |

## Test strategy

- **Type-level nameability assertions (primary).** The change is type-only, so runtime `Object.keys` snapshots cannot see it. Use `expect-type`'s `expectTypeOf` (already used in `test/unit/operators/map.test.ts`) in a new unit test per entry — extend the existing `test/unit/index.node.test.ts`, `index.browser.test.ts`, `index.default.test.ts` (or a shared `test/unit/public-types.test.ts`) — importing a representative cross-section as **types** from `'../../src/index.node.js'` etc. and asserting they resolve (e.g. `expectTypeOf<ObjectId>().not.toBeNever()`, a `TreeDiff`/`StatTreeDiff` shape probe, a `RepositoryConfig` field probe, the two orphans `MergeBaseOptions`/`Pathspec`, one `*Namespace`). The `tsc` gate (`check:types`) is what actually proves importability — a missing re-export is a compile error in the test file. Assert **all three entries symmetric**.
- **Value-constructor smoke (decision 3 dependent).** If 3(b), one runtime test that `ObjectId.from(validSha)` round-trips and `ObjectId.from('xyz')` throws `INVALID_OBJECT_ID` (specific error data, per the mutation-resistant-test convention) — imported from the entry, not the domain module, to prove the value side is reachable.
- **Gate regeneration.** `npm run docs:json` → commit `reports/api.json` in the same slice that lands the re-exports (prepush `check:doc-typedoc`). Run `knip` to confirm any new `public-types.ts` is a recognised entry with no unused exports; run `attw` and `size-limit`.
- **Property-test lens — N/A.** None of the four lenses (round-trip pair / compositional matcher / total function over a grammar / idempotence-counting) apply: this is a re-export manifest, not a parser/decoder/matcher/serializer. No `*.properties.test.ts` sibling is warranted; stated explicitly so the review phase does not flag the gap.
- **No interop test.** No git-observable behaviour changes (see *Faithfulness*); the interop harness is not exercised.
- **Edge matrix.** (i) the two orphans compile-import; (ii) entry-owned names (`Repository`, `OpenRepositoryOptions`, `openRepository`) still resolve to exactly one declaration (no TS2308 collision) from each entry; (iii) `import 'tsgit'` via the `types`/`module` field (`index.ts`) and via `exports` (`index.node.ts`) yield the **same** type set (decision 4).

## Out of scope

- New runtime behaviour, new commands, new primitives, new error codes — none; this is purely the type export surface.
- Subpath exports (`tsgit/primitives`, `tsgit/commands/*`, `tsgit/operators`, `tsgit/transport`, `tsgit/adapters/*`) — already expose their own barrels; not touched.
- Patch-serializer types (`PatchFile`, `PatchOptions`, `OutputHunk`, …) — not facade-reachable (the facade returns structured diff, not rendered patch, per ADR-249); excluded under the decision-2(a) bar. The brief's `PatchResult` does not exist.
- Renaming, reshaping, or documenting individual types — re-export only; the types themselves are unchanged.
- `docs/use/*` prose pages and typedoc category copy — the regenerated `reports/api.json` is in scope (gate), curated prose is a docs-phase concern, not this design.
