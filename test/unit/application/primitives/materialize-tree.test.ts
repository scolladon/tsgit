import { describe, expect, it } from 'vitest';

import { materializeTree } from '../../../../src/application/primitives/materialize-tree.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import { writeTree } from '../../../../src/application/primitives/write-tree.js';
import type { GitIndex, IndexEntry } from '../../../../src/domain/git-index/index.js';
import { FILE_MODE } from '../../../../src/domain/objects/file-mode.js';
import type { FilePath, ObjectId, TreeEntry } from '../../../../src/domain/objects/index.js';
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
