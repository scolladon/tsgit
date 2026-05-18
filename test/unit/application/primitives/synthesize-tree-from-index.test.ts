import { describe, expect, it } from 'vitest';
import { readObject } from '../../../../src/application/primitives/read-object.js';
import { synthesizeTreeFromIndex } from '../../../../src/application/primitives/synthesize-tree-from-index.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import { writeTree } from '../../../../src/application/primitives/write-tree.js';
import type { GitIndex, IndexEntry } from '../../../../src/domain/git-index/index.js';
import { FILE_MODE } from '../../../../src/domain/objects/file-mode.js';
import type { FileMode, FilePath, ObjectId, Tree } from '../../../../src/domain/objects/index.js';
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

const makeIndexEntry = (
  path: string,
  id: ObjectId,
  mode: FileMode = FILE_MODE.REGULAR,
  stage: 0 | 1 | 2 | 3 = 0,
): IndexEntry => ({
  ctimeSeconds: 0,
  ctimeNanoseconds: 0,
  mtimeSeconds: 0,
  mtimeNanoseconds: 0,
  dev: 0,
  ino: 0,
  mode,
  uid: 0,
  gid: 0,
  fileSize: 0,
  id,
  flags: { assumeValid: false, extended: false, stage },
  path: path as FilePath,
});

describe('synthesizeTreeFromIndex', () => {
  it('Given an empty index, When synthesise, Then returns the canonical empty-tree ObjectId', async () => {
    // Arrange
    const ctx = await buildSeededContext();
    const emptyTreeId = await writeTree(ctx, []);
    const sut = synthesizeTreeFromIndex;

    // Act
    const result = await sut(ctx, EMPTY_INDEX);

    // Assert
    expect(result).toBe(emptyTreeId);
  });

  it('Given an index with one root-level file, When synthesise, Then root tree has one regular entry', async () => {
    // Arrange
    const ctx = await buildSeededContext();
    const blobId = await writeBlob(ctx, 'hello');
    const index: GitIndex = {
      ...EMPTY_INDEX,
      entries: [makeIndexEntry('a.txt', blobId)],
    };
    const sut = synthesizeTreeFromIndex;

    // Act
    const treeId = await sut(ctx, index);

    // Assert — read the tree back and verify its single entry.
    const tree = (await readObject(ctx, treeId)) as Tree;
    expect(tree.type).toBe('tree');
    expect(tree.entries).toHaveLength(1);
    expect(tree.entries[0]?.name).toBe('a.txt');
    expect(tree.entries[0]?.id).toBe(blobId);
    expect(tree.entries[0]?.mode).toBe(FILE_MODE.REGULAR);
  });

  it('Given an index with nested paths, When synthesise, Then produces correctly-nested trees', async () => {
    // Arrange — paths: 'a.txt', 'dir/b.txt', 'dir/sub/c.txt'.
    const ctx = await buildSeededContext();
    const idA = await writeBlob(ctx, 'A');
    const idB = await writeBlob(ctx, 'B');
    const idC = await writeBlob(ctx, 'C');
    const index: GitIndex = {
      ...EMPTY_INDEX,
      entries: [
        makeIndexEntry('a.txt', idA),
        makeIndexEntry('dir/b.txt', idB),
        makeIndexEntry('dir/sub/c.txt', idC),
      ],
    };
    const sut = synthesizeTreeFromIndex;

    // Act
    const rootId = await sut(ctx, index);

    // Assert — walk the structure: root → { a.txt, dir }; dir → { b.txt, sub }; sub → { c.txt }.
    const root = (await readObject(ctx, rootId)) as Tree;
    const aEntry = root.entries.find((e) => e.name === 'a.txt');
    const dirEntry = root.entries.find((e) => e.name === 'dir');
    expect(aEntry?.id).toBe(idA);
    expect(aEntry?.mode).toBe(FILE_MODE.REGULAR);
    expect(dirEntry?.mode).toBe(FILE_MODE.DIRECTORY);

    const dirTree = (await readObject(ctx, dirEntry?.id as ObjectId)) as Tree;
    const bEntry = dirTree.entries.find((e) => e.name === 'b.txt');
    const subEntry = dirTree.entries.find((e) => e.name === 'sub');
    expect(bEntry?.id).toBe(idB);
    expect(subEntry?.mode).toBe(FILE_MODE.DIRECTORY);

    const subTree = (await readObject(ctx, subEntry?.id as ObjectId)) as Tree;
    expect(subTree.entries).toHaveLength(1);
    expect(subTree.entries[0]?.name).toBe('c.txt');
    expect(subTree.entries[0]?.id).toBe(idC);
  });

  it('Given an index with stage-2 (unmerged) entries, When synthesise, Then the unmerged entries are filtered out', async () => {
    // Arrange — only stage-0 entries should reach the tree; stage-2 means
    // "unresolved merge" and is invisible to the synthesis (consistent with
    // Phase 13.1's computeChangeset + Phase 13.2's buildIndexFromTree).
    const ctx = await buildSeededContext();
    const stagedId = await writeBlob(ctx, 'staged');
    const unmergedId = await writeBlob(ctx, 'theirs-version');
    const index: GitIndex = {
      ...EMPTY_INDEX,
      entries: [
        makeIndexEntry('a.txt', stagedId, FILE_MODE.REGULAR, 0),
        makeIndexEntry('conflict.txt', unmergedId, FILE_MODE.REGULAR, 2),
      ],
    };
    const sut = synthesizeTreeFromIndex;

    // Act
    const treeId = await sut(ctx, index);

    // Assert — only a.txt appears.
    const tree = (await readObject(ctx, treeId)) as Tree;
    expect(tree.entries).toHaveLength(1);
    expect(tree.entries[0]?.name).toBe('a.txt');
  });

  it("Given an index round-tripped from a known commit, When synthesise, Then returns the commit's tree id", async () => {
    // Arrange — write a tree explicitly, then build an index that mirrors
    // that tree exactly. The synthesis must round-trip to the same id.
    const ctx = await buildSeededContext();
    const idA = await writeBlob(ctx, 'A');
    const idB = await writeBlob(ctx, 'B');
    // Build a nested tree manually so we have a canonical reference.
    const subId = await writeTree(ctx, [
      { name: 'inner.txt' as FilePath, id: idB, mode: FILE_MODE.REGULAR },
    ]);
    const expectedRootId = await writeTree(ctx, [
      { name: 'a.txt' as FilePath, id: idA, mode: FILE_MODE.REGULAR },
      { name: 'dir' as FilePath, id: subId, mode: FILE_MODE.DIRECTORY },
    ]);

    // The index that this tree corresponds to (flat, stage-0).
    const index: GitIndex = {
      ...EMPTY_INDEX,
      entries: [makeIndexEntry('a.txt', idA), makeIndexEntry('dir/inner.txt', idB)],
    };
    const sut = synthesizeTreeFromIndex;

    // Act
    const synthesised = await sut(ctx, index);

    // Assert — IDENTITY: synthesis matches the canonical tree byte-for-byte.
    expect(synthesised).toBe(expectedRootId);
  });

  it('Given an index with multiple files in the same subdirectory, When synthesise, Then the subdirectory has all its files', async () => {
    // Arrange — pins that group-by-prefix doesn't lose siblings.
    const ctx = await buildSeededContext();
    const id1 = await writeBlob(ctx, 'one');
    const id2 = await writeBlob(ctx, 'two');
    const id3 = await writeBlob(ctx, 'three');
    const index: GitIndex = {
      ...EMPTY_INDEX,
      entries: [
        makeIndexEntry('src/a.ts', id1),
        makeIndexEntry('src/b.ts', id2),
        makeIndexEntry('src/c.ts', id3),
      ],
    };
    const sut = synthesizeTreeFromIndex;

    // Act
    const rootId = await sut(ctx, index);

    // Assert
    const root = (await readObject(ctx, rootId)) as Tree;
    expect(root.entries).toHaveLength(1);
    expect(root.entries[0]?.name).toBe('src');
    const srcTree = (await readObject(ctx, root.entries[0]?.id as ObjectId)) as Tree;
    const names = srcTree.entries.map((e) => e.name).sort();
    expect(names).toEqual(['a.ts', 'b.ts', 'c.ts']);
  });

  it('Given an index entry with executable mode, When synthesise, Then the executable mode is preserved', async () => {
    // Arrange
    const ctx = await buildSeededContext();
    const blobId = await writeBlob(ctx, '#!/bin/sh');
    const index: GitIndex = {
      ...EMPTY_INDEX,
      entries: [makeIndexEntry('run.sh', blobId, FILE_MODE.EXECUTABLE)],
    };
    const sut = synthesizeTreeFromIndex;

    // Act
    const treeId = await sut(ctx, index);

    // Assert
    const tree = (await readObject(ctx, treeId)) as Tree;
    expect(tree.entries[0]?.mode).toBe(FILE_MODE.EXECUTABLE);
  });
});
