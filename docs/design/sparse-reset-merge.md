# Sparse-checkout awareness in `reset` / `merge` — Design (Phase 17.3a)

> Status: Draft. Backlog item **17.3a** — "Sparse-checkout awareness in
> `reset --hard` / `reset --mixed` / `merge`". Follows up the deferral recorded
> in [ADR-073](../adr/073-sparse-integration-scope.md). New ADRs: 075, 076.

## 1. Goal & scope

Phase 17.3 made `checkout`, `status` and `add --all` honour `core.sparseCheckout`
but **deferred** `reset --hard`, `reset --mixed` and `merge`
([ADR-073](../adr/073-sparse-integration-scope.md)). In a sparse repository
those three commands today re-materialise excluded files and drop their
skip-worktree bits — a documented sharp edge, recoverable with
`repo.sparseCheckout({ action: 'reapply' })`.

17.3a closes that gap. After this phase, every working-tree-rewriting command
honours the sparse matcher: an excluded path is never written to disk and its
index entry always carries `skipWorktree: true`.

### In scope

- **`reset --hard`** — thread the sparse matcher into its `materializeTree` call.
- **`reset --mixed`** — thread the sparse matcher into `buildIndexFromTree` so
  the rebuilt index carries skip-worktree bits.
- **`merge`** (conflicting-merge path) — excluded paths that merge cleanly are
  not re-materialised; their conflict-state index entries carry skip-worktree.

### Explicitly out of scope

- **`checkout`** — already sparse-aware (17.3, [§8 of sparse-checkout.md](./sparse-checkout.md)).
  Untouched.
- **`status` / `add --all`** — already skip-worktree aware (17.3). Untouched.
- **`reset --soft`** — moves HEAD only; touches neither index nor working tree.
  Nothing to integrate.
- **The clean-merge path** (`commitCleanMerge`) — a fast-forward-or-true merge
  that resolves cleanly creates the merge commit and moves the branch ref; it
  writes **neither** the index **nor** the working tree (see §5.1). There is no
  materialisation to make sparse-aware.
- **The sparse-index optimization** — unchanged from 17.3's deferral.

## 2. Background — git's behaviour & the existing seams

git routes `checkout`, `reset`, `merge` through `unpack-trees`, which is
sparse-aware: a path whose skip-worktree bit is set is neither written nor
removed from the working tree; the index keeps every path.

tsgit does not have a single `unpack-trees`; each command composes primitives.
17.3 deliberately built the integration seam **into the primitives** so the
follow-up would be wiring, not redesign:

- **`materializeTree`** (`src/application/primitives/materialize-tree.ts`)
  already accepts an optional `sparse?: SparseMatcher`. When supplied it
  partitions the target tree into in-pattern / excluded, writes only in-pattern
  files, and synthesises one `skipWorktree: true` index entry per excluded
  path. `checkout` already passes it; `reset --hard` does not — yet.
- **`loadSparseMatcher`** (`src/application/primitives/read-sparse-checkout.ts`)
  returns the matcher when `core.sparseCheckout` is true, `undefined` otherwise.
  It is a pure read over config + the pattern file — no index lock required.

Two seams are **missing** and 17.3a adds them:

- **`buildIndexFromTree`** (the `reset --mixed` index rebuilder) has no sparse
  parameter — it always emits `STAGE0_FLAGS` (skip-worktree clear).
- **`merge`'s conflicting-merge working-tree write** (`writeConflictingWorkingTree`)
  re-materialises every outcome path unconditionally.

## 3. `reset --hard`

`hardResetFromCommit` (`reset.ts`) already calls `materializeTree` with
`force: true, forceRewriteAll: true`. The change mirrors `checkout`'s
`switchBranch` exactly:

```ts
const hardResetFromCommit = async (ctx, commitId) => {
  const commit = await readObject(ctx, commitId);
  if (commit.type !== 'commit') throw unexpectedObjectType('commit', commit.type, commitId);
  // loadSparseMatcher is a pure config/file read — no lock needed, call before.
  const matcher = await loadSparseMatcher(ctx);
  const lock = await acquireIndexLock(ctx);
  try {
    const currentIndex = await readIndex(ctx);
    const result = await materializeTree(ctx, {
      targetTree: commit.data.tree,
      currentIndex,
      force: true,
      forceRewriteAll: true,
      ...(matcher !== undefined ? { sparse: matcher } : {}),
    });
    if (result.written > 0 || result.deleted > 0 || matcher !== undefined) {
      await lock.commit(result.newIndexEntries);
    }
  } finally {
    await lock.release();
  }
};
```

Two points:

- **Spread-when-defined.** `exactOptionalPropertyTypes` forbids assigning
  `sparse: undefined`; the conditional spread matches `checkout.ts`.
- **The commit guard gains `|| matcher !== undefined`.** Without sparse, the
  guard `written > 0 || deleted > 0` skips the index commit only in the
  degenerate empty-tree case. **With** sparse active the index can change while
  `written` and `deleted` are both `0` — every target path is excluded, so
  nothing is written, yet the synthesised skip-worktree entries differ from the
  pre-reset index (e.g. excluded paths whose `id` changed between commits).
  Skipping the commit would leave a stale index. `checkout` already commits
  unconditionally for this exact reason ([§8 of sparse-checkout.md](./sparse-checkout.md));
  `reset --hard` keeps its narrower guard for the non-sparse case and widens it
  only when a matcher exists.

`materializeTree`'s `sparse` semantics (excluded path → not written, not
deleted, synthesised skip-worktree entry; in-pattern path → normal
add/update/delete) are unchanged — `reset --hard` inherits `checkout`'s exact
behaviour, including the dirty-out-of-cone-file handling.

## 4. `reset --mixed` — `buildIndexFromTree` gains a sparse parameter

`reset --mixed` rebuilds the index from the target commit's tree **without
touching the working tree**. In a sparse repo the working tree already holds
only in-pattern files, so the rebuilt index must mark every excluded path
`skipWorktree: true` — otherwise `status` would report every excluded file as
`deleted`.

`buildIndexFromTree` gains an optional `sparse?: SparseMatcher`:

```ts
export interface BuildIndexFromTreeOpts {
  readonly targetTree: ObjectId;
  readonly currentIndex: GitIndex;
  readonly sparse?: SparseMatcher;
}
```

`projectLeaf` becomes:

```ts
const projectLeaf = (leaf, donors, sparse): IndexEntry => {
  if (sparse !== undefined && !sparse(leaf.path)) {
    return skipWorktreeEntry(leaf);                 // zeroed stat, skipWorktree: true
  }
  const donor = donors.get(leaf.path);
  const matches = donor !== undefined && donor.id === leaf.id && donor.mode === leaf.mode;
  if (!matches) return zeroStatEntry(leaf);
  return { ...donor, flags: includedFlags(donor.flags, sparse) };
};

// When sparse is active an in-pattern path must have a CLEAR skip-worktree bit
// — the donor may carry a stale one (the path was excluded before this reset).
// When sparse is inactive the donor flags are preserved verbatim (today's
// behaviour: a manually-set `git update-index --skip-worktree` bit survives).
const includedFlags = (donorFlags, sparse) =>
  sparse !== undefined
    ? { ...donorFlags, stage: 0 as const, skipWorktree: false }
    : { ...donorFlags, stage: 0 as const };
```

**Decision — the matcher is authoritative over the donor's skip-worktree bit**
([ADR-075](../adr/075-reset-sparse-integration.md)). When sparse is active,
`skipWorktree` is `!matcher(path)`, full stop. An excluded path is rebuilt as a
zero-stat skip-worktree entry (the donor's stats are meaningless — the file is
not on disk); an in-pattern path clears any stale skip-worktree bit. When
sparse is **inactive** (`sparse === undefined`) the donor's flags pass through
unchanged — a non-sparse repo where the user manually set a skip-worktree bit
keeps it, exactly as today.

`rebuildIndexFromCommit` threads the matcher in:

```ts
const matcher = await loadSparseMatcher(ctx);   // before the lock
const lock = await acquireIndexLock(ctx);
try {
  const currentIndex = await readIndex(ctx);
  const newEntries = await buildIndexFromTree(ctx, {
    targetTree: commit.data.tree,
    currentIndex,
    ...(matcher !== undefined ? { sparse: matcher } : {}),
  });
  await lock.commit(newEntries);
} finally { await lock.release(); }
```

## 5. `merge`

### 5.1 The clean-merge path writes nothing — no change

`commitCleanMerge` creates the merge commit and advances the branch ref. It
does **not** write the index or the working tree (a tsgit caller re-syncs with
a subsequent `checkout`/`reset`). With nothing materialised there is nothing to
make sparse-aware. A clean merge in a sparse repo is already correct: HEAD
moves, skip-worktree bits are untouched, the next `checkout`/`reset` re-syncs.

### 5.2 The conflicting-merge path

`persistConflictState` → `writeConflictingWorkingTree` writes **every** outcome
path to the working tree (`writeOutcomeToTree`) plus the conflict markers
(`writeConflictToTree`), and `buildConflictIndexEntries` builds the index. In a
sparse repo this re-materialises excluded files — the 17.3a bug.

The fix threads the matcher through `persistConflictState`:

```ts
const matcher = await loadSparseMatcher(ctx);   // before acquireIndexLock
```

Three integration points:

1. **`writeOutcomeToTree`** — for the clean write statuses (`unchanged`,
   `resolved-known`, `resolved-merged`), an excluded path is **not written**.
   `resolved-deleted` needs no guard: an excluded file is already absent, and
   `removeWorkingTreeFile`'s `exists` check makes the call a no-op.

2. **`writeConflictToTree`** — **always writes**, even for an excluded path.
   **Decision** ([ADR-076](../adr/076-merge-conflict-materialization.md)): a
   genuine merge conflict must be materialised so the user can resolve it. A
   conflict's index rows are stages 1/2/3 — `skipWorktree` is a stage-0-only
   flag and does not apply. git itself materialises conflicted entries
   regardless of skip-worktree. Hiding a conflict the user must resolve by hand
   would be a worse failure than a transiently-visible out-of-cone file.

3. **`buildConflictIndexEntries`** — the stage-0 entries it emits for clean
   `unchanged` / `resolved-known` outcomes get `skipWorktree: true` when the
   matcher excludes the path (so `status` does not report the un-written file
   as `deleted`). Conflict stage-1/2/3 rows are unchanged. `resolved-merged`
   outcomes are already excluded from this index (pre-existing behaviour).

After the user resolves the conflict and `repo.add`s the path, `add` (already
skip-worktree aware, 17.3) takes over; 17.3a does not touch the resolution path.

## 6. Shared helper — `skipWorktreeEntry`

`materialize-tree.ts` has a file-private `skipWorktreeEntry(TargetEntry)`
builder. `build-index-from-tree.ts` needs the identical thing. Rather than
duplicate a ~14-line object literal (which `check:duplicates` would flag), the
builder is **promoted to the domain**:

```ts
// src/domain/git-index/index-entry.ts
/** Build a stage-0 index entry for a tree path that is absent from the working
 *  tree: zeroed stat fields, `skipWorktree` set. `status` skips skip-worktree
 *  entries, so the zeroed stats are never consulted. */
export const skipWorktreeEntry = (
  entry: { readonly path: FilePath; readonly id: ObjectId; readonly mode: FileMode },
): IndexEntry => ({
  ctimeSeconds: 0, ctimeNanoseconds: 0, mtimeSeconds: 0, mtimeNanoseconds: 0,
  dev: 0, ino: 0, mode: entry.mode, uid: 0, gid: 0, fileSize: 0,
  id: entry.id, flags: { ...STAGE0_FLAGS, skipWorktree: true }, path: entry.path,
});
```

The parameter is a structural `{ path, id, mode }` so both `materialize-tree`'s
`TargetEntry` and `build-index-from-tree`'s `TargetLeaf` satisfy it and the
existing point-free `plan.excluded.map(skipWorktreeEntry)` call site in
`materialize-tree.ts` is preserved unchanged. `materialize-tree.ts` deletes its
local copy and imports the domain helper.

## 7. File layout & changes

| File | Change |
|------|--------|
| `src/domain/git-index/index-entry.ts` | NEW export `skipWorktreeEntry` |
| `src/domain/git-index/index.ts` | re-export `skipWorktreeEntry` |
| `src/application/primitives/materialize-tree.ts` | drop local `skipWorktreeEntry`, import the domain one |
| `src/application/primitives/build-index-from-tree.ts` | `sparse?` opt; `projectLeaf` + `includedFlags` honour it |
| `src/application/commands/reset.ts` | `loadSparseMatcher` → `materializeTree` (hard) + `buildIndexFromTree` (mixed); widen the hard commit guard |
| `src/application/commands/merge.ts` | `loadSparseMatcher` → `writeOutcomeToTree` / `buildConflictIndexEntries` |
| `docs/design/sparse-checkout.md` | flip the 17.3a "out of scope" note to "delivered in 17.3a" |
| `docs/adr/073-*` | note resolution in 17.3a |
| `README.md`, `RUNBOOK.md` | drop the "reset/merge re-materialise excluded files" sharp-edge note |
| `docs/BACKLOG.md` | flip 17.3a → `[x]` |

No new files. No port/adapter changes. No public-API surface change other than
the two new optional `sparse?` primitive options.

## 8. Testing strategy

**Conventions** (CLAUDE.md): `Given/When/Then` titles, AAA body, `sut`, 100%
line/branch/function/statement coverage, 0 surviving mutants.

### Unit

- **`skipWorktreeEntry`** (`domain/git-index`) — zeroed stats, `skipWorktree`
  true, `stage` 0, `id`/`mode`/`path` copied from the argument.
- **`buildIndexFromTree`** —
  - `sparse` omitted → byte-identical to today (the existing suite already
    covers this; no regression).
  - `sparse` excludes a path → entry has `skipWorktree: true` and zeroed stats,
    even when a matching donor with real stats exists (kills the
    "donor authoritative" mutant).
  - `sparse` includes a path whose donor carries a stale `skipWorktree: true`
    → entry has `skipWorktree: false`, donor stats preserved.
  - `sparse` includes a path with a matching donor → stats preserved,
    `skipWorktree: false`.
  - separate tests for the `sparse !== undefined` guard in `projectLeaf` and in
    `includedFlags` (each guard exercised independently).
- **`reset`** — `reset --hard` / `reset --mixed` with sparse active vs inactive;
  the widened commit guard with a fully-excluded target tree.
- **`merge`** — `writeOutcomeToTree` skips an excluded clean outcome;
  `writeConflictToTree` writes an excluded conflict; `buildConflictIndexEntries`
  sets `skipWorktree` on an excluded stage-0 entry. Each matcher branch
  (active / inactive) tested independently.

### Integration (`test/integration`)

- `reset --hard` in a sparse repo: excluded files stay absent, in-pattern files
  re-materialise, `status` clean afterwards.
- `reset --mixed` in a sparse repo: the rebuilt index carries skip-worktree
  bits; `status` does not report excluded paths as deleted.
- A conflicting `merge` in a sparse repo: excluded clean paths stay absent, the
  conflicted path is materialised with markers.
- Non-sparse `reset` / `merge` regression: behaviour byte-identical to today.

### Interop

Extend the existing sparse interop coverage if a real-`git` harness is present:
canonical `git` must accept the index `reset --mixed` writes in a sparse repo
(v3, skip-worktree bits). The 17.3 interop tests already prove tsgit's v3 index
round-trips; 17.3a adds the `reset --mixed`-produced index to that proof.

### Mutation

`stryker run` over the four touched files. Equivalent mutants accepted only
with an inline `// equivalent-mutant:` justification, per CLAUDE.md.

## 9. Key design decisions

1. **Wiring, not redesign.** 17.3 built the seams; 17.3a passes the matcher
   through. The only genuinely new logic is `buildIndexFromTree`'s sparse
   branch and `merge`'s three integration points.
2. **The matcher is authoritative over donor skip-worktree bits in `reset --mixed`**
   ([ADR-075](../adr/075-reset-sparse-integration.md)).
3. **Merge conflicts are materialised even for excluded paths**
   ([ADR-076](../adr/076-merge-conflict-materialization.md)) — a conflict the
   user cannot see is unresolvable.
4. **The `reset --hard` commit guard widens only under sparse** — non-sparse
   behaviour is byte-identical; the index is committed unconditionally when a
   matcher exists, matching `checkout`.
5. **`skipWorktreeEntry` lives in the domain** — one builder, two primitives,
   no duplication.

## 10. ADR index

| ADR | Title |
|-----|-------|
| [073](../adr/073-sparse-integration-scope.md) | 17.3 defers reset/merge — the deferral it records is **resolved** here (not superseded; the planned follow-up is delivered) |
| [075](../adr/075-reset-sparse-integration.md) | `reset` sparse integration — matcher authoritative over donor bits |
| [076](../adr/076-merge-conflict-materialization.md) | `merge` materialises conflicts even for excluded paths |
