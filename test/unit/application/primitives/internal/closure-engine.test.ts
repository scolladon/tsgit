/**
 * Unit tests for the shared reachability closure engine's walk tier.
 *
 * Coverage:
 *  - commits-only vs `objects: true` (trees/blobs, each carrying a path)
 *  - tag peeling (single tag, tag-of-tag chain)
 *  - non-commit wants (a tree want's own subtree; a blob want alone)
 *  - gitlink entries are skipped
 *  - empty wants / wants fully covered by `not` / an unborn repository
 *  - the haves relation: the walk's superset over the exact difference, and
 *    every extra object reachable from the `not` tip
 *  - refusal on an unresolvable want/not id
 *  - the shared cap (`MAX_PUSH_OBJECTS`, reused via `tryEmit`)
 *  - dedup across commits sharing a tree
 */
import { describe, expect, it, vi } from 'vitest';

import { enumerateBundleObjects } from '../../../../../src/application/primitives/enumerate-bundle-objects.js';
import { computeClosure } from '../../../../../src/application/primitives/internal/closure-engine.js';
import { writeObject } from '../../../../../src/application/primitives/write-object.js';
import { writeTree } from '../../../../../src/application/primitives/write-tree.js';
import { TsgitError } from '../../../../../src/domain/index.js';
import type {
  AuthorIdentity,
  Blob,
  Commit,
  FileMode,
  ObjectId,
  Tag,
} from '../../../../../src/domain/objects/index.js';
import type { Context } from '../../../../../src/ports/context.js';
import { buildSeededContext } from '../fixtures.js';

const AUTHOR: AuthorIdentity = {
  name: 'A',
  email: 'a@a',
  timestamp: 0,
  timezoneOffset: '+0000',
};

const writeBlob = async (ctx: Context, content: string): Promise<ObjectId> => {
  const blob: Blob = {
    type: 'blob',
    content: new TextEncoder().encode(content),
    id: '' as ObjectId,
  };
  return writeObject(ctx, blob);
};

const writeCommit = async (
  ctx: Context,
  tree: ObjectId,
  parents: ReadonlyArray<ObjectId>,
  message: string,
): Promise<ObjectId> => {
  const commit: Commit = {
    type: 'commit',
    id: '' as ObjectId,
    data: { tree, parents, author: AUTHOR, committer: AUTHOR, message, extraHeaders: [] },
  };
  return writeObject(ctx, commit);
};

const writeTag = async (
  ctx: Context,
  target: ObjectId,
  targetType: 'commit' | 'tag',
  tagName: string,
): Promise<ObjectId> => {
  const tag: Tag = {
    type: 'tag',
    id: '' as ObjectId,
    data: {
      object: target,
      objectType: targetType,
      tagName,
      tagger: AUTHOR,
      message: `${tagName}\n`,
      extraHeaders: [],
    },
  };
  return writeObject(ctx, tag);
};

interface LinearChain {
  readonly c1: ObjectId;
  readonly c2: ObjectId;
  readonly c3: ObjectId;
  readonly t1: ObjectId;
  readonly t2: ObjectId;
  readonly t3: ObjectId;
  readonly b1: ObjectId;
  readonly b2: ObjectId;
  readonly b3: ObjectId;
}

/** A 3-commit chain, each generation with its own tree and blob. */
const buildLinearChain = async (ctx: Context): Promise<LinearChain> => {
  const b1 = await writeBlob(ctx, 'gen-1');
  const t1 = await writeTree(ctx, [{ name: 'file.txt', mode: '100644' as FileMode, id: b1 }]);
  const c1 = await writeCommit(ctx, t1, [], 'gen-1');
  const b2 = await writeBlob(ctx, 'gen-2');
  const t2 = await writeTree(ctx, [{ name: 'file.txt', mode: '100644' as FileMode, id: b2 }]);
  const c2 = await writeCommit(ctx, t2, [c1], 'gen-2');
  const b3 = await writeBlob(ctx, 'gen-3');
  const t3 = await writeTree(ctx, [{ name: 'file.txt', mode: '100644' as FileMode, id: b3 }]);
  const c3 = await writeCommit(ctx, t3, [c2], 'gen-3');
  return { c1, c2, c3, t1, t2, t3, b1, b2, b3 };
};

interface HavesFixture {
  readonly ctx: Context;
  readonly root: ObjectId;
  readonly branchA: ObjectId;
  readonly branchB: ObjectId;
}

/**
 * `root` carries `shared.txt`. `branchA` (the have tip) replaces it with an
 * unrelated file, so marking `branchA`'s own tree never marks the shared
 * blob. `branchB` (the want) keeps `shared.txt` unmodified — reachable from
 * `root`, which is itself reachable from `branchA` only through ancestry the
 * engine deliberately does not mark. That gap is what the walk's superset
 * behaviour measures.
 */
const buildHavesFixture = async (): Promise<HavesFixture> => {
  const ctx = await buildSeededContext();
  const sharedBlob = await writeBlob(ctx, 'shared');
  const rootTree = await writeTree(ctx, [
    { name: 'shared.txt', mode: '100644' as FileMode, id: sharedBlob },
  ]);
  const root = await writeCommit(ctx, rootTree, [], 'root');

  const aOnlyBlob = await writeBlob(ctx, 'a-only');
  const treeA = await writeTree(ctx, [
    { name: 'a-only.txt', mode: '100644' as FileMode, id: aOnlyBlob },
  ]);
  const branchA = await writeCommit(ctx, treeA, [root], 'branch-a');

  const bOnlyBlob = await writeBlob(ctx, 'b-only');
  const treeB = await writeTree(ctx, [
    { name: 'shared.txt', mode: '100644' as FileMode, id: sharedBlob },
    { name: 'b-only.txt', mode: '100644' as FileMode, id: bOnlyBlob },
  ]);
  const branchB = await writeCommit(ctx, treeB, [root], 'branch-b');

  return { ctx, root, branchA, branchB };
};

describe('computeClosure', () => {
  describe('Given a 3-commit chain', () => {
    describe('When computeClosure is called with objects: false', () => {
      it('Then it returns only the three commit ids', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const chain = await buildLinearChain(ctx);
        const sut = computeClosure;

        // Act
        const result = await sut(ctx, { wants: [chain.c3], not: [], objects: false });

        // Assert
        const ids = new Set(result.objects.map((o) => o.id));
        expect(ids).toEqual(new Set([chain.c1, chain.c2, chain.c3]));
        expect(result.objects.every((o) => o.type === 'commit')).toBe(true);
      });
    });
  });

  describe('Given the same 3-commit chain', () => {
    describe('When computeClosure is called with objects: true', () => {
      it('Then it returns commits, trees, and blobs, each typed correctly and trees/blobs carrying a path', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const chain = await buildLinearChain(ctx);
        const sut = computeClosure;

        // Act
        const result = await sut(ctx, { wants: [chain.c3], not: [], objects: true });

        // Assert
        const byId = new Map(result.objects.map((o) => [o.id, o]));
        expect(new Set(byId.keys())).toEqual(
          new Set([
            chain.c1,
            chain.c2,
            chain.c3,
            chain.t1,
            chain.t2,
            chain.t3,
            chain.b1,
            chain.b2,
            chain.b3,
          ]),
        );
        expect(byId.get(chain.c1)?.type).toBe('commit');
        expect(byId.get(chain.t1)?.type).toBe('tree');
        expect(byId.get(chain.b1)?.type).toBe('blob');
        expect(byId.get(chain.t1)?.path).toBe('');
        expect(byId.get(chain.b1)?.path).toBe('file.txt');
      });
    });
  });

  describe('Given a want that is an annotated tag', () => {
    describe('When computeClosure is called', () => {
      it('Then the tag oid and the peeled commit are both in the result', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const blobId = await writeBlob(ctx, 'tagged');
        const treeId = await writeTree(ctx, [
          { name: 'f.txt', mode: '100644' as FileMode, id: blobId },
        ]);
        const commitId = await writeCommit(ctx, treeId, [], 'tagged');
        const tagId = await writeTag(ctx, commitId, 'commit', 'v1.0');
        const sut = computeClosure;

        // Act
        const result = await sut(ctx, { wants: [tagId], not: [], objects: false });

        // Assert
        const ids = new Set(result.objects.map((o) => o.id));
        expect(ids).toEqual(new Set([tagId, commitId]));
        expect(result.objects.find((o) => o.id === tagId)?.type).toBe('tag');
      });
    });
  });

  describe('Given a tag-of-tag chain', () => {
    describe('When computeClosure is called', () => {
      it('Then both tag oids and the peeled commit are in the result', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const blobId = await writeBlob(ctx, 'deep-tagged');
        const treeId = await writeTree(ctx, [
          { name: 'f.txt', mode: '100644' as FileMode, id: blobId },
        ]);
        const commitId = await writeCommit(ctx, treeId, [], 'deep-tagged');
        const innerTagId = await writeTag(ctx, commitId, 'commit', 'v1');
        const outerTagId = await writeTag(ctx, innerTagId, 'tag', 'v1-release');
        const sut = computeClosure;

        // Act
        const result = await sut(ctx, { wants: [outerTagId], not: [], objects: false });

        // Assert
        const ids = new Set(result.objects.map((o) => o.id));
        expect(ids).toEqual(new Set([outerTagId, innerTagId, commitId]));
      });
    });
  });

  describe('Given a want that resolves to a tree', () => {
    describe('When computeClosure is called with objects: false', () => {
      it('Then it contributes itself plus its own subtree', async () => {
        // Arrange — the subtree is emitted regardless of `objects`, since a
        // tree want has no parents to gate that flag against.
        const ctx = await buildSeededContext();
        const nestedBlobId = await writeBlob(ctx, 'nested');
        const subTreeId = await writeTree(ctx, [
          { name: 'deep.txt', mode: '100644' as FileMode, id: nestedBlobId },
        ]);
        const topBlobId = await writeBlob(ctx, 'top');
        const rootTreeId = await writeTree(ctx, [
          { name: 'top.txt', mode: '100644' as FileMode, id: topBlobId },
          { name: 'sub', mode: '40000' as FileMode, id: subTreeId },
        ]);
        const sut = computeClosure;

        // Act
        const result = await sut(ctx, { wants: [rootTreeId], not: [], objects: false });

        // Assert
        const ids = new Set(result.objects.map((o) => o.id));
        expect(ids).toEqual(new Set([rootTreeId, subTreeId, nestedBlobId, topBlobId]));
        expect(result.objects.find((o) => o.id === rootTreeId)?.path).toBe('');
        expect(result.objects.find((o) => o.id === nestedBlobId)?.path).toBe('sub/deep.txt');
      });
    });
  });

  describe('Given a want that resolves to a blob', () => {
    describe('When computeClosure is called', () => {
      it('Then it contributes only itself, with no path', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const blobId = await writeBlob(ctx, 'standalone');
        const sut = computeClosure;

        // Act
        const result = await sut(ctx, { wants: [blobId], not: [], objects: false });

        // Assert
        expect(result.objects).toEqual([{ id: blobId, type: 'blob', path: undefined }]);
      });
    });
  });

  describe('Given a commit whose tree contains a gitlink entry', () => {
    describe('When computeClosure is called with objects: true', () => {
      it('Then the gitlink oid is not emitted', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const blobId = await writeBlob(ctx, 'normal');
        const gitlinkOid = 'c'.repeat(40) as ObjectId;
        const treeId = await writeTree(ctx, [
          { name: 'submodule', mode: '160000' as FileMode, id: gitlinkOid },
          { name: 'f.txt', mode: '100644' as FileMode, id: blobId },
        ]);
        const commitId = await writeCommit(ctx, treeId, [], 'with submodule');
        const sut = computeClosure;

        // Act
        const result = await sut(ctx, { wants: [commitId], not: [], objects: true });

        // Assert
        const ids = new Set(result.objects.map((o) => o.id));
        expect(ids.has(gitlinkOid)).toBe(false);
        expect(ids.has(blobId)).toBe(true);
      });
    });
  });

  describe('Given a not id that is a tree with a nested subdirectory', () => {
    describe('When computeClosure is called with objects: true', () => {
      it('Then the tree, its nested contents, and the commit that owns it are all excluded from objects', async () => {
        // Arrange — the not-side marking recurses into `sub` to mark its
        // nested blob too, without needing a commit wrapper at all.
        const ctx = await buildSeededContext();
        const nestedBlobId = await writeBlob(ctx, 'nested');
        const innerTreeId = await writeTree(ctx, [
          { name: 'deep.txt', mode: '100644' as FileMode, id: nestedBlobId },
        ]);
        const directBlobId = await writeBlob(ctx, 'direct');
        const outerTreeId = await writeTree(ctx, [
          { name: 'top.txt', mode: '100644' as FileMode, id: directBlobId },
          { name: 'sub', mode: '40000' as FileMode, id: innerTreeId },
        ]);
        const commitId = await writeCommit(ctx, outerTreeId, [], 'owns the tree');
        const sut = computeClosure;

        // Act
        const result = await sut(ctx, {
          wants: [commitId],
          not: [outerTreeId],
          objects: true,
        });

        // Assert — only the commit remains; every object under the marked
        // tree (including the nested one) is excluded.
        expect(result.objects).toEqual([{ id: commitId, type: 'commit', path: undefined }]);
      });
    });
  });

  describe('Given a not id that is a blob', () => {
    describe('When computeClosure is called with objects: true', () => {
      it('Then only that blob is excluded from the want tree', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const markedBlobId = await writeBlob(ctx, 'excluded directly');
        const otherBlobId = await writeBlob(ctx, 'kept');
        const treeId = await writeTree(ctx, [
          { name: 'z.txt', mode: '100644' as FileMode, id: markedBlobId },
          { name: 'other.txt', mode: '100644' as FileMode, id: otherBlobId },
        ]);
        const commitId = await writeCommit(ctx, treeId, [], 'with one excluded blob');
        const sut = computeClosure;

        // Act
        const result = await sut(ctx, {
          wants: [commitId],
          not: [markedBlobId],
          objects: true,
        });

        // Assert
        const ids = new Set(result.objects.map((o) => o.id));
        expect(ids.has(markedBlobId)).toBe(false);
        expect(ids.has(otherBlobId)).toBe(true);
        expect(ids.has(treeId)).toBe(true);
      });
    });
  });

  describe('Given a not id whose tree references the same subtree from two entries', () => {
    describe('When computeClosure marks it uninteresting', () => {
      it('Then the shared subtree and its contents are excluded once, without re-descending indefinitely', async () => {
        // Arrange — 'a' and 'b' point at the identical subtree id, exercising
        // the marking pass's own already-marked short-circuit.
        const ctx = await buildSeededContext();
        const sharedBlobId = await writeBlob(ctx, 'shared-leaf');
        const sharedTreeId = await writeTree(ctx, [
          { name: 'leaf.txt', mode: '100644' as FileMode, id: sharedBlobId },
        ]);
        const outerTreeId = await writeTree(ctx, [
          { name: 'a', mode: '40000' as FileMode, id: sharedTreeId },
          { name: 'b', mode: '40000' as FileMode, id: sharedTreeId },
        ]);
        const commitId = await writeCommit(ctx, outerTreeId, [], 'shared subtree twice');
        const sut = computeClosure;

        // Act
        const result = await sut(ctx, {
          wants: [commitId],
          not: [outerTreeId],
          objects: true,
        });

        // Assert — only the commit remains; the shared subtree and its blob
        // are excluded.
        expect(result.objects).toEqual([{ id: commitId, type: 'commit', path: undefined }]);
      });
    });
  });

  describe('Given a not tree that contains a gitlink entry', () => {
    describe('When computeClosure marks it uninteresting', () => {
      it('Then the gitlink target is skipped rather than read as an object', async () => {
        // Arrange — the gitlink oid is never written; marking must not try
        // to read it as a tree/blob.
        const ctx = await buildSeededContext();
        const keptBlobId = await writeBlob(ctx, 'want-side kept');
        const markedBlobId = await writeBlob(ctx, 'not-side marked');
        const gitlinkOid = 'f'.repeat(40) as ObjectId;
        const notTreeId = await writeTree(ctx, [
          { name: 'submodule', mode: '160000' as FileMode, id: gitlinkOid },
          { name: 'marked.txt', mode: '100644' as FileMode, id: markedBlobId },
        ]);
        const wantTreeId = await writeTree(ctx, [
          { name: 'marked.txt', mode: '100644' as FileMode, id: markedBlobId },
          { name: 'kept.txt', mode: '100644' as FileMode, id: keptBlobId },
        ]);
        const commitId = await writeCommit(ctx, wantTreeId, [], 'with gitlink in not tree');
        const sut = computeClosure;

        // Act
        const result = await sut(ctx, {
          wants: [commitId],
          not: [notTreeId],
          objects: true,
        });

        // Assert — no throw (implicit); the marked blob is excluded and the
        // other blob is kept.
        const ids = new Set(result.objects.map((o) => o.id));
        expect(ids.has(markedBlobId)).toBe(false);
        expect(ids.has(keptBlobId)).toBe(true);
      });
    });
  });

  describe('Given a not id nested 1025 levels deep', () => {
    describe('When computeClosure marks it uninteresting', () => {
      it('Then it throws TREE_DEPTH_EXCEEDED, not a stack overflow', async () => {
        // Arrange — mirrors enumerate-bundle-objects.ts's own deep-tree guard test.
        const ctx = await buildSeededContext();
        const PHANTOM_ID = 'a'.repeat(40) as ObjectId;
        let current: ObjectId = PHANTOM_ID;
        for (let i = 0; i < 1025; i += 1) {
          current = await writeTree(ctx, [{ name: 'sub', mode: '40000' as FileMode, id: current }]);
        }
        const blobId = await writeBlob(ctx, 'unreachable want');
        const treeId = await writeTree(ctx, [
          { name: 'f.txt', mode: '100644' as FileMode, id: blobId },
        ]);
        const commitId = await writeCommit(ctx, treeId, [], 'shallow want');
        const sut = computeClosure;

        // Act
        let caught: unknown;
        try {
          await sut(ctx, { wants: [commitId], not: [current], objects: false });
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as TsgitError).data.code).toBe('TREE_DEPTH_EXCEEDED');
      });
    });
  });

  describe('Given a not id that is an annotated tag', () => {
    describe('When computeClosure is called', () => {
      it('Then the tag is peeled to its commit before marking', async () => {
        // Arrange — the tag peels to the very commit the want resolves to,
        // so a correct peel yields the empty result "wants fully covered by
        // not" already proves for a plain commit boundary.
        const ctx = await buildSeededContext();
        const blobId = await writeBlob(ctx, 'tag-excluded');
        const treeId = await writeTree(ctx, [
          { name: 'f.txt', mode: '100644' as FileMode, id: blobId },
        ]);
        const commitId = await writeCommit(ctx, treeId, [], 'tag-excluded commit');
        const tagId = await writeTag(ctx, commitId, 'commit', 'boundary');
        const sut = computeClosure;

        // Act
        const result = await sut(ctx, { wants: [commitId], not: [tagId], objects: true });

        // Assert
        expect(result.objects).toEqual([]);
      });
    });
  });

  describe('Given an empty wants array on a repository with existing history', () => {
    describe('When computeClosure is called', () => {
      it('Then it returns an empty result without throwing', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await buildLinearChain(ctx);
        const sut = computeClosure;

        // Act
        const result = await sut(ctx, { wants: [], not: [], objects: true });

        // Assert
        expect(result.objects).toEqual([]);
      });
    });
  });

  describe('Given wants fully covered by not', () => {
    describe('When computeClosure is called', () => {
      it('Then it returns an empty result', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const blobId = await writeBlob(ctx, 'covered');
        const treeId = await writeTree(ctx, [
          { name: 'f.txt', mode: '100644' as FileMode, id: blobId },
        ]);
        const commitId = await writeCommit(ctx, treeId, [], 'covered');
        const sut = computeClosure;

        // Act
        const result = await sut(ctx, { wants: [commitId], not: [commitId], objects: true });

        // Assert
        expect(result.objects).toEqual([]);
      });
    });
  });

  describe('Given an unborn HEAD (a repository with no objects at all)', () => {
    describe('When computeClosure is called with empty wants', () => {
      it('Then it returns an empty result without throwing', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const sut = computeClosure;

        // Act
        const result = await sut(ctx, { wants: [], not: [], objects: false });

        // Assert
        expect(result.objects).toEqual([]);
      });
    });
  });

  describe('Given a fixture that repeats blob content across the have boundary', () => {
    describe('When computeClosure walks the interesting side excluding the have tip', () => {
      it('Then the result is a superset of the exact difference and every extra object is reachable from the not tip', async () => {
        // Arrange
        const { ctx, branchA, branchB } = await buildHavesFixture();
        const sut = computeClosure;

        // Act
        const actual = await sut(ctx, { wants: [branchB], not: [branchA], objects: true });
        const exact = await enumerateBundleObjects(ctx, { wants: [branchB], haves: [branchA] });
        const reachableFromNotTip = await sut(ctx, { wants: [branchA], not: [], objects: true });

        // Assert — the walk's answer is a superset of the exact difference.
        const actualIds = new Set(actual.objects.map((o) => o.id));
        const exactIds = new Set(exact.objects);
        for (const id of exactIds) {
          expect(actualIds.has(id)).toBe(true);
        }

        // Assert — every extra object is reachable from the not tip alone.
        const notTipIds = new Set(reachableFromNotTip.objects.map((o) => o.id));
        const extra = [...actualIds].filter((id) => !exactIds.has(id));
        for (const id of extra) {
          expect(notTipIds.has(id)).toBe(true);
        }
      });
    });
  });

  describe('Given the same have-boundary fixture', () => {
    describe('When computeClosure and the exact difference are compared', () => {
      it('Then the difference set is non-empty', async () => {
        // Arrange — proves the superset check above is not vacuous.
        const { ctx, branchA, branchB } = await buildHavesFixture();
        const sut = computeClosure;

        // Act
        const actual = await sut(ctx, { wants: [branchB], not: [branchA], objects: true });
        const exact = await enumerateBundleObjects(ctx, { wants: [branchB], haves: [branchA] });

        // Assert
        const actualIds = new Set(actual.objects.map((o) => o.id));
        const exactIds = new Set(exact.objects);
        const extra = [...actualIds].filter((id) => !exactIds.has(id));
        expect(extra.length).toBeGreaterThan(0);
      });
    });
  });

  describe('Given a want that does not resolve to any object', () => {
    describe('When computeClosure is called', () => {
      it('Then it throws OBJECT_NOT_FOUND for that id', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const missing = 'd'.repeat(40) as ObjectId;
        const sut = computeClosure;

        // Act
        let caught: unknown;
        try {
          await sut(ctx, { wants: [missing], not: [], objects: false });
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        const data = (caught as TsgitError).data as { code: string; id: string };
        expect(data.code).toBe('OBJECT_NOT_FOUND');
        expect(data.id).toBe(missing);
      });
    });
  });

  describe('Given a not id that does not resolve to any object', () => {
    describe('When computeClosure is called', () => {
      it('Then it throws OBJECT_NOT_FOUND for that id', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const blobId = await writeBlob(ctx, 'ok');
        const treeId = await writeTree(ctx, [
          { name: 'f.txt', mode: '100644' as FileMode, id: blobId },
        ]);
        const commitId = await writeCommit(ctx, treeId, [], 'ok');
        const missing = 'e'.repeat(40) as ObjectId;
        const sut = computeClosure;

        // Act
        let caught: unknown;
        try {
          await sut(ctx, { wants: [commitId], not: [missing], objects: false });
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        const data = (caught as TsgitError).data as { code: string; id: string };
        expect(data.code).toBe('OBJECT_NOT_FOUND');
        expect(data.id).toBe(missing);
      });
    });
  });

  describe('Given two commits sharing the same tree', () => {
    describe('When computeClosure is called with objects: true', () => {
      it('Then the shared tree and blob are each emitted exactly once', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const blobId = await writeBlob(ctx, 'shared');
        const treeId = await writeTree(ctx, [
          { name: 'f.txt', mode: '100644' as FileMode, id: blobId },
        ]);
        const parentId = await writeCommit(ctx, treeId, [], 'gen-1');
        const childId = await writeCommit(ctx, treeId, [parentId], 'gen-2');
        const sut = computeClosure;

        // Act
        const result = await sut(ctx, { wants: [childId], not: [], objects: true });

        // Assert
        expect(result.objects.filter((o) => o.id === treeId)).toHaveLength(1);
        expect(result.objects.filter((o) => o.id === blobId)).toHaveLength(1);
        expect(result.objects.some((o) => o.id === parentId)).toBe(true);
        expect(result.objects.some((o) => o.id === childId)).toBe(true);
      });
    });
  });

  describe('Given MAX_PUSH_OBJECTS lowered to below the closure size', () => {
    describe('When computeClosure is called', () => {
      it('Then it throws PACK_TOO_LARGE with objectCount and limit', async () => {
        // Arrange — mock the shared cap down so a 3-object closure trips it
        // without needing a million real objects. Everything the test needs
        // (the engine, the error class, and the fixture builders) is
        // re-imported from the same fresh module graph, so the mock takes
        // effect uniformly and no stale module instance leaks in.
        vi.resetModules();
        vi.doMock('../../../../../src/application/primitives/types.js', async (importOriginal) => {
          const actual =
            await importOriginal<
              typeof import('../../../../../src/application/primitives/types.js')
            >();
          return { ...actual, MAX_PUSH_OBJECTS: 2 };
        });

        try {
          const [
            { computeClosure: sut },
            { TsgitError: ScopedTsgitError },
            { writeObject: scopedWriteObject },
            { writeTree: scopedWriteTree },
            { buildSeededContext: scopedBuildSeededContext },
          ] = await Promise.all([
            import('../../../../../src/application/primitives/internal/closure-engine.js'),
            import('../../../../../src/domain/error.js'),
            import('../../../../../src/application/primitives/write-object.js'),
            import('../../../../../src/application/primitives/write-tree.js'),
            import('../fixtures.js'),
          ]);
          const ctx = await scopedBuildSeededContext();
          const blob: Blob = {
            type: 'blob',
            content: new TextEncoder().encode('capped'),
            id: '' as ObjectId,
          };
          const blobId = await scopedWriteObject(ctx, blob);
          const treeId = await scopedWriteTree(ctx, [
            { name: 'f.txt', mode: '100644' as FileMode, id: blobId },
          ]);
          const commit: Commit = {
            type: 'commit',
            id: '' as ObjectId,
            data: {
              tree: treeId,
              parents: [],
              author: AUTHOR,
              committer: AUTHOR,
              message: 'capped',
              extraHeaders: [],
            },
          };
          const commitId = await scopedWriteObject(ctx, commit);

          // Act
          let caught: unknown;
          try {
            await sut(ctx, { wants: [commitId], not: [], objects: true });
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(caught).toBeInstanceOf(ScopedTsgitError);
          const data = (caught as InstanceType<typeof ScopedTsgitError>).data as {
            code: string;
            limit: number;
            objectCount: number;
          };
          expect(data.code).toBe('PACK_TOO_LARGE');
          expect(data.limit).toBe(2);
          expect(data.objectCount).toBeGreaterThan(data.limit);
        } finally {
          vi.doUnmock('../../../../../src/application/primitives/types.js');
          vi.resetModules();
        }
      });
    });
  });
});
