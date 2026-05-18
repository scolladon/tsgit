import { describe, expect, it } from 'vitest';
import { flattenTree } from '../../../../src/application/primitives/flatten-tree.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import { writeTree } from '../../../../src/application/primitives/write-tree.js';
import { FILE_MODE } from '../../../../src/domain/objects/file-mode.js';
import type { FilePath, ObjectId } from '../../../../src/domain/objects/index.js';
import { buildSeededContext } from './fixtures.js';

const writeBlob = async (
  ctx: Awaited<ReturnType<typeof buildSeededContext>>,
  content: string,
): Promise<ObjectId> =>
  writeObject(ctx, {
    type: 'blob',
    content: new TextEncoder().encode(content),
    id: '' as ObjectId,
  });

describe('flattenTree', () => {
  it('Given an empty tree, When flattenTree runs, Then returns an empty FlatTree', async () => {
    // Arrange
    const ctx = await buildSeededContext();
    const treeId = await writeTree(ctx, []);
    const sut = flattenTree;

    // Act
    const result = await sut(ctx, treeId);

    // Assert
    expect(result.entries.size).toBe(0);
  });

  it('Given a single-file tree, When flattenTree runs, Then returns one FlatTree entry', async () => {
    // Arrange
    const ctx = await buildSeededContext();
    const blobId = await writeBlob(ctx, 'hello');
    const treeId = await writeTree(ctx, [
      { name: 'a.txt' as FilePath, id: blobId, mode: FILE_MODE.REGULAR },
    ]);
    const sut = flattenTree;

    // Act
    const result = await sut(ctx, treeId);

    // Assert
    expect(result.entries.size).toBe(1);
    expect(result.entries.get('a.txt' as FilePath)).toEqual({
      id: blobId,
      mode: FILE_MODE.REGULAR,
    });
  });

  it('Given a nested tree, When flattenTree runs, Then leaves are keyed by canonical /-separated paths', async () => {
    // Arrange
    const ctx = await buildSeededContext();
    const idA = await writeBlob(ctx, 'A');
    const idB = await writeBlob(ctx, 'B');
    const subId = await writeTree(ctx, [
      { name: 'inner.txt' as FilePath, id: idB, mode: FILE_MODE.REGULAR },
    ]);
    const rootId = await writeTree(ctx, [
      { name: 'a.txt' as FilePath, id: idA, mode: FILE_MODE.REGULAR },
      { name: 'sub' as FilePath, id: subId, mode: FILE_MODE.DIRECTORY },
    ]);
    const sut = flattenTree;

    // Act
    const result = await sut(ctx, rootId);

    // Assert
    expect(result.entries.size).toBe(2);
    expect(result.entries.get('a.txt' as FilePath)?.id).toBe(idA);
    expect(result.entries.get('sub/inner.txt' as FilePath)?.id).toBe(idB);
  });

  it('Given a tree containing an executable file and a symlink, When flattenTree runs, Then modes are preserved', async () => {
    // Arrange
    const ctx = await buildSeededContext();
    const execId = await writeBlob(ctx, '#!/bin/sh');
    const linkId = await writeBlob(ctx, 'target/path');
    const treeId = await writeTree(ctx, [
      { name: 'run.sh' as FilePath, id: execId, mode: FILE_MODE.EXECUTABLE },
      { name: 'link' as FilePath, id: linkId, mode: FILE_MODE.SYMLINK },
    ]);
    const sut = flattenTree;

    // Act
    const result = await sut(ctx, treeId);

    // Assert
    expect(result.entries.get('run.sh' as FilePath)?.mode).toBe(FILE_MODE.EXECUTABLE);
    expect(result.entries.get('link' as FilePath)?.mode).toBe(FILE_MODE.SYMLINK);
  });

  it('Given a tree nested two levels deep, When flattenTree runs, Then leaves are keyed by full slash-joined path', async () => {
    // Arrange — root → dir/ → sub/ → leaf.txt. Pins the slash separator
    // at every recursion depth, including the second nested level.
    const ctx = await buildSeededContext();
    const blobId = await writeBlob(ctx, 'deep');
    const subTreeId = await writeTree(ctx, [
      { name: 'leaf.txt' as FilePath, id: blobId, mode: FILE_MODE.REGULAR },
    ]);
    const dirTreeId = await writeTree(ctx, [
      { name: 'sub' as FilePath, id: subTreeId, mode: FILE_MODE.DIRECTORY },
    ]);
    const rootId = await writeTree(ctx, [
      { name: 'dir' as FilePath, id: dirTreeId, mode: FILE_MODE.DIRECTORY },
    ]);
    const sut = flattenTree;

    // Act
    const result = await sut(ctx, rootId);

    // Assert — only one leaf, with the full 2-level path.
    expect(result.entries.size).toBe(1);
    expect(result.entries.get('dir/sub/leaf.txt' as FilePath)?.id).toBe(blobId);
  });

  it('Given a tree containing a gitlink, When flattenTree runs, Then the gitlink entry is preserved (mode = GITLINK)', async () => {
    // Arrange — gitlink at a leaf records the submodule commit oid.
    // mergeTrees treats gitlinks specially (any divergence is a conflict),
    // so flattenTree must preserve the GITLINK mode.
    const ctx = await buildSeededContext();
    const submoduleOid = 'cccccccccccccccccccccccccccccccccccccccc' as ObjectId;
    const treeId = await writeTree(ctx, [
      { name: 'submodule' as FilePath, id: submoduleOid, mode: FILE_MODE.GITLINK },
    ]);
    const sut = flattenTree;

    // Act
    const result = await sut(ctx, treeId);

    // Assert
    expect(result.entries.get('submodule' as FilePath)).toEqual({
      id: submoduleOid,
      mode: FILE_MODE.GITLINK,
    });
  });
});
