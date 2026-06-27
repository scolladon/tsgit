import { describe, expect, it } from 'vitest';
import { createCommit } from '../../../../src/application/primitives/create-commit.js';
import {
  type BundleObjectClosure,
  enumerateBundleObjects,
} from '../../../../src/application/primitives/enumerate-bundle-objects.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import { writeTree } from '../../../../src/application/primitives/write-tree.js';
import { TsgitError } from '../../../../src/domain/error.js';
import type {
  AuthorIdentity,
  Blob,
  FileMode,
  ObjectId,
  Tag,
  TreeEntry,
} from '../../../../src/domain/objects/index.js';
import type { Context } from '../../../../src/ports/context.js';
import { buildSeededContext } from './fixtures.js';

const AUTHOR: AuthorIdentity = {
  name: 'Test',
  email: 't@t.com',
  timestamp: 1_000_000_000,
  timezoneOffset: '+0000',
};

const BLOB_MODE = '100644' as FileMode;

const makeBlob = async (ctx: Context, content: string): Promise<ObjectId> => {
  const blob: Blob = {
    type: 'blob',
    id: '' as ObjectId,
    content: new TextEncoder().encode(content),
  };
  return writeObject(ctx, blob);
};

const makeTree = async (ctx: Context, entries: ReadonlyArray<TreeEntry>): Promise<ObjectId> =>
  writeTree(ctx, entries);

const makeCommit = async (
  ctx: Context,
  treeId: ObjectId,
  parents: ReadonlyArray<ObjectId>,
  message: string,
  ts: number,
): Promise<ObjectId> =>
  createCommit(ctx, {
    tree: treeId,
    parents,
    author: { ...AUTHOR, timestamp: ts },
    committer: { ...AUTHOR, timestamp: ts },
    message,
  });

const sorted = (oids: ReadonlyArray<ObjectId>): ObjectId[] => [...oids].sort();

interface LinearFixture {
  readonly ctx: Context;
  readonly blobA: ObjectId;
  readonly blobB: ObjectId;
  readonly blobC: ObjectId;
  readonly commit1: ObjectId;
  readonly commit2: ObjectId;
  readonly commit3: ObjectId;
  readonly tree1: ObjectId;
  readonly tree2: ObjectId;
  readonly tree3: ObjectId;
}

const buildLinearFixture = async (): Promise<LinearFixture> => {
  const ctx = await buildSeededContext();
  const blobA = await makeBlob(ctx, 'A');
  const blobB = await makeBlob(ctx, 'B');
  const blobC = await makeBlob(ctx, 'C');
  const tree1 = await makeTree(ctx, [{ mode: BLOB_MODE, name: 'f0.txt', id: blobA }]);
  const tree2 = await makeTree(ctx, [
    { mode: BLOB_MODE, name: 'f0.txt', id: blobA },
    { mode: BLOB_MODE, name: 'f1.txt', id: blobB },
  ]);
  const tree3 = await makeTree(ctx, [
    { mode: BLOB_MODE, name: 'f0.txt', id: blobA },
    { mode: BLOB_MODE, name: 'f1.txt', id: blobB },
    { mode: BLOB_MODE, name: 'f2.txt', id: blobC },
  ]);
  const commit1 = await makeCommit(ctx, tree1, [], 'first', 1);
  const commit2 = await makeCommit(ctx, tree2, [commit1], 'second', 2);
  const commit3 = await makeCommit(ctx, tree3, [commit2], 'third', 3);
  return { ctx, blobA, blobB, blobC, commit1, commit2, commit3, tree1, tree2, tree3 };
};

describe('enumerateBundleObjects', () => {
  describe('Given an empty wants list', () => {
    describe('When enumerateBundleObjects is called', () => {
      it('Then returns empty objects and boundary without reading the repo', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const sut = enumerateBundleObjects;

        // Act
        const result: BundleObjectClosure = await sut(ctx, { wants: [], haves: [] });

        // Assert
        expect(result.objects).toEqual([]);
        expect(result.boundary).toEqual([]);
      });
    });
  });

  describe('Given a linear chain first→second→third where blobA is introduced in first', () => {
    describe('When enumerateBundleObjects is called with wants=[third] haves=[first]', () => {
      it('Then objects are exactly the two new commits two new trees and two new blobs', async () => {
        // Arrange
        const { ctx, commit1, commit2, commit3, tree2, tree3, blobB, blobC } =
          await buildLinearFixture();
        const sut = enumerateBundleObjects;

        // Act
        const result = await sut(ctx, { wants: [commit3], haves: [commit1] });

        // Assert
        expect(sorted(result.objects)).toEqual(
          sorted([commit2, commit3, tree2, tree3, blobB, blobC]),
        );
      });

      it('Then blobA tree1 and commit1 are absent from objects', async () => {
        // Arrange
        const { ctx, blobA, tree1, commit1, commit3 } = await buildLinearFixture();
        const sut = enumerateBundleObjects;

        // Act
        const result = await sut(ctx, { wants: [commit3], haves: [commit1] });

        // Assert
        expect(result.objects).not.toContain(blobA);
        expect(result.objects).not.toContain(tree1);
        expect(result.objects).not.toContain(commit1);
      });

      it('Then boundary is exactly [commit1]', async () => {
        // Arrange
        const { ctx, commit1, commit3 } = await buildLinearFixture();
        const sut = enumerateBundleObjects;

        // Act
        const result = await sut(ctx, { wants: [commit3], haves: [commit1] });

        // Assert
        expect(sorted(result.boundary)).toEqual([commit1]);
      });
    });

    describe('When enumerateBundleObjects is called with wants=[third] haves=[]', () => {
      it('Then objects include all commits trees and blobs with empty boundary', async () => {
        // Arrange
        const { ctx, blobA, blobB, blobC, commit1, commit2, commit3, tree1, tree2, tree3 } =
          await buildLinearFixture();
        const sut = enumerateBundleObjects;

        // Act
        const result = await sut(ctx, { wants: [commit3], haves: [] });

        // Assert
        expect(sorted(result.objects)).toEqual(
          sorted([commit1, commit2, commit3, tree1, tree2, tree3, blobA, blobB, blobC]),
        );
        expect(result.boundary).toEqual([]);
      });
    });
  });

  describe('Given a diverging history first→{main, feature} with blobX shared from first', () => {
    describe('When enumerateBundleObjects is called with wants=[main, feature] haves=[first]', () => {
      it('Then boundary is [first] and blobX is excluded from objects', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const sut = enumerateBundleObjects;

        const blobX = await makeBlob(ctx, 'X');
        const blobA = await makeBlob(ctx, 'A');
        const blobB = await makeBlob(ctx, 'B');
        const tree1 = await makeTree(ctx, [{ mode: BLOB_MODE, name: 'x.txt', id: blobX }]);
        const treeMain = await makeTree(ctx, [
          { mode: BLOB_MODE, name: 'a.txt', id: blobA },
          { mode: BLOB_MODE, name: 'x.txt', id: blobX },
        ]);
        const treeFeature = await makeTree(ctx, [
          { mode: BLOB_MODE, name: 'b.txt', id: blobB },
          { mode: BLOB_MODE, name: 'x.txt', id: blobX },
        ]);
        const commit1 = await makeCommit(ctx, tree1, [], 'first', 1);
        const commitMain = await makeCommit(ctx, treeMain, [commit1], 'main', 2);
        const commitFeature = await makeCommit(ctx, treeFeature, [commit1], 'feature', 3);

        // Act
        const result = await sut(ctx, { wants: [commitMain, commitFeature], haves: [commit1] });

        // Assert
        expect(sorted(result.boundary)).toEqual([commit1]);
        expect(sorted(result.objects)).toEqual(
          sorted([commitMain, commitFeature, treeMain, treeFeature, blobA, blobB]),
        );
        expect(result.objects).not.toContain(blobX);
        expect(result.objects).not.toContain(commit1);
      });
    });
  });

  describe('Given a criss-cross merge: O→A,B; M1=merge(A,B)+blobX; M2=merge(A,B); haves=[A,M2]', () => {
    interface CrissCrossFixture {
      readonly ctx: Context;
      readonly blobA: ObjectId;
      readonly blobB: ObjectId;
      readonly blobX: ObjectId;
      readonly commitA: ObjectId;
      readonly commitB: ObjectId;
      readonly commitM1: ObjectId;
      readonly commitM2: ObjectId;
      readonly treeM1: ObjectId;
    }

    const buildCrissCrossFixture = async (): Promise<CrissCrossFixture> => {
      const ctx = await buildSeededContext();
      const blobA = await makeBlob(ctx, 'A');
      const blobB = await makeBlob(ctx, 'B');
      const blobX = await makeBlob(ctx, 'X');
      const emptyTree = await makeTree(ctx, []);
      const treeA = await makeTree(ctx, [{ mode: BLOB_MODE, name: 'a.txt', id: blobA }]);
      const treeB = await makeTree(ctx, [{ mode: BLOB_MODE, name: 'b.txt', id: blobB }]);
      const treeM2 = await makeTree(ctx, [
        { mode: BLOB_MODE, name: 'a.txt', id: blobA },
        { mode: BLOB_MODE, name: 'b.txt', id: blobB },
      ]);
      const treeM1 = await makeTree(ctx, [
        { mode: BLOB_MODE, name: 'a.txt', id: blobA },
        { mode: BLOB_MODE, name: 'b.txt', id: blobB },
        { mode: BLOB_MODE, name: 'x.txt', id: blobX },
      ]);
      const commitO = await makeCommit(ctx, emptyTree, [], 'root', 1);
      const commitA = await makeCommit(ctx, treeA, [commitO], 'A', 2);
      const commitB = await makeCommit(ctx, treeB, [commitO], 'B', 3);
      const commitM2 = await makeCommit(ctx, treeM2, [commitA, commitB], 'm2', 4);
      const commitM1 = await makeCommit(ctx, treeM1, [commitA, commitB], 'm1', 5);
      return { ctx, blobA, blobB, blobX, commitA, commitB, commitM1, commitM2, treeM1 };
    };

    describe('When enumerateBundleObjects is called with wants=[M1] haves=[A, M2]', () => {
      it('Then boundary includes both A and B even though B was not listed in haves', async () => {
        // Arrange
        const { ctx, commitA, commitB, commitM1, commitM2 } = await buildCrissCrossFixture();
        const sut = enumerateBundleObjects;

        // Act
        const result = await sut(ctx, { wants: [commitM1], haves: [commitA, commitM2] });

        // Assert — the criss-cross case: B must appear even though haves=[A, M2]
        expect(sorted(result.boundary)).toEqual(sorted([commitA, commitB]));
      });

      it('Then objects are M1 commit its unique tree and blobX only', async () => {
        // Arrange
        const { ctx, blobA, blobB, commitA, commitM1, commitM2, treeM1, blobX } =
          await buildCrissCrossFixture();
        const sut = enumerateBundleObjects;

        // Act
        const result = await sut(ctx, { wants: [commitM1], haves: [commitA, commitM2] });

        // Assert
        expect(sorted(result.objects)).toEqual(sorted([commitM1, treeM1, blobX]));
        expect(result.objects).not.toContain(blobA);
        expect(result.objects).not.toContain(blobB);
      });
    });
  });

  describe('Given an annotated tag pointing to a commit', () => {
    describe('When enumerateBundleObjects is called with wants=[tagOid] haves=[]', () => {
      it('Then objects include the tag oid plus all commit tree and blob objects', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const sut = enumerateBundleObjects;

        const blobA = await makeBlob(ctx, 'A');
        const tree1 = await makeTree(ctx, [{ mode: BLOB_MODE, name: 'f.txt', id: blobA }]);
        const commit1 = await makeCommit(ctx, tree1, [], 'tagged commit', 1);
        const tag: Tag = {
          type: 'tag',
          id: '' as ObjectId,
          data: {
            object: commit1,
            objectType: 'commit',
            tagName: 'v1.0',
            message: 'release 1.0',
            extraHeaders: [],
          },
        };
        const tagId = await writeObject(ctx, tag);

        // Act
        const result = await sut(ctx, { wants: [tagId], haves: [] });

        // Assert
        expect(sorted(result.objects)).toEqual(sorted([tagId, commit1, tree1, blobA]));
        expect(result.boundary).toEqual([]);
      });
    });
  });

  describe('Given maxObjects cap of 1 and a commit with a tree', () => {
    describe('When enumerateBundleObjects is called', () => {
      it('Then throws PACK_TOO_LARGE when the second object would be emitted', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const sut = enumerateBundleObjects;

        const blobA = await makeBlob(ctx, 'A');
        const tree1 = await makeTree(ctx, [{ mode: BLOB_MODE, name: 'f.txt', id: blobA }]);
        const commit1 = await makeCommit(ctx, tree1, [], 'c', 1);

        // Act + Assert
        try {
          await sut(ctx, { wants: [commit1], haves: [], maxObjects: 1 });
          expect.unreachable('expected PACK_TOO_LARGE to be thrown');
        } catch (error) {
          expect(error).toBeInstanceOf(TsgitError);
          expect((error as TsgitError).data.code).toBe('PACK_TOO_LARGE');
        }
      });
    });
  });
});
