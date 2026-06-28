import { describe, expect, it } from 'vitest';
import { createCommit } from '../../../../src/application/primitives/create-commit.js';
import {
  type BundleObjectClosure,
  enumerateBundleObjects,
} from '../../../../src/application/primitives/enumerate-bundle-objects.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import { writeTree } from '../../../../src/application/primitives/write-tree.js';
import { TsgitError } from '../../../../src/domain/error.js';
import {
  type AuthorIdentity,
  type Blob,
  FILE_MODE,
  type FileMode,
  type ObjectId,
  type Tag,
  type TreeEntry,
} from '../../../../src/domain/objects/index.js';
import type { Context } from '../../../../src/ports/context.js';
import { buildSeededContext, instrumentedContext } from './fixtures.js';

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
          const data = (error as TsgitError).data as {
            readonly code: string;
            readonly objectCount: number;
            readonly limit: number;
          };
          expect(data.code).toBe('PACK_TOO_LARGE');
          // commit1 is emitted first (count reaches 1 = cap), then the cap fires
          // when the tree would be emitted as the second object → objectCount = 2
          expect(data.objectCount).toBe(2);
          expect(data.limit).toBe(1);
        }
      });
    });
  });

  describe('Given two commits whose trees each contain the same shared subtree id', () => {
    describe('When enumerateBundleObjects is called with wants=[commitB] haves=[]', () => {
      it('Then the shared subtree object is read from the object store exactly once', async () => {
        // Arrange
        const base = await buildSeededContext();
        const blobX = await makeBlob(base, 'X');
        const sharedTree = await makeTree(base, [{ mode: BLOB_MODE, name: 'x.txt', id: blobX }]);
        const blobA = await makeBlob(base, 'A');
        const blobB = await makeBlob(base, 'B');
        const treeA = await makeTree(base, [
          { mode: BLOB_MODE, name: 'a.txt', id: blobA },
          { mode: FILE_MODE.DIRECTORY, name: 'sub', id: sharedTree },
        ]);
        const treeB = await makeTree(base, [
          { mode: BLOB_MODE, name: 'b.txt', id: blobB },
          { mode: FILE_MODE.DIRECTORY, name: 'sub', id: sharedTree },
        ]);
        const commitA = await makeCommit(base, treeA, [], 'A', 1);
        const commitB = await makeCommit(base, treeB, [commitA], 'B', 2);
        const { ctx, calls } = instrumentedContext(base);
        const sut = enumerateBundleObjects;

        // Act
        const result = await sut(ctx, { wants: [commitB], haves: [] });

        // Assert — object set is correct
        expect(result.objects).toContain(sharedTree);
        // Assert — shared subtree was read from disk exactly once (not once per commit)
        const sharedPath = `${ctx.layout.gitDir}/objects/${sharedTree.slice(0, 2)}/${sharedTree.slice(2)}`;
        const sharedReadCount = calls().filter(
          (c) => c.method === 'read' && c.path === sharedPath,
        ).length;
        expect(sharedReadCount).toBe(1);
      });
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Haves-side tree walk: isDirectory guard in collectTreeObjects
// ─────────────────────────────────────────────────────────────────────────────

describe('enumerateBundleObjects — haves-side isDirectory guard', () => {
  describe('Given a haves commit whose tree contains a subdirectory with a blob', () => {
    describe('When the wants commit references the same subdirectory and the haves commit is excluded', () => {
      it('Then the blob inside the shared subdirectory is absent from objects', async () => {
        // Arrange — haves tree has a subdirectory containing blobX; wants tree
        // shares that same subtree ID plus an extra blobY.  Without the
        // !isDirectory guard, the subtree is added to uninteresting but its
        // contents (blobX) are never collected, so blobX leaks into the bundle.
        const ctx = await buildSeededContext();
        const blobX = await makeBlob(ctx, 'X');
        const subTree = await makeTree(ctx, [{ mode: BLOB_MODE, name: 'x.txt', id: blobX }]);
        const haveTree = await makeTree(ctx, [
          { mode: FILE_MODE.DIRECTORY, name: 'sub', id: subTree },
        ]);
        const blobY = await makeBlob(ctx, 'Y');
        const wantTree = await makeTree(ctx, [
          { mode: FILE_MODE.DIRECTORY, name: 'sub', id: subTree },
          { mode: BLOB_MODE, name: 'y.txt', id: blobY },
        ]);
        const haveCommit = await makeCommit(ctx, haveTree, [], 'have', 1);
        const wantCommit = await makeCommit(ctx, wantTree, [haveCommit], 'want', 2);
        const sut = enumerateBundleObjects;

        // Act
        const result = await sut(ctx, { wants: [wantCommit], haves: [haveCommit] });

        // Assert
        expect(result.objects).not.toContain(blobX);
        expect(result.objects).toContain(blobY);
      });
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Wants-side tree walk: isGitlink guard in emitTreeObjects
// ─────────────────────────────────────────────────────────────────────────────

describe('enumerateBundleObjects — wants-side gitlink guard', () => {
  describe('Given a wants commit whose tree contains a gitlink entry', () => {
    describe('When enumerateBundleObjects is called with haves=[]', () => {
      it('Then the gitlink submodule OID is absent from objects', async () => {
        // Arrange — gitlinks are external submodule references; they must NOT
        // be emitted as objects in the bundle.  Without the isGitlink guard,
        // the mode-'160000' entry would pass the isDirectory check and be
        // emitted via tryEmit.
        const ctx = await buildSeededContext();
        const GITLINK_OID = 'c'.repeat(40) as ObjectId;
        const blobA = await makeBlob(ctx, 'A');
        const tree = await makeTree(ctx, [
          { mode: FILE_MODE.GITLINK, name: 'sub', id: GITLINK_OID },
          { mode: BLOB_MODE, name: 'a.txt', id: blobA },
        ]);
        const commit = await makeCommit(ctx, tree, [], 'with-gitlink', 1);
        const sut = enumerateBundleObjects;

        // Act
        const result = await sut(ctx, { wants: [commit], haves: [] });

        // Assert
        expect(result.objects).not.toContain(GITLINK_OID);
        expect(result.objects).toContain(blobA);
      });
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ignoreMissing: missing parents do not abort the walk
// ─────────────────────────────────────────────────────────────────────────────

describe('enumerateBundleObjects — ignoreMissing on missing parents', () => {
  describe('Given a haves commit that references a non-existent parent', () => {
    describe('When enumerateBundleObjects is called', () => {
      it('Then completes without error and still excludes the haves commit from objects', async () => {
        // Arrange — ignoreMissing:true in collectUninteresting; without it the
        // walk would throw when it cannot resolve the phantom parent.
        const ctx = await buildSeededContext();
        const PHANTOM_PARENT = 'd'.repeat(40) as ObjectId;
        const blobA = await makeBlob(ctx, 'A');
        const tree1 = await makeTree(ctx, [{ mode: BLOB_MODE, name: 'a.txt', id: blobA }]);
        const haveCommit = await makeCommit(ctx, tree1, [PHANTOM_PARENT], 'have', 1);
        const blobB = await makeBlob(ctx, 'B');
        const tree2 = await makeTree(ctx, [
          { mode: BLOB_MODE, name: 'a.txt', id: blobA },
          { mode: BLOB_MODE, name: 'b.txt', id: blobB },
        ]);
        const wantCommit = await makeCommit(ctx, tree2, [haveCommit], 'want', 2);
        const sut = enumerateBundleObjects;

        // Act
        let thrown: unknown;
        const result = await sut(ctx, { wants: [wantCommit], haves: [haveCommit] }).catch((err) => {
          thrown = err;
          return null;
        });

        // Assert — no error; haveCommit excluded as boundary
        expect(thrown).toBeUndefined();
        expect(result).not.toBeNull();
        expect(result!.objects).not.toContain(haveCommit);
        expect(result!.objects).toContain(blobB);
      });
    });
  });

  describe('Given a wants commit that references a non-existent parent', () => {
    describe('When enumerateBundleObjects is called with haves=[]', () => {
      it('Then completes without error and emits the wants commit', async () => {
        // Arrange — ignoreMissing:true in walkInteresting; without it the walk
        // would throw when it cannot resolve the phantom parent.
        const ctx = await buildSeededContext();
        const PHANTOM_PARENT = 'e'.repeat(40) as ObjectId;
        const blobA = await makeBlob(ctx, 'A');
        const tree = await makeTree(ctx, [{ mode: BLOB_MODE, name: 'a.txt', id: blobA }]);
        const wantCommit = await makeCommit(ctx, tree, [PHANTOM_PARENT], 'want', 1);
        const sut = enumerateBundleObjects;

        // Act
        let thrown: unknown;
        const result = await sut(ctx, { wants: [wantCommit], haves: [] }).catch((err) => {
          thrown = err;
          return null;
        });

        // Assert — no error; wantCommit and its objects are emitted
        expect(thrown).toBeUndefined();
        expect(result).not.toBeNull();
        expect(result!.objects).toContain(wantCommit);
      });
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Safety rails: depth guard and abort signal
// ─────────────────────────────────────────────────────────────────────────────

describe('enumerateBundleObjects — tree-walk safety rails', () => {
  describe('Given a wants commit pointing to a tree nested 1025 levels deep', () => {
    describe('When enumerateBundleObjects is called', () => {
      it('Then throws TREE_DEPTH_EXCEEDED, not a RangeError', async () => {
        // Arrange — build 1025 wrapper trees around a phantom sub-tree ID.
        // The phantom is never read from storage; the guard fires before the
        // readObject call at depth 1025 (> MAX_TREE_DEPTH 1024).
        const ctx = await buildSeededContext();
        const PHANTOM_ID = 'a'.repeat(40) as ObjectId;
        let current: ObjectId = PHANTOM_ID;
        for (let i = 0; i < 1025; i++) {
          current = await makeTree(ctx, [{ mode: FILE_MODE.DIRECTORY, name: 'sub', id: current }]);
        }
        const commit = await makeCommit(ctx, current, [], 'deep', 1);

        // Act
        let thrown: unknown;
        try {
          await enumerateBundleObjects(ctx, { wants: [commit], haves: [] });
        } catch (err) {
          thrown = err;
        }

        // Assert
        expect(thrown).toBeInstanceOf(TsgitError);
        expect((thrown as TsgitError).data.code).toBe('TREE_DEPTH_EXCEEDED');
      });
    });
  });

  describe('Given a wants commit pointing to a tree nested exactly 1025 levels deep with a real leaf blob', () => {
    describe('When enumerateBundleObjects is called', () => {
      it('Then succeeds without throwing TREE_DEPTH_EXCEEDED (depth 1024 is the last allowed level)', async () => {
        // Arrange — build 1024 wrapper trees around a real blob-containing tree.
        // The blob-containing tree sits at depth 1024; the depth guard fires only
        // at depth > 1024.  A depth>=1024 mutant would throw prematurely here.
        const ctx = await buildSeededContext();
        const leafBlob = await makeBlob(ctx, 'leaf');
        let current: ObjectId = await makeTree(ctx, [
          { mode: BLOB_MODE, name: 'f.txt', id: leafBlob },
        ]);
        for (let i = 0; i < 1024; i++) {
          current = await makeTree(ctx, [{ mode: FILE_MODE.DIRECTORY, name: 'sub', id: current }]);
        }
        const commit = await makeCommit(ctx, current, [], 'at-limit', 1);
        const sut = enumerateBundleObjects;

        // Act
        let thrown: unknown;
        const result = await sut(ctx, { wants: [commit], haves: [] }).catch((err) => {
          thrown = err;
          return null;
        });

        // Assert — no TREE_DEPTH_EXCEEDED; all objects present
        expect(thrown).toBeUndefined();
        expect(result).not.toBeNull();
        expect(result!.objects).toContain(leafBlob);
      });
    });
  });

  describe('Given a haves commit pointing to a tree nested 1026 levels deep', () => {
    describe('When enumerateBundleObjects is called', () => {
      it('Then throws TREE_DEPTH_EXCEEDED from the haves-side collectTreeObjects walk', async () => {
        // Arrange — build 1025 real wrapper trees around a phantom child.
        // collectTreeObjects (haves side) reaches depth 1025 when visiting the
        // phantom and throws.  A ConditionalExpression→false or depth-1 mutant
        // on the guard would never fire, yielding a different error instead.
        const ctx = await buildSeededContext();
        const PHANTOM_ID = 'b'.repeat(40) as ObjectId;
        let current: ObjectId = PHANTOM_ID;
        for (let i = 0; i < 1025; i++) {
          current = await makeTree(ctx, [{ mode: FILE_MODE.DIRECTORY, name: 'sub', id: current }]);
        }
        const haveCommit = await makeCommit(ctx, current, [], 'too-deep-have', 1);
        const wantBlob = await makeBlob(ctx, 'want');
        const wantTree = await makeTree(ctx, [{ mode: BLOB_MODE, name: 'w.txt', id: wantBlob }]);
        const wantCommit = await makeCommit(ctx, wantTree, [haveCommit], 'want', 2);
        const sut = enumerateBundleObjects;

        // Act
        let thrown: unknown;
        try {
          await sut(ctx, { wants: [wantCommit], haves: [haveCommit] });
        } catch (err) {
          thrown = err;
        }

        // Assert
        expect(thrown).toBeInstanceOf(TsgitError);
        expect((thrown as TsgitError).data.code).toBe('TREE_DEPTH_EXCEEDED');
      });
    });
  });

  describe('Given a haves commit pointing to a tree nested exactly 1025 levels deep with a real leaf blob', () => {
    describe('When enumerateBundleObjects is called', () => {
      it('Then succeeds without throwing TREE_DEPTH_EXCEEDED (depth 1024 is the last allowed level)', async () => {
        // Arrange — build 1024 wrapper trees around a real blob-containing tree.
        // collectTreeObjects reaches depth 1024 for the innermost tree (depth
        // guard fires at depth > 1024).  A depth>=1024 mutant would throw here.
        const ctx = await buildSeededContext();
        const leafBlob = await makeBlob(ctx, 'leaf-have');
        let current: ObjectId = await makeTree(ctx, [
          { mode: BLOB_MODE, name: 'f.txt', id: leafBlob },
        ]);
        for (let i = 0; i < 1024; i++) {
          current = await makeTree(ctx, [{ mode: FILE_MODE.DIRECTORY, name: 'sub', id: current }]);
        }
        const haveCommit = await makeCommit(ctx, current, [], 'have-at-limit', 1);
        const wantBlob = await makeBlob(ctx, 'new');
        const wantTree = await makeTree(ctx, [{ mode: BLOB_MODE, name: 'n.txt', id: wantBlob }]);
        const wantCommit = await makeCommit(ctx, wantTree, [haveCommit], 'want', 2);
        const sut = enumerateBundleObjects;

        // Act
        let thrown: unknown;
        const result = await sut(ctx, { wants: [wantCommit], haves: [haveCommit] }).catch((err) => {
          thrown = err;
          return null;
        });

        // Assert — no TREE_DEPTH_EXCEEDED
        expect(thrown).toBeUndefined();
        expect(result).not.toBeNull();
        expect(result!.objects).toContain(wantBlob);
      });
    });
  });

  describe('Given a commit with a two-level tree and a signal aborted while reading the root tree', () => {
    describe('When enumerateBundleObjects is called', () => {
      it('Then throws OPERATION_ABORTED (per-entry cancellation in the tree walk)', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const blob = await makeBlob(ctx, 'leaf content');
        const sub = await makeTree(ctx, [{ mode: BLOB_MODE, name: 'f.txt', id: blob }]);
        const root = await makeTree(ctx, [{ mode: FILE_MODE.DIRECTORY, name: 'dir', id: sub }]);
        const commit = await makeCommit(ctx, root, [], 'root', 1);

        const controller = new AbortController();
        const rootLoosePath = `${ctx.layout.gitDir}/objects/${root.slice(0, 2)}/${root.slice(2)}`;
        const spyCtx: Context = {
          ...ctx,
          signal: controller.signal,
          fs: {
            ...ctx.fs,
            read: async (p: string): Promise<Uint8Array> => {
              // Abort on the root-tree read; the next recursion (sub-tree)
              // will detect ctx.signal.aborted and throw OPERATION_ABORTED.
              if (p === rootLoosePath) controller.abort();
              return ctx.fs.read(p);
            },
          },
        };

        // Act
        let thrown: unknown;
        try {
          await enumerateBundleObjects(spyCtx, { wants: [commit], haves: [] });
        } catch (err) {
          thrown = err;
        }

        // Assert
        expect(thrown).toBeInstanceOf(TsgitError);
        expect((thrown as TsgitError).data.code).toBe('OPERATION_ABORTED');
      });
    });
  });
});
