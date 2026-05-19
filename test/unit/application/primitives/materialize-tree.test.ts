import { describe, expect, it } from 'vitest';

import { materializeTree } from '../../../../src/application/primitives/materialize-tree.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import { writeTree } from '../../../../src/application/primitives/write-tree.js';
import type { GitIndex, IndexEntry } from '../../../../src/domain/git-index/index.js';
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

const makeIndexEntry = (path: string, id: ObjectId): IndexEntry => ({
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
  flags: { assumeValid: false, extended: false, stage: 0 },
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
