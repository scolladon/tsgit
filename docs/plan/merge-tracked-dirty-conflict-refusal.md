# Plan — merge-command tracked-dirty conflict-path refusal (S13 gap)

> Source: design doc `docs/design/merge-tracked-dirty-conflict-refusal.md` · ADRs `342, 343, 344, 345`
> The plan is the implementation script AND the knowledge handoff. Slice agents start
> with zero context: whatever a slice block omits is paid later as agent rediscovery.
> `plan-lint.sh` enforces the schema below — the plan phase cannot close without it.

## Sizing rules

- Every slice costs a full agent lifecycle (spin-up, zero-context rebuild, gate) — it
  must earn it. No standalone test-only slices: coverage/interop/property tests fold
  into the implementation slice whose code they exercise.
- A slice that would be a pure test pass over already-landed code merges into its
  neighbour.

## Why two slices (sequencing rationale — read first)

The `WORKING_TREE_DIRTY` payload change (`{ paths }` → `{ localChanges, untracked }`,
ADR-344) is a **union shape change**: it breaks the constructor, the union member, the
renderer's exhaustiveness switch, **every** would-overwrite call site, the apply
primitive's `would-overwrite` arm, the `CHECKOUT_OVERWRITE_DIRTY` → `WORKING_TREE_DIRTY`
mapper, the stash boundary, and `reports/api.json` **all at once, at compile time**. There
is no green intermediate where only some consumers are migrated — TypeScript fails the
whole tree until the last one moves. So the shape change + the promotion of the shared
predicate (ADR-342) + the `lstat` probe switch (ADR-343) + sort/de-dup (ADR-345) land as
**one atomic slice (Slice 1)**: it leaves merge's *behaviour* untouched (merge's conflict
path still has no tracked-dirty guard — that is Slice 2) but makes the whole error family
speak the two-array shape and pre-pays every surface gate.

Slice 2 is the **feature**: wire the conflict-wide guard into `merge`'s conflict write
path using the primitive Slice 1 promoted, remove the now-subsumed
`collectUntrackedRenameBlockers`, and pin parity with the interop matrix. Slice 2 builds
on Slice 1 in the same working tree.

Both slices are real TDD increments with production code; neither is a test-only pass.

---

## Slice 1 — Two-array WORKING_TREE_DIRTY shape + promoted findWouldOverwrite (lstat, sorted, de-duped)

### Context

This slice changes the `WORKING_TREE_DIRTY` payload from a flat `{ paths }` to two
class-keyed arrays `{ localChanges, untracked }` (ADR-344, each sorted ascending,
`localChanges` first per ADR-345), promotes the would-overwrite predicate to a shared
internal primitive returning that shape with an `lstat` untracked probe (ADRs 342/343),
and migrates every existing producer/consumer. Merge's conflict-path **behaviour** is
unchanged here (no new guard yet — Slice 2).

**The shape change is a public-surface change to an EXISTING error code.** `WORKING_TREE_DIRTY`
is reachable by library users and appears in `reports/api.json` (verified: 1 occurrence).
Surface gates to pre-pay IN THIS SLICE:
- The renderer's exhaustiveness `switch` over `CommandError` lives in **`src/domain/error.ts`**
  (the only never-check: `default:` → `const _exhaustive: never = data;` at lines ~468–469).
  The compiler flags the `WORKING_TREE_DIRTY` case (`:281`, reads `data.paths.length`) and —
  because `CHECKOUT_OVERWRITE_DIRTY` is also enriched below — its case (`:321`, reads
  `data.paths.length`) only on type-check. Run `npm run check:types` to surface both.
- **`reports/api.json`** is a *prepush* gate (`check:doc-typedoc` = `git diff --exit-code -- reports/api.json`),
  NOT caught by `validate`. Regenerate with **`npm run docs:json`** and commit the result
  in this slice (the typedoc-id churn is normal/expected).
- No barrel-surface exhaustive-set test exists for this union beyond the renderer switch
  and `error.test.ts` (below); no new code/barrel entry is added (the promoted primitive is
  internal, consumed only within `src/`).

**Files & symbols to change (exact name-paths and current signatures):**

1. `src/domain/commands/error.ts`
   - Union member `:8`: `{ readonly code: 'WORKING_TREE_DIRTY'; readonly paths: ReadonlyArray<FilePath> }`
     → `{ readonly code: 'WORKING_TREE_DIRTY'; readonly localChanges: ReadonlyArray<FilePath>; readonly untracked: ReadonlyArray<FilePath> }`.
   - `workingTreeDirty` factory `:214`: today `(paths: ReadonlyArray<FilePath>) => new TsgitError({ code: 'WORKING_TREE_DIRTY', paths })`
     → `({ localChanges, untracked }: { readonly localChanges: ReadonlyArray<FilePath>; readonly untracked: ReadonlyArray<FilePath> }) => new TsgitError({ code: 'WORKING_TREE_DIRTY', localChanges, untracked })`.
   - `CHECKOUT_OVERWRITE_DIRTY` union member `:44`: `{ … paths: ReadonlyArray<FilePath> }`
     → enrich to `{ … localChanges: ReadonlyArray<FilePath>; untracked: ReadonlyArray<FilePath> }`
     (the enrich route the design prefers — keeps the class the producer already computes).
   - `checkoutOverwriteDirty` factory `:301`: today `(paths) => new TsgitError({ code: 'CHECKOUT_OVERWRITE_DIRTY', paths })`
     → `({ localChanges, untracked }) => new TsgitError({ code: 'CHECKOUT_OVERWRITE_DIRTY', localChanges, untracked })`.
   - `STASH_APPLY_WOULD_OVERWRITE` (`:184` union, `:535` factory) is UNCHANGED — stash keeps
     its own flat `{ paths }` contract (design "Stash boundary"); only its *call site* adapts.

2. `src/domain/error.ts`
   - `WORKING_TREE_DIRTY` renderer `:281`: `working tree has uncommitted changes: ${data.paths.length} files`
     → `${data.localChanges.length + data.untracked.length} files` (count = sum of both classes;
     message stays a count summary, not git prose, per ADR-249).
   - `CHECKOUT_OVERWRITE_DIRTY` renderer `:322`: `checkout would overwrite uncommitted changes: ${data.paths.length} files`
     → `${data.localChanges.length + data.untracked.length} files`.

3. `src/application/primitives/apply-merge-to-worktree.ts` — promote + reshape (ADRs 342/343/344/345):
   - `changedPaths` (`:100`, private const) and `findWouldOverwrite` (`:116`, private const)
     EXTRACT into a new shared internal primitive `src/application/primitives/find-would-overwrite.ts`
     and import them back here. Keep `outcomeChangesOurs` (`:72`) co-located with `changedPaths`
     (it is `changedPaths`'s only helper) — move it into the new primitive too. **Carry the
     existing `Stryker disable next-line` justification comments verbatim** (they document
     equivalent mutants on `outcomeChangesOurs`'s sub-conditions and the stage-0 filter in
     `findWouldOverwrite` `:123`).
   - `findWouldOverwrite` signature today: `(ctx: Context, paths: ReadonlySet<FilePath>, currentIndex: GitIndex) => Promise<ReadonlyArray<FilePath>>`.
     New: `=> Promise<{ readonly localChanges: ReadonlyArray<FilePath>; readonly untracked: ReadonlyArray<FilePath> }>`.
     - tracked-and-modified branch (`isWorkingTreeModified(await compareWorkingTreeEntry(ctx, entry))`, `:135`)
       → push to `localChanges`.
     - untracked branch (`entry === undefined`, `:129`): **switch the presence probe from
       `ctx.fs.exists(\`${ctx.layout.workDir}/${path}\`)` (`:131`) to `ctx.fs.lstat(...)`** — `lstat`
       throws on a non-existent path (presence-without-follow), so wrap in try/catch returning a
       boolean, mirroring `merge.ts`'s existing `isUntrackedBlocker` (`:494`-503, which already does
       exactly this: `try { await ctx.fs.lstat(abs); return true } catch { return false }`). On
       present → push to `untracked` (ADR-343 / R8 / DG1: a dangling symlink's `lstat` succeeds
       where `exists`/`realpath` returns false).
     - **ORD2 de-dup**: a path that is tracked-dirty is recorded in `localChanges` ONLY — never
       also probed/added to `untracked`. With the `entry === undefined` branch this is automatic
       (a tracked path has an index entry → never enters the untracked branch); keep the
       `continue` after the untracked push so the two branches stay mutually exclusive.
     - **Sorting is applied at the refusal-construction boundary, NOT inside `findWouldOverwrite`**
       (ADR-345 neutral note: `changedPaths` stays order-agnostic). The consumers sort each array
       with `comparePaths` (exported from `src/domain/diff/index.js`) when building
       `workingTreeDirty({ localChanges, untracked })`. To keep this DRY and consistent, have the
       primitive expose a small helper or have each call site sort — pick the form that keeps the
       five call sites identical; the design leaves the concrete form to plan/impl. Recommended:
       sort inside the primitive's return so every consumer gets sorted arrays (the internal set
       stays order-agnostic; only the returned arrays are sorted) — this avoids five duplicated
       `.sort(comparePaths)` calls and is observationally identical.
   - `ApplyMergeResult` `would-overwrite` arm (`:69`): `{ readonly kind: 'would-overwrite'; readonly paths: ReadonlyArray<FilePath> }`
     → `{ readonly kind: 'would-overwrite'; readonly localChanges: ReadonlyArray<FilePath>; readonly untracked: ReadonlyArray<FilePath> }`.
   - `applyMergeToWorktree` `:304`-306: `const overwrite = await findWouldOverwrite(...)` returns the
     object now; `if (overwrite.localChanges.length > 0 || overwrite.untracked.length > 0) return { kind: 'would-overwrite', localChanges: overwrite.localChanges, untracked: overwrite.untracked };`.
     **Keep the `Stryker disable` comment on the `force: true` line (`:313`-314).**

4. `src/application/primitives/apply-changeset.ts` — enrich the `CHECKOUT_OVERWRITE_DIRTY` producer
   so the class survives (design "Full ripple" / `asMergeDirtyError` class-to-class copy):
   - `evaluateDirtyPath` (`:83`): today returns `FilePath | undefined`. The classification already
     exists in its branches — `update`/`delete` (via `isWorkingTreeDirty`, `:89`-92) is the
     **local-changes** class; `add` (via `isUntrackedClash`, `:93`-95) is the **untracked** class.
     Reshape to return a discriminated `{ readonly class: 'local-changes' | 'untracked'; readonly path: FilePath } | undefined`.
   - `checkDirty` (`:99`): today returns `ReadonlyArray<FilePath>`. Reshape to collect into
     `{ localChanges: FilePath[]; untracked: FilePath[] }` by switching on the returned `class`.
   - `applyChangeset` (`:164`-166): `const dirty = await checkDirty(...); if (dirty.localChanges.length > 0 || dirty.untracked.length > 0) throw checkoutOverwriteDirty(dirty);`.

5. `src/application/commands/internal/working-tree.ts` — the OTHER `CHECKOUT_OVERWRITE_DIRTY`
   producer, `removeFile` (`:89`): two `throw checkoutOverwriteDirty([path])` (`:96`, `:99`) —
   these are remove-of-a-non-file/missing tracked path, the **local-changes** class. Change to
   `throw checkoutOverwriteDirty({ localChanges: [path], untracked: [] })`. (Off the merge path;
   keeps its faithfulness.)

6. `src/application/commands/merge.ts`
   - `asMergeDirtyError` (`:213`-216): today `… ? workingTreeDirty(err.data.paths) : err`. Becomes a
     class-to-class copy: `… ? workingTreeDirty({ localChanges: err.data.localChanges, untracked: err.data.untracked }) : err`.
     (Now that `CHECKOUT_OVERWRITE_DIRTY` carries the two classes, this is a straight pass-through —
     no re-stat. Keeps `merge.test.ts:375` green: `f.txt` in `localChanges`; `:417` green: `m.txt`
     in `untracked`.)
   - The conflict-path producer `writeConflictingWorkingTree` (`:537`-538) STILL throws
     `workingTreeDirty(blockers)` with a flat array TODAY. Adapt MINIMALLY to compile under the new
     signature: `throw workingTreeDirty({ localChanges: [], untracked: blockers })` (an untracked
     squat is the untracked class). **This call site is removed entirely in Slice 2** (it is
     subsumed by the unified pass); for Slice 1 it just needs to compile and keep S7 behaviour.

7. Apply consumers — five `would-overwrite` → `workingTreeDirty` call sites (all read `res.paths`
   today, all become class-keyed pass-throughs):
   - `src/application/commands/cherry-pick.ts:327` and `:394`
   - `src/application/commands/revert.ts:167` and `:385`
   - `src/application/commands/rebase.ts:254`
   Each: `if (res.kind === 'would-overwrite') throw workingTreeDirty({ localChanges: res.localChanges, untracked: res.untracked });`

8. `src/application/commands/internal/clean-work-tree.ts` — `assertCleanWorkTree` (`:73`): today
   `throw workingTreeDirty([...dirty])` where `dirty` is a `Set<FilePath>` of staged + unstaged +
   unmerged TRACKED paths. All tracked → local-changes class:
   `throw workingTreeDirty({ localChanges: [...dirty], untracked: [] })`.
   (git's `require_clean_work_tree` prints the local-changes prose.)

9. `src/application/commands/stash.ts:441` — stash consumes the `would-overwrite` arm via its OWN
   code `stashApplyWouldOverwrite` (flat `{ paths }`, unchanged contract). `result.paths` no longer
   exists; flatten the two classes at the boundary:
   `if (result.kind === 'would-overwrite') throw stashApplyWouldOverwrite([...result.localChanges, ...result.untracked]);`
   (Leave `stash.ts:432`'s `untrackedOverwrites` path untouched — that is a separate flat collector,
   not the `would-overwrite` arm.)

**Tests to update (existing — keep green, two-array shape):**

- `test/unit/domain/commands/error.test.ts`
  - `:79` `workingTreeDirty(['a'])` factory assertion → call `workingTreeDirty({ localChanges: ['a' as FilePath], untracked: [] })`,
    expect `.data` `{ code: 'WORKING_TREE_DIRTY', localChanges: ['a'], untracked: [] }`.
  - `:546` `checkoutOverwriteDirty(['a'])` factory assertion → `checkoutOverwriteDirty({ localChanges: ['a' as FilePath], untracked: [] })`,
    expect `{ code: 'CHECKOUT_OVERWRITE_DIRTY', localChanges: ['a'], untracked: [] }`.
  - `:1115`-1116 renderer case: input `{ code: 'WORKING_TREE_DIRTY', localChanges: ['a' as FilePath], untracked: ['b' as FilePath] }`,
    expect `'WORKING_TREE_DIRTY: working tree has uncommitted changes: 2 files'` (sum of both classes).
  - `:1191`-1192 renderer case: input `{ code: 'CHECKOUT_OVERWRITE_DIRTY', localChanges: ['a' as FilePath], untracked: [] }`,
    expect `'CHECKOUT_OVERWRITE_DIRTY: checkout would overwrite uncommitted changes: 1 file'`.
- `test/unit/application/commands/merge.test.ts`
  - `:407` (clean-path tracked-dirty, scenario name `Given a tracked file the merge would overwrite is locally modified`):
    `expect(data.paths).toContain('f.txt')` → `expect(data.localChanges).toContain('f.txt')` (and assert
    `data.untracked` empty if you want a tighter pin).
  - `:449` (clean-path untracked-add, `Given an untracked file clashes with a theirs-only add`):
    `expect(data.paths).toContain('m.txt')` → `expect(data.untracked).toContain('m.txt')`.
  - `:2628` `asMergeDirtyError (direct)`: `asMergeDirtyError(checkoutOverwriteDirty(['x.txt']))` →
    construct with `checkoutOverwriteDirty({ localChanges: ['x.txt' as FilePath], untracked: [] })`,
    assert `data.localChanges` `['x.txt']`, `data.untracked` `[]`.
- Apply-consumer tests (`cherry-pick.test.ts:1009`/`:1083`, `revert.test.ts:281`/`:385`/`:1049`,
  `rebase.test.ts:507`) assert only the error `code` (`'WORKING_TREE_DIRTY'`) — NO `.paths` read on
  this code (the `.paths` reads at `cherry-pick.test.ts:1220`, `rebase.test.ts:703`,
  `revert.test.ts:1188` are on `MERGE_HAS_CONFLICTS`, unaffected). They should stay green unmodified;
  if any fail to compile, it is a type-only fix (no `.paths` on `WORKING_TREE_DIRTY`).
- Stash tests `stash.test.ts:542`/`:581` assert `STASH_APPLY_WOULD_OVERWRITE { paths }` — UNCHANGED
  contract; the boundary flatten in step 9 keeps `paths: ['a.txt']` / `['new.txt']` byte-identical.

**Tests to add (fold into this slice — they exercise THIS slice's code):**

- `src/application/primitives/find-would-overwrite.ts` gets a new sibling
  `test/unit/application/primitives/find-would-overwrite.test.ts` (the primitive was untested
  directly before — covered transitively via consumers). Cover, with `createMemoryContext`:
  tracked-dirty changed path → `localChanges` populated, `untracked` empty; untracked-present
  changed path → `untracked` populated, `localChanges` empty; both present (non-overlapping) → both
  populated; the ORD2 de-dup invariant (a tracked-dirty path is in `localChanges` only); per-class
  ascending sort (feed `zebra`,`alpha`,`mango` → `[alpha, mango, zebra]`); empty `changedPaths` →
  both arrays empty (identity). Use GWT describe/it split, AAA, `sut` = `findWouldOverwrite`.
- **DG1 dangling-symlink apply check (ADR-343).** Existing apply/stash tests use regular files only;
  the `exists`→`lstat` switch is a behaviour change for dangling symlinks that needs pinning. Add to
  `test/unit/application/commands/stash.test.ts` (near the `STASH_APPLY_WOULD_OVERWRITE` cases at
  `:530`/`:569`): an untracked **dangling** symlink (`ctx.fs.symlink('/nonexistent/target', work)`)
  squatting a stashed untracked path → `stash apply` refuses with `STASH_APPLY_WOULD_OVERWRITE`
  carrying the dangling path (proves `lstat` sees it where `exists` did not). The memory adapter
  (`src/adapters/memory/memory-file-system.ts`) supports `symlink` + a non-following `lstat`
  (`:151`) and a following `stat`/`exists` (`:144` resolves the target), so a dangling-symlink
  squat reproduces the `lstat`-true / `exists`-false split directly in the unit — use
  `ctx.fs.symlink('/nonexistent/target', work(ctx, '<stashed-untracked-path>'))`. (The interop DG1
  row in Slice 2 pins the same against real git on the node adapter; both are required.)
- **Property lens (ADR-342 export + CLAUDE.md case-2 compositional aggregator).** `findWouldOverwrite`
  reduces a changed-path set to a two-class verdict — a fit for the compositional-matcher lens. Ship
  `test/unit/application/primitives/find-would-overwrite.properties.test.ts` with a per-family
  generator in a co-located `arbitraries.ts`: invariants — empty input ⇒ both classes empty
  (identity); a tracked-dirty changed path makes `localChanges` non-empty; an untracked-present
  changed path makes `untracked` non-empty; a path counted in `localChanges` is never in `untracked`
  (ORD2 de-dup). `numRuns` 100 (invariant tier). The oracle must NOT re-implement the production
  loop — assert shape invariants only. `Given` reads "Given an arbitrary changed-path set". This is
  the recommended-if-export-lands property from the design; the export lands here, so ship it.

### TDD steps

- RED: update `error.test.ts:79`/`:546`/`:1115`/`:1191` to the two-array shape → fails to compile
  (`workingTreeDirty`/`checkoutOverwriteDirty` still take a flat array; renderer still reads
  `data.paths`). Reason: union/constructor/renderer not yet reshaped.
- RED: add `find-would-overwrite.test.ts` asserting the `{ localChanges, untracked }` return + sort +
  ORD2 de-dup → fails (the primitive does not exist / still returns a flat array, probe is `exists`).
- GREEN: reshape `domain/commands/error.ts` (union members + both factories), `domain/error.ts`
  (both renderer cases), extract+reshape `find-would-overwrite.ts` (two-array return, `lstat` probe,
  `continue`-guarded mutual exclusion, sorted return), reshape `apply-changeset.ts`
  (`evaluateDirtyPath`/`checkDirty`/`applyChangeset`), `working-tree.ts` `removeFile`,
  `asMergeDirtyError`, the conflict-path `workingTreeDirty` call (`merge.ts:538`), the five apply
  consumer call sites, `assertCleanWorkTree`, the stash `:441` boundary flatten.
- GREEN: update `merge.test.ts:407`/`:449`/`:2628` to the class-keyed assertions.
- GREEN: add the DG1 dangling-symlink apply check + the `find-would-overwrite.properties.test.ts`.
- REFACTOR: confirm the `Stryker disable` justification comments survived the move into the new
  primitive (they are mutation-budget-load-bearing); confirm no duplicated `.sort(comparePaths)`
  across call sites (sort once in the primitive's return). Run `npm run check:types` to flush the
  exhaustiveness switch in `domain/error.ts`. Regenerate `reports/api.json` with `npm run docs:json`
  and stage it.

### Gate

`npx vitest run test/unit/domain/commands/error.test.ts test/unit/domain/error.test.ts test/unit/application/commands/merge.test.ts test/unit/application/commands/cherry-pick.test.ts test/unit/application/commands/revert.test.ts test/unit/application/commands/rebase.test.ts test/unit/application/commands/stash.test.ts test/unit/application/primitives/find-would-overwrite.test.ts test/unit/application/primitives/find-would-overwrite.properties.test.ts && npm run check:types && ./node_modules/.bin/biome check src/domain/commands/error.ts src/domain/error.ts src/application/primitives/find-would-overwrite.ts src/application/primitives/apply-merge-to-worktree.ts src/application/primitives/apply-changeset.ts src/application/commands/internal/working-tree.ts src/application/commands/internal/clean-work-tree.ts src/application/commands/merge.ts src/application/commands/cherry-pick.ts src/application/commands/revert.ts src/application/commands/rebase.ts src/application/commands/stash.ts test/unit/application/primitives/find-would-overwrite.test.ts test/unit/application/primitives/find-would-overwrite.properties.test.ts`

(After the gate, stage the regenerated `reports/api.json` — it is a prepush, not a validate/slice-gate, artefact, but commit it here so the push hook stays green.)

### Commit

`refactor(error): discriminate would-overwrite refusal into localChanges/untracked arrays`

## Slice 2 — Merge conflict-path tracked-dirty guard + interop parity

### Context

This is the FEATURE: `merge`'s conflict write path silently overwrites a tracked,
locally-modified working file; git refuses (exit 2, working tree/index/HEAD untouched, no
`MERGE_HEAD`). Add the conflict-wide would-overwrite guard before any write, using the
shared `findWouldOverwrite` primitive Slice 1 promoted (`src/application/primitives/find-would-overwrite.ts`),
remove the now-subsumed `collectUntrackedRenameBlockers`, and pin parity with the design's
evidence matrix. No public-surface change here (Slice 1 already moved the error shape; the
shared check is internal; `MergeResult`'s conflict arm is unchanged).

**Files & symbols to change (all in `src/application/commands/merge.ts`):**

1. Thread `ours.entries` out of the tree computation. Today `computeMergeTreeResult`
   (`:297`-323) flattens `ourFlat` (`:308`-312) but **discards it** — the conflict arm
   `return { kind: 'conflict', outcomes: result.outcomes, conflicts: result.conflicts }` (`:322`)
   drops `ourFlat`. The `MergeTreeResult` conflict arm type (`:289`-295) is
   `{ readonly kind: 'conflict'; readonly outcomes: ReadonlyArray<MergeOutcome>; readonly conflicts: ReadonlyArray<MergeConflict> }`.
   Add `readonly ours: ReadonlyMap<FilePath, { readonly id: ObjectId; readonly mode: FileMode }>`
   to that arm and populate it from `ourFlat.entries` (the exact map shape `changedPaths` /
   `outcomeChangesOurs` consume — verified against `apply-merge-to-worktree.ts:103`). `ourFlat`
   is `Awaited<ReturnType<typeof flattenTree>>`; its `.entries` is that map.

2. Add the guard in `persistConflictState` (`:430`-465), BEFORE `acquireIndexLock` (`:443`) and
   after `rejectUnsupportedConflicts` (`:437`) — mirroring how `rejectUnsupportedConflicts` already
   runs lock-free and pre-write (R7). The `result` param is
   `Extract<MergeTreeResult, { readonly kind: 'conflict' }>`, so after step 1 it carries `ours`.
   - `const currentIndex = await readIndex(ctx);` (`readIndex` is already imported, `merge.ts:45`;
     used in `materialiseNonConflictTree` `:229`). Pure, lock-free.
   - `const changed = changedPaths(result.outcomes, result.conflicts, result.ours);`
   - `const { localChanges, untracked } = await findWouldOverwrite(ctx, changed, currentIndex);`
   - `if (localChanges.length > 0 || untracked.length > 0) throw workingTreeDirty({ localChanges, untracked });`
     (`workingTreeDirty` already imported `merge.ts:1`; the returned arrays are sorted by the
     primitive per Slice 1.)
   Import `changedPaths` + `findWouldOverwrite` from `../primitives/find-would-overwrite.js`.

3. **Remove `collectUntrackedRenameBlockers`** (`:505`-526) and `isUntrackedBlocker` (`:494`-503,
   its only caller). In `writeConflictingWorkingTree` (`:528`-552) delete the pre-flight at
   `:534`-538 (`const blockers = await collectUntrackedRenameBlockers(...); if (blockers.length > 0) throw workingTreeDirty(...)`).
   The unified guard in `persistConflictState` (step 2) subsumes it: distinct-types rename targets
   are in `changedPaths`'s `recordedPaths`, and the untracked branch's `lstat` probe (ADR-343)
   flags an untracked squat — preserving S7/S7b/DG1. The flat-shape `workingTreeDirty` adapter you
   added to `merge.ts:538` in Slice 1 disappears with this deletion.

4. Sparse (R6): NO change. `writeConflictToTree` (`:549`-551) already takes no matcher; a
   sparse-excluded path is `absent` on disk so `compareWorkingTreeEntry` → `absent` →
   `isWorkingTreeModified` false → the guard skips it (SP1).

**Pinned behaviour the guard must reproduce (do NOT re-pin — from the design's matrix, real git
2.54.0 ort):**

- Refusal is exit 2, atomic, pre-write: working tree + index + HEAD untouched, NO `MERGE_HEAD`
  written, no `index.lock` leaked (S13, M1, M2, CL1, TC1).
- `localChanges` block is reported first, ascending-sorted; `untracked` second (ORD1). M1: add-order
  `zebra`,`alpha`,`mango` → `localChanges` = `[alpha.txt, mango.txt, zebra.txt]`.
- An ORD2 overlap (tracked-dirty path that is also a distinct-types rename target) resolves to
  `localChanges` only, `untracked` empty.
- M3 (dirty path untouched by the merge) → NO refusal, conflict materialises, `MERGE_HEAD` written.
- SP1 (sparse-excluded conflict path) → NO refusal, conflict materialised, `MERGE_HEAD` written.

**Interop test (new — fold into this slice).** `test/integration/merge-tracked-dirty-conflict-refusal-interop.test.ts`,
modelled on `test/integration/merge-conflict-interop.test.ts` (read it for the exact harness):
- Helpers from `test/integration/interop-helpers.ts`: `GIT_AVAILABLE`, `makePeerPair`, `PeerPair`,
  `runGit`, `runGitEnv`, `tryRunGit`, `lsStage`. Reuse the `merge-conflict-interop.test.ts` private
  helpers `writeBoth`/`commitBoth`/`branchBoth`/`checkoutBoth`/`read`/`divergeFile`/`mergeBothConflict`
  (copy the ones you need; they are file-local there). `COMMIT_ENV` / `AUTHOR` block as in that file.
- Peer pinned `-c merge.conflictStyle=merge` (host global may be diff3); merge is
  `git merge --no-ff -m m theirs`. `describe.skipIf(!GIT_AVAILABLE)`. `beforeEach`/`afterEach`
  init/dispose the peer + tsgit `openRepository({ cwd: pair.ours })`.
- Per ADR-249, reconstruct git's two prose blocks FROM the structured
  `WORKING_TREE_DIRTY { localChanges, untracked }` + the captured peer exit/stderr — `localChanges`
  → `error: Your local changes to the following files would be overwritten by merge:` +
  `Please commit your changes or stash them before you merge.`; `untracked` →
  `error: The following untracked working tree files would be overwritten by merge:` +
  `Please move or remove them before you merge.`; each block's paths rendered ascending,
  local-changes block first. The library itself emits NO display string.
- Rows to cover (one describe per row, GWT split): **S13** (single tracked-dirty content conflict —
  both refuse, tsgit `localChanges = ['file.txt']`, `untracked = []`, worktree bytes + `lsStage` +
  HEAD unchanged on both, NO `MERGE_HEAD`); **M1** (two tracked-dirty conflict paths, sort order);
  **M2/CL1** (clean-but-changed theirs-only path that is dirty during an otherwise-conflicting
  merge — refuses on the clean path in `localChanges`, no markers, no `MERGE_HEAD`); **M3** (dirty
  untouched path — no refusal, `MERGE_HEAD` written, dirty bytes survive); **TC1** (distinct-types
  conflict at a tracked-dirty path — refuses with `conflict.path` in `localChanges`); **S7/S7b**
  (untracked-add and distinct-types untracked rename-target squat — refuse with the path in
  `untracked`, `localChanges = []`; re-pins the untracked refusal now routes through the unified
  pass); **ORD1** (tracked-dirty conflict path AND non-overlapping untracked squat — both arrays
  populated in one refusal; reconstruct stderr local-changes-first, byte-match the peer); **ORD2**
  (tracked-dirty conflict path AND overlapping distinct-types untracked rename target — `localChanges`
  carries the path, `untracked = []`); **DG1** (untracked dangling symlink squatting a distinct-types
  rename target — both refuse, dangling path in `untracked`; pins the `lstat` probe); **SP1**
  (sparse-excluded conflict path — no refusal, conflict materialised, `MERGE_HEAD` written).
  (DG1 + SP1 require symlink / cone-sparse setup; build them on the real-git peer + node adapter —
  the memory adapter is not used in `test/integration`.)

**Unit twins (new — fold into this slice).** In `test/unit/application/commands/merge.test.ts`,
add alongside the existing clean-path tests (`Given a tracked file the merge would overwrite is
locally modified` `:373`, `Given an untracked file clashes with a theirs-only add` `:415`,
`Given a dirty-worktree merge refusal acquired the index lock` `:457`). Use `createMemoryContext`,
the file-local helpers `init`/`add`/`commit`/`branchCreate`/`checkout` (already imported at top of
file), `mergeRun`, `readIndex`, `resolveRef`. New describes:
- `Given a tracked file the conflicting merge would overwrite is locally modified` → refuses with
  `WORKING_TREE_DIRTY`, `data.localChanges` contains the dirty conflict path, HEAD at ours tip,
  dirty bytes unchanged, NO `MERGE_HEAD` on disk (`!(await ctx.fs.exists(\`${ctx.layout.gitDir}/MERGE_HEAD\`))`).
  This is the conflict-path twin of `:375` — drift a path that *conflicts* (both sides change),
  not one that clean-merges. (S13.)
- Conflict-path index-lock release: the conflict-path twin of `:457`/`:459` — after a conflict-path
  tracked-dirty refusal, a follow-up `add` is not `RESOURCE_LOCKED` (no leaked `index.lock`).
- Guard-isolation (CLAUDE.md "guard clauses need isolated tests" — the guard is
  `if (localChanges.length > 0 || untracked.length > 0)`): THREE separate tests so each disjunct is
  proven alone — (a) tracked-dirty conflict path ONLY → `localChanges` populated, `untracked` empty,
  refuses; (b) untracked squat ONLY (distinct-types rename target) → `untracked` populated,
  `localChanges` empty, refuses; (c) a non-touched dirty path (untouched by either side) → NO
  refusal, merge produces the conflict (M3). One test triggering both disjuncts does not prove each
  guard alone.

**Existing suites kept green (verify, don't rewrite):** `merge-interop`, `merge-conflict-interop`,
`merge-driver-interop`, `distinct-types-with-base-interop` (S7 row), `cherry-pick`/`revert`/`rebase`/
`stash` interop — refusal-condition / which-paths-refuse axis unchanged for regular-file cases. The
removal of `collectUntrackedRenameBlockers` must NOT change S7/S7b output (the unified pass covers
the same targets via `recordedPaths` + `lstat`).

### TDD steps

- RED: add the merge.test.ts conflict-path tracked-dirty refusal twin (S13) → fails: today the
  conflict path has no guard, so the merge returns `{ kind: 'conflict' }` and overwrites the dirty
  file (the `MERGE_HEAD`-absent / dirty-bytes-intact assertions fail). Reason: no conflict-wide
  guard before the lock.
- RED: add the guard-isolation (a)/(b)/(c) twins and the lock-release twin → (a)/(b) fail (no
  refusal yet); (c) passes already (proves the guard must NOT over-fire — keep it).
- RED: add the interop rows (S13, M1, M2/CL1, TC1, S7/S7b, ORD1, ORD2, DG1, SP1; M3 is no-refusal)
  → the refusal rows fail (tsgit returns conflict instead of refusing / overwrites bytes).
- GREEN: thread `ours` through `MergeTreeResult`'s conflict arm + `computeMergeTreeResult`; add the
  `readIndex` + `changedPaths` + `findWouldOverwrite` + `workingTreeDirty` guard in
  `persistConflictState` before `acquireIndexLock`.
- GREEN: remove `collectUntrackedRenameBlockers` + `isUntrackedBlocker` + their call in
  `writeConflictingWorkingTree`; re-run S7/S7b interop to confirm the unified pass preserves them.
- REFACTOR: confirm the guard fires before `acquireIndexLock` (no lock to leak on refusal);
  confirm `persistConflictState`'s try/finally lock ceremony is unchanged for the non-refusal path;
  confirm no dead import remains after the `collectUntrackedRenameBlockers` removal. Run
  `npm run check:types`.

### Gate

`npx vitest run test/unit/application/commands/merge.test.ts test/integration/merge-tracked-dirty-conflict-refusal-interop.test.ts test/integration/merge-conflict-interop.test.ts test/integration/distinct-types-with-base-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/commands/merge.ts test/unit/application/commands/merge.test.ts test/integration/merge-tracked-dirty-conflict-refusal-interop.test.ts`

### Commit

`fix(merge): refuse a conflicting merge that would overwrite tracked dirty paths`

---

## Phase-boundary gate (run once after the last slice, not per-slice)

`npm run validate`

(Plus the prepush surface gate `check:doc-typedoc` is satisfied by Slice 1's committed
`reports/api.json` regen.)
