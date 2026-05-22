import { describe, expect, it } from 'vitest';

import { materializeTree } from '../../../../src/application/primitives/materialize-tree.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import { writeTree } from '../../../../src/application/primitives/write-tree.js';
import type { GitIndex, IndexEntry } from '../../../../src/domain/git-index/index.js';
import { STAGE0_FLAGS } from '../../../../src/domain/git-index/index.js';
import { FILE_MODE } from '../../../../src/domain/objects/file-mode.js';
import type { FilePath, ObjectId, TreeEntry } from '../../../../src/domain/objects/index.js';
import { recordingProgress } from '../commands/fixtures.js';
import { buildSeededContext } from './fixtures.js';

const EMPTY_INDEX: GitIndex = { version: 2, entries: [], extensions: [] };

const writeBlob = async (
  ctx: Awaited<ReturnType<typeof buildSeededContext>>,
  content: string,
): Promise<ObjectId> =>
  writeObject(ctx, {
    type: 'blob',
    content: new TextEncoder().encode(content),
    id: '' as ObjectId,
  });

const makeIndexEntry = (path: string, id: ObjectId, stage: 0 | 1 | 2 | 3 = 0): IndexEntry => ({
  ctimeSeconds: 0,
  ctimeNanoseconds: 0,
  mtimeSeconds: 0,
  mtimeNanoseconds: 0,
  dev: 0,
  ino: 0,
  mode: FILE_MODE.REGULAR,
  uid: 0,
  gid: 0,
  fileSize: 0,
  id,
  flags: { ...STAGE0_FLAGS, stage },
  path: path as FilePath,
});

describe('materializeTree', () => {
  it('Given an empty index and a target tree with one blob, When materializeTree runs, Then writes the blob to the workdir', async () => {
    // Arrange
    const ctx = await buildSeededContext();
    const blobId = await writeBlob(ctx, 'hello');
    const treeEntries: TreeEntry[] = [
      { name: 'a.txt' as FilePath, id: blobId, mode: FILE_MODE.REGULAR },
    ];
    const treeId = await writeTree(ctx, treeEntries);
    const sut = materializeTree;

    // Act
    const result = await sut(ctx, {
      targetTree: treeId,
      currentIndex: EMPTY_INDEX,
    });

    // Assert
    expect(result.written).toBe(1);
    expect(result.deleted).toBe(0);
    expect(result.newIndexEntries).toHaveLength(1);
    const bytes = await ctx.fs.read(`${ctx.layout.workDir}/a.txt`);
    expect(new TextDecoder().decode(bytes)).toBe('hello');
  });

  it('Given an index with one path and an empty target tree (with force), When materializeTree runs, Then deletes the file', async () => {
    // Arrange
    const ctx = await buildSeededContext();
    const blobId = await writeBlob(ctx, 'soon-gone');
    await ctx.fs.write(`${ctx.layout.workDir}/old.txt`, new TextEncoder().encode('soon-gone'));
    const treeId = await writeTree(ctx, []);
    const index: GitIndex = { ...EMPTY_INDEX, entries: [makeIndexEntry('old.txt', blobId)] };
    const sut = materializeTree;

    // Act
    const result = await sut(ctx, {
      targetTree: treeId,
      currentIndex: index,
      force: true,
    });

    // Assert
    expect(result.deleted).toBe(1);
    expect(await ctx.fs.exists(`${ctx.layout.workDir}/old.txt`)).toBe(false);
  });

  it('Given a noop entry (index matches target) AND forceRewriteAll, When materializeTree runs, Then the path is rewritten anyway', async () => {
    // Arrange — seed index with the same id+mode the target tree has. The
    // index→target diff would normally classify this as `noop` and skip the
    // write. With `forceRewriteAll: true`, the path must be rewritten
    // unconditionally — the hard-reset use case where the working tree may
    // have diverged from the index.
    const ctx = await buildSeededContext();
    const blobId = await writeBlob(ctx, 'committed');
    const treeId = await writeTree(ctx, [
      { name: 'a.txt' as FilePath, id: blobId, mode: FILE_MODE.REGULAR },
    ]);
    const indexWithMatch: GitIndex = {
      ...EMPTY_INDEX,
      entries: [makeIndexEntry('a.txt', blobId)],
    };
    // Simulate a locally-modified file: index says 'committed', disk says 'dirty'.
    await ctx.fs.write(`${ctx.layout.workDir}/a.txt`, new TextEncoder().encode('dirty'));
    const sut = materializeTree;

    // Act
    const result = await sut(ctx, {
      targetTree: treeId,
      currentIndex: indexWithMatch,
      force: true,
      forceRewriteAll: true,
    });

    // Assert — `written` includes the upgraded noop, and the file content
    // reverts to the committed blob.
    expect(result.written).toBe(1);
    const onDisk = new TextDecoder().decode(await ctx.fs.read(`${ctx.layout.workDir}/a.txt`));
    expect(onDisk).toBe('committed');
  });

  it('Given a noop entry with a clean working-tree file AND forceRewriteAll: true, force: false, When materializeTree runs, Then the upgraded entry goes through the tracked-dirty guard (kind is update, not add)', async () => {
    // Arrange — index has 'committed', working tree has 'committed' (clean per
    // the index's previousId hash check). forceRewriteAll upgrades the noop to
    // 'update'; force: false runs the dirty-tree guard. The 'update' branch of
    // the guard hashes the file and compares to previousId → match → no throw.
    //
    // If the upgrade mutated the kind to 'add' instead, the same code path
    // would run isUntrackedClash (file exists → throw CHECKOUT_OVERWRITE_DIRTY).
    // So this test discriminates 'update' from 'add' for the upgraded entry.
    const ctx = await buildSeededContext();
    const blobId = await writeBlob(ctx, 'committed');
    const treeId = await writeTree(ctx, [
      { name: 'a.txt' as FilePath, id: blobId, mode: FILE_MODE.REGULAR },
    ]);
    const indexWithMatch: GitIndex = {
      ...EMPTY_INDEX,
      entries: [makeIndexEntry('a.txt', blobId)],
    };
    await ctx.fs.write(`${ctx.layout.workDir}/a.txt`, new TextEncoder().encode('committed'));
    const sut = materializeTree;

    // Act
    const result = await sut(ctx, {
      targetTree: treeId,
      currentIndex: indexWithMatch,
      force: false,
      forceRewriteAll: true,
    });

    // Assert
    expect(result.written).toBe(1);
  });

  it('Given a noop entry without forceRewriteAll, When materializeTree runs, Then the path is left alone', async () => {
    // Arrange — same setup, but `forceRewriteAll` omitted. Default behaviour
    // must preserve checkout semantics: clean (per the index)
    // files are never spuriously rewritten.
    const ctx = await buildSeededContext();
    const blobId = await writeBlob(ctx, 'committed');
    const treeId = await writeTree(ctx, [
      { name: 'a.txt' as FilePath, id: blobId, mode: FILE_MODE.REGULAR },
    ]);
    const indexWithMatch: GitIndex = {
      ...EMPTY_INDEX,
      entries: [makeIndexEntry('a.txt', blobId)],
    };
    await ctx.fs.write(`${ctx.layout.workDir}/a.txt`, new TextEncoder().encode('dirty'));
    const sut = materializeTree;

    // Act
    const result = await sut(ctx, {
      targetTree: treeId,
      currentIndex: indexWithMatch,
      force: true,
    });

    // Assert — no writes (noop preserved), file stays dirty.
    expect(result.written).toBe(0);
    const onDisk = new TextDecoder().decode(await ctx.fs.read(`${ctx.layout.workDir}/a.txt`));
    expect(onDisk).toBe('dirty');
  });

  it('Given forceRewriteAll: true with multiple noop entries, When materializeTree runs, Then progress total reports them as upgraded updates', async () => {
    // Arrange — three paths that all match the index (so all three would be
    // noops without forceRewriteAll). With it, all three upgrade to updates,
    // and applyChangeset reports them in `total = stats.add + update + delete`.
    // This pins tallyStats' `stats[entry.kind] += 1` — a mutation to `-= 1`
    // would surface as a negative/zero progress total.
    const progress = recordingProgress();
    const ctx = await buildSeededContext();
    const ctxWithProgress = { ...ctx, progress: progress.reporter };
    const idA = await writeBlob(ctxWithProgress, 'A');
    const idB = await writeBlob(ctxWithProgress, 'B');
    const idC = await writeBlob(ctxWithProgress, 'C');
    const treeId = await writeTree(ctxWithProgress, [
      { name: 'a.txt' as FilePath, id: idA, mode: FILE_MODE.REGULAR },
      { name: 'b.txt' as FilePath, id: idB, mode: FILE_MODE.REGULAR },
      { name: 'c.txt' as FilePath, id: idC, mode: FILE_MODE.REGULAR },
    ]);
    const indexWithAllMatches: GitIndex = {
      ...EMPTY_INDEX,
      entries: [
        makeIndexEntry('a.txt', idA),
        makeIndexEntry('b.txt', idB),
        makeIndexEntry('c.txt', idC),
      ],
    };
    const sut = materializeTree;

    // Act
    await sut(ctxWithProgress, {
      targetTree: treeId,
      currentIndex: indexWithAllMatches,
      force: true,
      forceRewriteAll: true,
    });

    // Assert — every update emits a progress tick whose `total` equals the
    // re-tallied stats sum (3 updates after upgrade, 0 add, 0 delete = 3).
    const totals = progress.events
      .filter(
        (e): e is { kind: 'update'; op: string; current: number; total: number } =>
          e.kind === 'update' && e.total !== undefined,
      )
      .map((e) => e.total);
    expect(totals).toEqual([3, 3, 3]);
  });

  it('Given a scoped restore with a non-zero-stage index entry out of scope, When materializeTree runs, Then the conflicted entry is NOT preserved in newIndexEntries', async () => {
    // Arrange — `indexEntriesByPath` filters to stage-0 entries only. A stage-2
    // (merge-conflict) entry for an out-of-scope path must be excluded from
    // `oldByPath`, so `preserveOutOfScope` cannot carry it into the result.
    // If the stage guard were dropped (always-true), the stage-2 entry would
    // leak into `newIndexEntries`.
    const ctx = await buildSeededContext();
    const idA = await writeBlob(ctx, 'A');
    const idConflict = await writeBlob(ctx, 'conflict');
    const treeId = await writeTree(ctx, [
      { name: 'a.txt' as FilePath, id: idA, mode: FILE_MODE.REGULAR },
    ]);
    const index: GitIndex = {
      ...EMPTY_INDEX,
      entries: [makeIndexEntry('conflict.txt', idConflict, 2)],
    };
    const sut = materializeTree;

    // Act — restore only 'a.txt'; 'conflict.txt' is out of scope.
    const result = await sut(ctx, {
      targetTree: treeId,
      currentIndex: index,
      paths: new Set(['a.txt' as FilePath]),
    });

    // Assert — only 'a.txt' is present; the stage-2 entry was dropped.
    expect(result.newIndexEntries.map((e) => e.path)).toEqual(['a.txt']);
  });

  it('Given a scoped restore with a stage-0 index entry out of scope, When materializeTree runs, Then that entry IS preserved in newIndexEntries', async () => {
    // Arrange — `preserveOutOfScope` only runs in scoped mode and only pushes
    // entries whose path is NOT in `scopedPaths`. An out-of-scope stage-0 entry
    // must survive the scoped restore untouched. This exercises the loop body
    // and the `!scopedPaths.has(path)` guard's true branch.
    const ctx = await buildSeededContext();
    const idA = await writeBlob(ctx, 'A');
    const idKeep = await writeBlob(ctx, 'keep');
    const treeId = await writeTree(ctx, [
      { name: 'a.txt' as FilePath, id: idA, mode: FILE_MODE.REGULAR },
    ]);
    const index: GitIndex = {
      ...EMPTY_INDEX,
      entries: [makeIndexEntry('keep.txt', idKeep)],
    };
    const sut = materializeTree;

    // Act — restore only 'a.txt'; 'keep.txt' is out of scope and must persist.
    const result = await sut(ctx, {
      targetTree: treeId,
      currentIndex: index,
      paths: new Set(['a.txt' as FilePath]),
    });

    // Assert — both the restored path and the preserved out-of-scope path.
    expect(result.newIndexEntries.map((e) => e.path)).toEqual(['a.txt', 'keep.txt']);
    expect(result.newIndexEntries.find((e) => e.path === 'keep.txt')?.id).toBe(idKeep);
  });

  it('Given a scoped restore with a stage-0 index entry IN scope, When materializeTree runs, Then preserveOutOfScope does NOT also re-add it', async () => {
    // Arrange — an in-scope path that exists in both the index and the target.
    // `preserveOutOfScope`'s `!scopedPaths.has(path)` guard must be FALSE for it,
    // so it is contributed only once (via the target loop). If the guard were
    // inverted/forced true, the path would appear twice.
    const ctx = await buildSeededContext();
    const idOld = await writeBlob(ctx, 'old');
    const idNew = await writeBlob(ctx, 'new');
    const treeId = await writeTree(ctx, [
      { name: 'a.txt' as FilePath, id: idNew, mode: FILE_MODE.REGULAR },
    ]);
    const index: GitIndex = {
      ...EMPTY_INDEX,
      entries: [makeIndexEntry('a.txt', idOld)],
    };
    const sut = materializeTree;

    // Act — restore 'a.txt', which is also present in the index.
    const result = await sut(ctx, {
      targetTree: treeId,
      currentIndex: index,
      force: true,
      paths: new Set(['a.txt' as FilePath]),
    });

    // Assert — 'a.txt' appears exactly once.
    expect(result.newIndexEntries.map((e) => e.path)).toEqual(['a.txt']);
  });

  it('Given a target tree whose entries sort differently from insertion order, When materializeTree runs, Then newIndexEntries are in strict ascending path order', async () => {
    // Arrange — three blobs written to a tree. `writeTree` canonicalises tree
    // entry order, but `mergeNewIndexEntries` sorts the merged list explicitly.
    // Providing scrambled names and asserting strict ascending order pins the
    // `.sort()` call and its comparator: dropping the sort, inverting the
    // `-1`/`1` results, or forcing either ternary branch yields a non-ascending
    // (or fully descending) result.
    const ctx = await buildSeededContext();
    const idC = await writeBlob(ctx, 'C');
    const idA = await writeBlob(ctx, 'A');
    const idB = await writeBlob(ctx, 'B');
    const treeId = await writeTree(ctx, [
      { name: 'c.txt' as FilePath, id: idC, mode: FILE_MODE.REGULAR },
      { name: 'a.txt' as FilePath, id: idA, mode: FILE_MODE.REGULAR },
      { name: 'b.txt' as FilePath, id: idB, mode: FILE_MODE.REGULAR },
    ]);
    const sut = materializeTree;

    // Act
    const result = await sut(ctx, {
      targetTree: treeId,
      currentIndex: EMPTY_INDEX,
    });

    // Assert — exact ascending order, not descending, not unsorted.
    expect(result.newIndexEntries.map((e) => e.path)).toEqual(['a.txt', 'b.txt', 'c.txt']);
  });

  it('Given a preserved out-of-scope entry that sorts before a restored path, When materializeTree runs, Then the merged result stays ascending', async () => {
    // Arrange — the merged list is `[out-of-scope..., target...]`. When an
    // out-of-scope path sorts AFTER a restored path, only a real sort produces
    // ascending order. This drives the comparator's `1` (greater-than) branch
    // and the descending-detection: a dropped/inverted sort would put 'z.txt'
    // first.
    const ctx = await buildSeededContext();
    const idM = await writeBlob(ctx, 'M');
    const idZ = await writeBlob(ctx, 'Z');
    const treeId = await writeTree(ctx, [
      { name: 'm.txt' as FilePath, id: idM, mode: FILE_MODE.REGULAR },
    ]);
    const index: GitIndex = {
      ...EMPTY_INDEX,
      entries: [makeIndexEntry('z.txt', idZ)],
    };
    const sut = materializeTree;

    // Act — restore only 'm.txt'; 'z.txt' is preserved out of scope.
    const result = await sut(ctx, {
      targetTree: treeId,
      currentIndex: index,
      paths: new Set(['m.txt' as FilePath]),
    });

    // Assert — out-of-scope 'z.txt' is sorted after the restored 'm.txt'.
    expect(result.newIndexEntries.map((e) => e.path)).toEqual(['m.txt', 'z.txt']);
  });

  it('Given an add entry clashing with an untracked working-tree file and force omitted, When materializeTree runs, Then it throws CHECKOUT_OVERWRITE_DIRTY', async () => {
    // Arrange — `opts.force ?? false`: when `force` is omitted it must default
    // to `false`, so the dirty-tree guard runs. An untracked file already on
    // disk at a target `add` path triggers CHECKOUT_OVERWRITE_DIRTY. If the
    // nullish-coalescing default were mutated to `true`, the guard would be
    // skipped and no error thrown.
    const ctx = await buildSeededContext();
    const blobId = await writeBlob(ctx, 'incoming');
    await ctx.fs.write(`${ctx.layout.workDir}/a.txt`, new TextEncoder().encode('untracked'));
    const treeId = await writeTree(ctx, [
      { name: 'a.txt' as FilePath, id: blobId, mode: FILE_MODE.REGULAR },
    ]);
    const sut = materializeTree;

    // Act / Assert
    let captured: unknown;
    try {
      await sut(ctx, { targetTree: treeId, currentIndex: EMPTY_INDEX });
    } catch (error) {
      captured = error;
    }
    expect(captured).toBeInstanceOf(Error);
    const data = (captured as { data: { code: string; paths: ReadonlyArray<string> } }).data;
    expect(data.code).toBe('CHECKOUT_OVERWRITE_DIRTY');
    expect(data.paths).toEqual(['a.txt']);
    expect((captured as Error).message).toBe(
      'CHECKOUT_OVERWRITE_DIRTY: checkout would overwrite uncommitted changes: 1 files',
    );
  });

  it('Given the same add/untracked clash but force: true, When materializeTree runs, Then the dirty guard is bypassed and the file is overwritten', async () => {
    // Arrange — companion to the previous test: with `force: true` explicitly
    // set, the guard is skipped and the write proceeds. This proves the guard
    // is gated on the force value, not unconditional.
    const ctx = await buildSeededContext();
    const blobId = await writeBlob(ctx, 'incoming');
    await ctx.fs.write(`${ctx.layout.workDir}/a.txt`, new TextEncoder().encode('untracked'));
    const treeId = await writeTree(ctx, [
      { name: 'a.txt' as FilePath, id: blobId, mode: FILE_MODE.REGULAR },
    ]);
    const sut = materializeTree;

    // Act
    const result = await sut(ctx, {
      targetTree: treeId,
      currentIndex: EMPTY_INDEX,
      force: true,
    });

    // Assert
    expect(result.written).toBe(1);
    const onDisk = new TextDecoder().decode(await ctx.fs.read(`${ctx.layout.workDir}/a.txt`));
    expect(onDisk).toBe('incoming');
  });

  it('Given paths filter, When materializeTree runs, Then only the filtered path is affected', async () => {
    // Arrange
    const ctx = await buildSeededContext();
    const idA = await writeBlob(ctx, 'A');
    const idB = await writeBlob(ctx, 'B');
    const treeId = await writeTree(ctx, [
      { name: 'a.txt' as FilePath, id: idA, mode: FILE_MODE.REGULAR },
      { name: 'b.txt' as FilePath, id: idB, mode: FILE_MODE.REGULAR },
    ]);
    const sut = materializeTree;

    // Act — restore only 'a.txt'
    const result = await sut(ctx, {
      targetTree: treeId,
      currentIndex: EMPTY_INDEX,
      paths: new Set(['a.txt' as FilePath]),
    });

    // Assert
    expect(result.written).toBe(1);
    expect(await ctx.fs.exists(`${ctx.layout.workDir}/a.txt`)).toBe(true);
    expect(await ctx.fs.exists(`${ctx.layout.workDir}/b.txt`)).toBe(false);
  });
});
