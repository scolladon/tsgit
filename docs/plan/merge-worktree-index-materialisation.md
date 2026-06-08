# Plan — `merge` worktree + index materialisation

TDD, one slice = one atomic commit. `npm run validate` green before every commit.
All edits in `src/application/commands/merge.ts` + `test/unit/application/commands/merge.test.ts`,
plus a new `test/integration/merge-interop.test.ts`.

Shared private glue added in slice 1 (returns the index entries — the caller
owns `lock.commit`, so the helper needs no lock-type plumbing), reused by slice 2,
hardened with the dirty remap in slice 3:

```ts
// merge.ts (private) — slice 1 shape
const materialiseNonConflictTree = async (
  ctx: Context,
  targetTree: ObjectId,
): Promise<ReadonlyArray<IndexEntry>> => {
  const currentIndex = await readIndex(ctx);
  const result = await materializeTree(ctx, { targetTree, currentIndex, force: false });
  return result.newIndexEntries;
};
```

The dirty remap (`CHECKOUT_OVERWRITE_DIRTY` → `WORKING_TREE_DIRTY`) is added in
**slice 3 together with its tests** — never earlier, or the new `catch` branch
would be uncovered and fail the 100%-coverage gate.

New imports: `readIndex` (`../primitives/read-index.js`), `materializeTree`
(`../primitives/materialize-tree.js`), `workingTreeDirty` (added to the existing
`../../domain/commands/error.js` import), `TsgitError` (`../../domain/error.js`).
`acquireIndexLock` and `IndexEntry` are already imported.

---

## Slice 1 — clean true-merge materialises the worktree + index

**Red** — add to `merge.test.ts`, `describe('Given diverged histories …')`:

1. `Given a theirs-only add, When merge, Then the working tree + index gain the file`
   — base `f.txt`; ours `+a.txt`; theirs `+m.txt`; merge theirs. Assert
   `ctx.fs.exists(workDir/m.txt)` is true, `readIndex` paths include `m.txt`
   (and `a.txt`, `f.txt`), and the merged-commit tree is unchanged (regression).
2. `Given a theirs-side edit, When merge, Then the working file holds the merged bytes`
   — base 3-line file; ours edits line 1; theirs edits line 3; assert worktree
   file == combined bytes and index id == merged blob id.
3. `Given a theirs-side delete, When merge, Then the working file is removed`
   — base `a+b`; ours touches `c`; theirs deletes `a`; assert `!exists(a)` and
   index lacks `a`.

Run `npx vitest run test/unit/application/commands/merge.test.ts` — the three
new assertions fail (worktree/index untouched today).

**Green** — rewrite `commitCleanMerge` to wrap the commit in the index lock and
materialise the merged tree first:

```ts
const lock = await acquireIndexLock(ctx);
try {
  const entries = await materialiseNonConflictTree(ctx, mergedTree);
  await lock.commit(entries);
  const id = await createCommit(ctx, commitData);
  await updateRef(ctx, branchName, id, { expected: ourId, reflogMessage });
  return { kind: 'merge', id, branch: branchName, parents: [ourId, theirId] };
} finally {
  await lock.release();
}
```

(`force: false` doesn't throw on the clean worktrees these tests use.) Re-run →
green. `npm run validate`.

**Commit** `fix(merge): materialise clean true-merge to working tree and index`

---

## Slice 2 — fast-forward materialises the worktree + index

**Red** — `merge.test.ts`, near the existing FF test:

- `Given an ancestor target adding a file, When merge fast-forwards, Then the working tree + index gain it`
  — base `f.txt`; feature `+m.txt`; main stays at base; merge feature. Assert
  `exists(m.txt)`, index includes `m.txt`, result.kind === 'fast-forward'.

Run the file — fails (FF leaves worktree/index stale).

**Green** — in `mergeRun`'s FF branch, materialise the new tip's tree under the
lock before moving the ref:

```ts
if (base === ourId) {
  if (opts.fastForward !== 'never') {
    const lock = await acquireIndexLock(ctx);
    try {
      const entries = await materialiseNonConflictTree(ctx, await getTree(ctx, theirId));
      await lock.commit(entries);
      await updateRef(ctx, head.target, theirId, { expected: ourId, reflogMessage });
    } finally {
      await lock.release();
    }
    return { kind: 'fast-forward', id: theirId, branch: head.target };
  }
}
```

Re-run → green. `npm run validate`.

**Commit** `fix(merge): materialise fast-forward to working tree and index`

---

## Slice 3 — dirty-worktree refusal surfaces `workingTreeDirty`

**Red** — `merge.test.ts`, two isolated guard tests (one per `checkDirty`
branch — see CLAUDE.md "Guard clauses need isolated tests"):

1. `Given a tracked path the merge would overwrite is locally modified, When merge, Then it refuses with WORKING_TREE_DIRTY and leaves HEAD/index/worktree unchanged`
   — clean true-merge where theirs edits `f.txt`; before merging, write drifted
   bytes to `workDir/f.txt`. try/catch the `mergeRun`; assert
   `err.data.code === 'WORKING_TREE_DIRTY'`, `err.data.paths` contains `f.txt`,
   the branch ref still points at the pre-merge tip, and the drifted bytes
   survive on disk.
2. `Given an untracked file clashes with a theirs-only add, When merge, Then it refuses with WORKING_TREE_DIRTY`
   — theirs adds `m.txt`; pre-write an untracked `workDir/m.txt`; assert the same
   code + path and that the untracked bytes survive.

Run — they fail (today the merge throws `CHECKOUT_OVERWRITE_DIRTY` from
`materializeTree`, or — pre-slice-1 — silently succeeds).

**Green** — wrap the `materializeTree` call inside `materialiseNonConflictTree`
and remap the checkout code to the merge-family code (its final form):

```ts
const materialiseNonConflictTree = async (
  ctx: Context,
  targetTree: ObjectId,
): Promise<ReadonlyArray<IndexEntry>> => {
  const currentIndex = await readIndex(ctx);
  try {
    const result = await materializeTree(ctx, { targetTree, currentIndex, force: false });
    return result.newIndexEntries;
  } catch (err) {
    if (err instanceof TsgitError && err.data.code === 'CHECKOUT_OVERWRITE_DIRTY') {
      throw workingTreeDirty(err.data.paths);
    }
    throw err;
  }
};
```

Re-run → green. `npm run validate`.

**Commit** `fix(merge): refuse dirty-worktree merge with workingTreeDirty`

---

## Slice 4 — interop faithfulness suite

**Red→Green** (test-only; new `test/integration/merge-interop.test.ts`, twin
git peer / tsgit ours per `interop-helpers`, `openRepository` over a real tmpdir,
guarded by `GIT_AVAILABLE`):

- **fast-forward** — build base+feature in both, `git merge --ff-only feature`
  (peer) / `repo.merge({ rev: 'feature' })` (ours); assert `writeTreeOf(peer) ===
  writeTreeOf(ours)`, `lsStage(peer) === lsStage(ours)`, and `m.txt` bytes equal
  on disk.
- **clean true-merge** — base/ours/theirs with a theirs-only add, a theirs-side
  edit, and a combined content merge; `git merge --no-ff` / `repo.merge`; assert
  the same index parity (`writeTreeOf` + `lsStage`), on-disk file bytes, and the
  merge-commit tree id equality.
- **dirty co-refusal** — drift a to-be-overwritten path in both worktrees;
  `tryRunGit(['-C', peer, 'merge', …])` must be `ok: false` and `repo.merge` must
  throw `WORKING_TREE_DIRTY`; assert both HEAD refs + indexes are unchanged.

`npm run validate`.

**Commit** `test(merge): interop worktree+index parity for non-conflict outcomes`

---

## Then (workflow steps 6–9)

- Reviews ×3 (typescript / security / tests), fix-all-converge.
- Architecture refactor pass (seeded by the diff): consider whether
  `materialiseNonConflictTree` should be shared, whether the
  `CHECKOUT_OVERWRITE_DIRTY`→`WORKING_TREE_DIRTY` remap belongs in a shared seam.
  May be a no-op with justification.
- Mutation: `stryker run --mutate src/application/commands/merge.ts`; 0 killable.
- Docs: flip BACKLOG `26.2a` → `[x]`; refresh merge docs/README if they claim
  merge is data-only; PR.
