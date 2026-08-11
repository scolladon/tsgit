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
import { getPackRegistry } from '../../../../../src/application/primitives/read-object.js';
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
import { lookupPackIndex, parsePackIndex } from '../../../../../src/domain/storage/index.js';
import type { Context } from '../../../../../src/ports/context.js';
import {
  type BitmapSpec,
  buildBitmap,
  buildMidx,
  type MidxSpec,
} from '../../../domain/storage/arbitraries.js';
import { buildSeededContext } from '../fixtures.js';
import { writeSyntheticBitmap, writeSyntheticPack } from '../pack-fixture.js';

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

/**
 * How many times `act` reads `id`'s own loose object off `ctx`'s filesystem —
 * the marking pass's I/O contract, which its result set alone cannot show.
 */
const countLooseReadsOf = async (
  ctx: Context,
  id: ObjectId,
  act: () => Promise<unknown>,
): Promise<number> => {
  const suffix = `${id.slice(0, 2)}/${id.slice(2)}`;
  const spy = vi.spyOn(ctx.fs, 'read');
  try {
    await act();
    return spy.mock.calls.filter(([path]) => path.endsWith(suffix)).length;
  } finally {
    spy.mockRestore();
  }
};

interface HavesFixture {
  readonly ctx: Context;
  readonly root: ObjectId;
  readonly have: ObjectId;
  readonly want: ObjectId;
}

/**
 * A 3-generation chain: `root` writes `shared.txt`, `have` (the not tip)
 * changes it away — so marking `have`'s own tree never marks the original
 * blob — then `want` changes it BACK to the exact content `root` used,
 * reusing `root`'s own tree wholesale. That blob (and tree) is reachable
 * from `have` only through `root`, one hop beyond the boundary the walk
 * marks: git's own boundary-commit discovery marks `have`'s own tree when
 * the interesting walk's parent pointers reach it, but never walks past it
 * to `root`'s. That gap is what the walk's superset behaviour measures.
 */
const buildHavesFixture = async (): Promise<HavesFixture> => {
  const ctx = await buildSeededContext();
  const sharedBlob = await writeBlob(ctx, 'shared');
  const rootTree = await writeTree(ctx, [
    { name: 'shared.txt', mode: '100644' as FileMode, id: sharedBlob },
  ]);
  const root = await writeCommit(ctx, rootTree, [], 'root');

  const changedBlob = await writeBlob(ctx, 'changed');
  const haveTree = await writeTree(ctx, [
    { name: 'shared.txt', mode: '100644' as FileMode, id: changedBlob },
  ]);
  const have = await writeCommit(ctx, haveTree, [root], 'have');

  // Reuses `rootTree` (and therefore `sharedBlob`) wholesale — same content,
  // one generation after `have` changed it away.
  const want = await writeCommit(ctx, rootTree, [have], 'want');

  return { ctx, root, have, want };
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
        const result = await sut(ctx, { tier: 'walk', wants: [chain.c3], not: [], objects: false });

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
        const result = await sut(ctx, { tier: 'walk', wants: [chain.c3], not: [], objects: true });

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
        const result = await sut(ctx, { tier: 'walk', wants: [tagId], not: [], objects: false });

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
        const result = await sut(ctx, {
          tier: 'walk',
          wants: [outerTagId],
          not: [],
          objects: false,
        });

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
        const result = await sut(ctx, {
          tier: 'walk',
          wants: [rootTreeId],
          not: [],
          objects: false,
        });

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
        const result = await sut(ctx, { tier: 'walk', wants: [blobId], not: [], objects: false });

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
        const result = await sut(ctx, { tier: 'walk', wants: [commitId], not: [], objects: true });

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
          tier: 'walk',
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
          tier: 'walk',
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
          tier: 'walk',
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

  describe('Given the same shared-subtree not tree, with objects: false', () => {
    describe('When computeClosure marks it uninteresting', () => {
      it('Then the shared subtree is read once, not once per reference', async () => {
        // Arrange — objects: false keeps the want side from walking any tree,
        // so every read of `sharedTreeId` is one the marking pass made.
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
        const reads = await countLooseReadsOf(ctx, sharedTreeId, () =>
          sut(ctx, { tier: 'walk', wants: [commitId], not: [outerTreeId], objects: false }),
        );

        // Assert
        expect(reads).toBe(1);
      });
    });
  });

  describe('Given a not id that is a blob, with objects: false', () => {
    describe('When computeClosure marks it uninteresting', () => {
      it('Then the read that identified it is the only one it costs', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const markedBlobId = await writeBlob(ctx, 'excluded directly');
        const treeId = await writeTree(ctx, [
          { name: 'z.txt', mode: '100644' as FileMode, id: markedBlobId },
        ]);
        const commitId = await writeCommit(ctx, treeId, [], 'with one excluded blob');
        const sut = computeClosure;

        // Act
        const reads = await countLooseReadsOf(ctx, markedBlobId, () =>
          sut(ctx, { tier: 'walk', wants: [commitId], not: [markedBlobId], objects: false }),
        );

        // Assert
        expect(reads).toBe(1);
      });
    });
  });

  describe('Given a not tree whose gitlink entry names an oid the want side holds as a blob', () => {
    describe('When computeClosure marks the not tree uninteresting', () => {
      it('Then the gitlink oid is left unmarked and that blob is still emitted', async () => {
        // Arrange — a gitlink records a commit oid from ANOTHER repository, so
        // marking it would exclude whatever this one happens to store under it.
        const ctx = await buildSeededContext();
        const sharedId = await writeBlob(ctx, 'not a submodule');
        const notTreeId = await writeTree(ctx, [
          { name: 'submodule', mode: '160000' as FileMode, id: sharedId },
        ]);
        const wantTreeId = await writeTree(ctx, [
          { name: 'kept.txt', mode: '100644' as FileMode, id: sharedId },
        ]);
        const commitId = await writeCommit(ctx, wantTreeId, [], 'shares the gitlink oid');
        const sut = computeClosure;

        // Act
        const result = await sut(ctx, {
          tier: 'walk',
          wants: [commitId],
          not: [notTreeId],
          objects: true,
        });

        // Assert
        const ids = new Set(result.objects.map((o) => o.id));
        expect(ids.has(sharedId)).toBe(true);
      });
    });
  });

  describe('Given a not tree whose regular-file entry names an object the repository lacks', () => {
    describe('When computeClosure marks it uninteresting', () => {
      it('Then the entry is marked without being read and the closure still answers', async () => {
        // Arrange — a blobless partial clone: the tree is present, the blob it
        // names never was.
        const ctx = await buildSeededContext();
        const absentId = 'd'.repeat(40) as ObjectId;
        const notTreeId = await writeTree(ctx, [
          { name: 'absent.txt', mode: '100644' as FileMode, id: absentId },
        ]);
        const keptBlobId = await writeBlob(ctx, 'kept');
        const wantTreeId = await writeTree(ctx, [
          { name: 'kept.txt', mode: '100644' as FileMode, id: keptBlobId },
        ]);
        const commitId = await writeCommit(ctx, wantTreeId, [], 'blobless not side');
        const sut = computeClosure;

        // Act
        const result = await sut(ctx, {
          tier: 'walk',
          wants: [commitId],
          not: [notTreeId],
          objects: true,
        });

        // Assert
        const ids = new Set(result.objects.map((o) => o.id));
        expect(ids.has(keptBlobId)).toBe(true);
        expect(ids.has(absentId)).toBe(false);
      });
    });
  });

  describe('Given a not tip whose parent commit the repository lacks', () => {
    describe('When computeClosure marks its ancestry uninteresting', () => {
      it('Then the marking stops at the missing edge instead of refusing', async () => {
        // Arrange — a shallow clone's own shape: the tip is present, its
        // parent was never fetched.
        const ctx = await buildSeededContext();
        const absentParent = 'e'.repeat(40) as ObjectId;
        const notBlobId = await writeBlob(ctx, 'have');
        const notTreeId = await writeTree(ctx, [
          { name: 'h.txt', mode: '100644' as FileMode, id: notBlobId },
        ]);
        const notTipId = await writeCommit(ctx, notTreeId, [absentParent], 'grafted have');
        const wantBlobId = await writeBlob(ctx, 'want');
        const wantTreeId = await writeTree(ctx, [
          { name: 'w.txt', mode: '100644' as FileMode, id: wantBlobId },
        ]);
        const wantId = await writeCommit(ctx, wantTreeId, [notTipId], 'want');
        const sut = computeClosure;

        // Act
        const result = await sut(ctx, {
          tier: 'walk',
          wants: [wantId],
          not: [notTipId],
          objects: true,
        });

        // Assert
        const ids = new Set(result.objects.map((o) => o.id));
        expect(ids).toEqual(new Set([wantId, wantTreeId, wantBlobId]));
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
          tier: 'walk',
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
      it('Then it throws TREE_DEPTH_EXCEEDED at the first level past the cap, not a stack overflow', async () => {
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
          await sut(ctx, { tier: 'walk', wants: [commitId], not: [current], objects: false });
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        const data = (caught as TsgitError).data;
        if (data.code !== 'TREE_DEPTH_EXCEEDED') {
          expect.fail(`expected TREE_DEPTH_EXCEEDED, got ${data.code}`);
        }
        // All 1025 levels are marked; the phantom below them is level 1025,
        // the first one past the cap — 1024 itself is still walked.
        expect(data.depth).toBe(1025);
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
        const result = await sut(ctx, {
          tier: 'walk',
          wants: [commitId],
          not: [tagId],
          objects: true,
        });

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
        const result = await sut(ctx, { tier: 'walk', wants: [], not: [], objects: true });

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
        const result = await sut(ctx, {
          tier: 'walk',
          wants: [commitId],
          not: [commitId],
          objects: true,
        });

        // Assert
        expect(result.objects).toEqual([]);
      });
    });
  });

  describe('Given an empty wants array and a not id the repository cannot resolve', () => {
    describe('When computeClosure is called', () => {
      it('Then it answers empty without resolving the not side at all', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await buildLinearChain(ctx);
        const unresolvable = '9'.repeat(40) as ObjectId;
        const sut = computeClosure;

        // Act
        const result = await sut(ctx, {
          tier: 'walk',
          wants: [],
          not: [unresolvable],
          objects: true,
        });

        // Assert — nothing to reach means nothing to exclude, so the not side
        // is never read and its unresolvable id never refuses.
        expect(result.objects).toEqual([]);
      });
    });
  });

  describe('Given a want commit whose parent the repository lacks', () => {
    describe('When computeClosure walks its ancestry', () => {
      it('Then the walk stops at the missing edge instead of refusing', async () => {
        // Arrange — a shallow clone's tip, walked from the interesting side.
        const ctx = await buildSeededContext();
        const absentParent = 'b'.repeat(40) as ObjectId;
        const blobId = await writeBlob(ctx, 'grafted');
        const treeId = await writeTree(ctx, [
          { name: 'f.txt', mode: '100644' as FileMode, id: blobId },
        ]);
        const commitId = await writeCommit(ctx, treeId, [absentParent], 'grafted tip');
        const sut = computeClosure;

        // Act
        const result = await sut(ctx, {
          tier: 'walk',
          wants: [commitId],
          not: [],
          objects: false,
        });

        // Assert
        expect(result.objects.map((o) => o.id)).toEqual([commitId]);
      });
    });
  });

  describe('Given a commits-only request whose boundary commit lacks its own tree', () => {
    describe('When computeClosure walks the interesting side', () => {
      it('Then it answers without reading any tree at all', async () => {
        // Arrange — a tree-filtered partial clone: `root` is the boundary both
        // sides share, and only a tree pass would ever ask for its tree.
        const ctx = await buildSeededContext();
        const absentTreeId = 'c'.repeat(40) as ObjectId;
        const rootId = await writeCommit(ctx, absentTreeId, [], 'root');
        const haveBlobId = await writeBlob(ctx, 'have');
        const haveTreeId = await writeTree(ctx, [
          { name: 'h.txt', mode: '100644' as FileMode, id: haveBlobId },
        ]);
        const haveId = await writeCommit(ctx, haveTreeId, [rootId], 'have');
        const wantBlobId = await writeBlob(ctx, 'want');
        const wantTreeId = await writeTree(ctx, [
          { name: 'w.txt', mode: '100644' as FileMode, id: wantBlobId },
        ]);
        const wantId = await writeCommit(ctx, wantTreeId, [rootId], 'want');
        const sut = computeClosure;

        // Act
        const result = await sut(ctx, {
          tier: 'walk',
          wants: [wantId],
          not: [haveId],
          objects: false,
        });

        // Assert
        expect(result.objects.map((o) => o.id)).toEqual([wantId]);
      });
    });
  });

  describe('Given two commit seeds under noWalk, one of them covered by not', () => {
    describe('When computeClosure emits the seeds', () => {
      it('Then the covered seed is skipped and the other is emitted', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const chain = await buildLinearChain(ctx);
        const sut = computeClosure;

        // Act
        const result = await sut(ctx, {
          tier: 'walk',
          wants: [chain.c3, chain.c2],
          not: [chain.c2],
          objects: false,
          noWalk: true,
        });

        // Assert
        expect(result.objects.map((o) => o.id)).toEqual([chain.c3]);
      });
    });
  });

  describe('Given three commit seeds under noWalk and maxCount: 2', () => {
    describe('When computeClosure emits the seeds', () => {
      it('Then exactly the first two are emitted', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const chain = await buildLinearChain(ctx);
        const sut = computeClosure;

        // Act
        const result = await sut(ctx, {
          tier: 'walk',
          wants: [chain.c3, chain.c2, chain.c1],
          not: [],
          objects: false,
          noWalk: true,
          maxCount: 2,
        });

        // Assert — the bound governs the seeds themselves, with no walk to
        // bound: one more seed than the cap, and the last one never lands.
        expect(result.objects.map((o) => o.id)).toEqual([chain.c3, chain.c2]);
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
        const result = await sut(ctx, { tier: 'walk', wants: [], not: [], objects: false });

        // Assert
        expect(result.objects).toEqual([]);
      });
    });
  });

  describe('Given a fixture that repeats blob content across the have boundary', () => {
    describe('When computeClosure walks the interesting side excluding the have tip', () => {
      it('Then the result is a superset of the exact difference and every extra object is reachable from the not tip', async () => {
        // Arrange
        const { ctx, have, want } = await buildHavesFixture();
        const sut = computeClosure;

        // Act
        const actual = await sut(ctx, { tier: 'walk', wants: [want], not: [have], objects: true });
        const exact = await enumerateBundleObjects(ctx, { wants: [want], haves: [have] });
        const reachableFromNotTip = await sut(ctx, {
          tier: 'walk',
          wants: [have],
          not: [],
          objects: true,
        });

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
        const { ctx, have, want } = await buildHavesFixture();
        const sut = computeClosure;

        // Act
        const actual = await sut(ctx, { tier: 'walk', wants: [want], not: [have], objects: true });
        const exact = await enumerateBundleObjects(ctx, { wants: [want], haves: [have] });

        // Assert
        const actualIds = new Set(actual.objects.map((o) => o.id));
        const exactIds = new Set(exact.objects);
        const extra = [...actualIds].filter((id) => !exactIds.has(id));
        expect(extra.length).toBeGreaterThan(0);
      });
    });
  });

  describe('Given a not tip and a want that share a common ancestor', () => {
    describe('When computeClosure walks the want excluding the not tip', () => {
      it("Then the shared ancestor commit, its own tree, and the blob it alone carries are all excluded — git's own merge-base exclusion", async () => {
        // Arrange — `root` is a common ancestor of both `have` and `want`;
        // `have`'s own tree drops `shared.txt` entirely, so tip-only tree
        // marking cannot explain `shared.txt`'s exclusion here — only
        // boundary-commit discovery (root is `want`'s own parent, and root
        // is in `have`'s full ancestor closure) does.
        const ctx = await buildSeededContext();
        const sharedBlob = await writeBlob(ctx, 'shared');
        const rootTree = await writeTree(ctx, [
          { name: 'shared.txt', mode: '100644' as FileMode, id: sharedBlob },
        ]);
        const root = await writeCommit(ctx, rootTree, [], 'root');

        const haveOnlyBlob = await writeBlob(ctx, 'have-only');
        const haveTree = await writeTree(ctx, [
          { name: 'have-only.txt', mode: '100644' as FileMode, id: haveOnlyBlob },
        ]);
        const have = await writeCommit(ctx, haveTree, [root], 'have');

        const wantOnlyBlob = await writeBlob(ctx, 'want-only');
        const wantTree = await writeTree(ctx, [
          { name: 'shared.txt', mode: '100644' as FileMode, id: sharedBlob },
          { name: 'want-only.txt', mode: '100644' as FileMode, id: wantOnlyBlob },
        ]);
        const want = await writeCommit(ctx, wantTree, [root], 'want');
        const sut = computeClosure;

        // Act
        const result = await sut(ctx, { tier: 'walk', wants: [want], not: [have], objects: true });

        // Assert
        const ids = new Set(result.objects.map((o) => o.id));
        expect(ids.has(root)).toBe(false);
        expect(ids.has(rootTree)).toBe(false);
        expect(ids.has(sharedBlob)).toBe(false);
        expect(ids.has(want)).toBe(true);
        expect(ids.has(wantTree)).toBe(true);
        expect(ids.has(wantOnlyBlob)).toBe(true);
      });
    });
  });

  describe('Given two commits on the want side sharing the same boundary parent', () => {
    describe('When computeClosure walks both excluding a not tip beyond that parent', () => {
      it('Then the boundary parent is discovered once and both descendants still exclude its content', async () => {
        // Arrange — a diamond: `left` and `right` are both direct children
        // of `boundary`, which is itself excluded via `have`'s full ancestor
        // closure. Exercises `markBoundaryTrees`'s own-already-seen
        // short-circuit (`right`'s parent is discovered a second time).
        const ctx = await buildSeededContext();
        const boundaryOnlyBlob = await writeBlob(ctx, 'boundary-only');
        const boundaryTree = await writeTree(ctx, [
          { name: 'boundary-only.txt', mode: '100644' as FileMode, id: boundaryOnlyBlob },
        ]);
        const boundary = await writeCommit(ctx, boundaryTree, [], 'boundary');

        const haveOnlyBlob = await writeBlob(ctx, 'have-only');
        const haveTree = await writeTree(ctx, [
          { name: 'have-only.txt', mode: '100644' as FileMode, id: haveOnlyBlob },
        ]);
        const have = await writeCommit(ctx, haveTree, [boundary], 'have');

        const leftBlob = await writeBlob(ctx, 'left');
        const leftTree = await writeTree(ctx, [
          { name: 'left.txt', mode: '100644' as FileMode, id: leftBlob },
        ]);
        const left = await writeCommit(ctx, leftTree, [boundary], 'left');

        const rightBlob = await writeBlob(ctx, 'right');
        const rightTree = await writeTree(ctx, [
          { name: 'right.txt', mode: '100644' as FileMode, id: rightBlob },
        ]);
        const right = await writeCommit(ctx, rightTree, [boundary], 'right');
        const sut = computeClosure;

        // Act
        const result = await sut(ctx, {
          tier: 'walk',
          wants: [left, right],
          not: [have],
          objects: true,
        });

        // Assert
        const ids = new Set(result.objects.map((o) => o.id));
        expect(ids.has(boundary)).toBe(false);
        expect(ids.has(boundaryTree)).toBe(false);
        expect(ids.has(boundaryOnlyBlob)).toBe(false);
        expect(ids.has(left)).toBe(true);
        expect(ids.has(right)).toBe(true);
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
          await sut(ctx, { tier: 'walk', wants: [missing], not: [], objects: false });
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
          await sut(ctx, { tier: 'walk', wants: [commitId], not: [missing], objects: false });
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
        const result = await sut(ctx, { tier: 'walk', wants: [childId], not: [], objects: true });

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
            await sut(ctx, { tier: 'walk', wants: [commitId], not: [], objects: true });
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

/**
 * Artefact preference inside the bitmap tier: midx bitmap ≻ pack bitmap ≻
 * walk, each artefact refused in turn. `buildDualBitmapFixture` gives a
 * single packed blob covered by a healthy pack bitmap AND a healthy midx
 * bitmap over an identical (deliberately byte-identical) type-stream body,
 * so every arm below that answers from a bitmap reports the SAME object —
 * the artefact that served it is observable only through the spy on
 * `RegisteredPack.bitmapBytes`, never through the answer itself.
 */
describe('computeClosure — bitmap-tier artefact preference', () => {
  const packDirOf = (ctx: Context): string => `${ctx.layout.gitDir}/objects/pack`;
  const midxBitmapPathOf = (ctx: Context, hex: string): string =>
    `${packDirOf(ctx)}/multi-pack-index-${hex}.bitmap`;

  interface DualBitmapFixture {
    readonly ctx: Context;
    readonly blobId: ObjectId;
    readonly hex: string;
  }

  // `bitSize` matches the fixture's own single-object count (1); a bit at
  // position 1 is therefore out of range for the range-validation arm below
  // while still fitting the first 32-bit EWAH word, same as the pack-flavour
  // boundary rows' own `bitSize: objectCount` convention.
  function blobOnlyBitmapSpec(digestLength: number, blobBits: ReadonlyArray<number>): BitmapSpec {
    return {
      optionFlags: 1,
      digestLength,
      checksum: new Uint8Array(digestLength).fill(0xbb),
      typeStreams: [
        { bitSize: 1, bits: [] },
        { bitSize: 1, bits: [] },
        { bitSize: 1, bits: blobBits },
        { bitSize: 1, bits: [] },
      ],
      entries: [],
      trailingBytes: 0,
    };
  }

  /** A single packed blob, a healthy pack bitmap and a healthy midx bitmap
   *  both covering it — the shared starting point every preference arm
   *  mutates from. */
  async function buildDualBitmapFixture(name: string): Promise<DualBitmapFixture> {
    const ctx = await buildSeededContext();
    const content = new TextEncoder().encode(`${name}-content`);
    const ids = await writeSyntheticPack(ctx, name, [{ kind: 'base', type: 'blob', content }]);
    const blobId = ids[0] as ObjectId;
    const digestLength = ctx.hashConfig.digestLength;

    const healthyBody = buildBitmap(blobOnlyBitmapSpec(digestLength, [0]));
    await writeSyntheticBitmap(ctx, `${packDirOf(ctx)}/pack-${name}.bitmap`, healthyBody);

    // The midx CLAIMS this same pack, with the blob's REAL offset: any oid
    // the midx's OIDL carries is authoritative for `PackRegistry.lookup`
    // once a midx is present, so `readObject` (the closure algorithm's own
    // object reads) would throw on an invented packIndex/offset.
    const idxBytes = await ctx.fs.read(`${packDirOf(ctx)}/pack-${name}.idx`);
    const index = parsePackIndex(idxBytes);
    const offset = lookupPackIndex(index, blobId) as number;
    const midxSpec: MidxSpec = {
      version: 1,
      hashVersion: digestLength === 32 ? 2 : 1,
      digestLength,
      numBaseFiles: 0,
      packNames: [`pack-${name}.idx`],
      entries: [{ id: blobId, packIndex: 0, offset }],
      revBody: [0],
    };
    await ctx.fs.write(`${packDirOf(ctx)}/multi-pack-index`, buildMidx(midxSpec));
    const hex = '00'.repeat(digestLength);
    await writeSyntheticBitmap(ctx, midxBitmapPathOf(ctx, hex), healthyBody);

    return { ctx, blobId, hex };
  }

  async function firstRegisteredPack(ctx: Context) {
    const [pack] = await getPackRegistry(ctx).all();
    if (pack === undefined) throw new Error('expected a registered pack');
    return pack;
  }

  async function corruptMidxBitmapMagic(fixture: DualBitmapFixture): Promise<void> {
    const path = midxBitmapPathOf(fixture.ctx, fixture.hex);
    const bytes = (await fixture.ctx.fs.read(path)).slice();
    new DataView(bytes.buffer).setUint32(0, 0xdeadbeef);
    await fixture.ctx.fs.write(path, bytes);
  }

  describe('Given a usable midx bitmap and a usable pack bitmap covering the same object', () => {
    describe('When a bitmap-tier closure is requested', () => {
      it('Then the midx bitmap answers and the pack bitmap is never read', async () => {
        // Arrange
        const fixture = await buildDualBitmapFixture('pref-midx-wins');
        const pack = await firstRegisteredPack(fixture.ctx);
        const bitmapBytesSpy = vi.spyOn(pack, 'bitmapBytes');

        // Act
        const result = await computeClosure(fixture.ctx, {
          tier: 'bitmap',
          wants: [fixture.blobId],
          not: [],
          objects: true,
        });

        // Assert
        expect(result.tier).toBe('bitmap');
        expect(bitmapBytesSpy).not.toHaveBeenCalled();
        expect(result.objects).toEqual([{ id: fixture.blobId, type: 'blob' }]);
      });
    });
  });

  describe('Given the midx bitmap refused (bad magic) and a usable pack bitmap covering the same object', () => {
    describe('When a bitmap-tier closure is requested', () => {
      it('Then the pack bitmap answers with the same object the midx bitmap would have', async () => {
        // Arrange
        const fixture = await buildDualBitmapFixture('pref-pack-wins');
        await corruptMidxBitmapMagic(fixture);
        const pack = await firstRegisteredPack(fixture.ctx);
        const bitmapBytesSpy = vi.spyOn(pack, 'bitmapBytes');

        // Act
        const result = await computeClosure(fixture.ctx, {
          tier: 'bitmap',
          wants: [fixture.blobId],
          not: [],
          objects: true,
        });

        // Assert
        expect(result.tier).toBe('bitmap');
        expect(bitmapBytesSpy).toHaveBeenCalled();
        expect(result.objects).toEqual([{ id: fixture.blobId, type: 'blob' }]);
      });
    });
  });

  describe('Given both the midx bitmap and the pack bitmap refused (bad magic)', () => {
    describe('When a bitmap-tier closure is requested', () => {
      it('Then the walk answers', async () => {
        // Arrange
        const fixture = await buildDualBitmapFixture('pref-walk');
        await corruptMidxBitmapMagic(fixture);
        const packBitmapPath = `${packDirOf(fixture.ctx)}/pack-pref-walk.bitmap`;
        const packBytes = (await fixture.ctx.fs.read(packBitmapPath)).slice();
        new DataView(packBytes.buffer).setUint32(0, 0xdeadbeef);
        await fixture.ctx.fs.write(packBitmapPath, packBytes);

        // Act
        const result = await computeClosure(fixture.ctx, {
          tier: 'bitmap',
          wants: [fixture.blobId],
          not: [],
          objects: true,
        });

        // Assert
        expect(result.tier).toBe('walk');
        expect(result.objects).toEqual([{ id: fixture.blobId, type: 'blob' }]);
      });
    });
  });

  describe('Given a usable midx bitmap and a usable pack bitmap, and a bitmap-tier request that also bounds the commit count', () => {
    describe('When a closure is requested', () => {
      it('Then the walk answers and no bitmap is read — a bounded count defeats the bitmap', async () => {
        // Arrange
        const fixture = await buildDualBitmapFixture('max-count-forces-walk');
        const pack = await firstRegisteredPack(fixture.ctx);
        const bitmapBytesSpy = vi.spyOn(pack, 'bitmapBytes');

        // Act
        const result = await computeClosure(fixture.ctx, {
          tier: 'bitmap',
          wants: [fixture.blobId],
          not: [],
          objects: true,
          maxCount: 1,
        });

        // Assert
        expect(result.tier).toBe('walk');
        expect(bitmapBytesSpy).not.toHaveBeenCalled();
        expect(result.objects).toEqual([{ id: fixture.blobId, type: 'blob' }]);
      });
    });
  });

  describe('Given the midx bitmap declined for an out-of-range position (not a parse fault), and a usable pack bitmap', () => {
    describe('When a bitmap-tier closure is requested', () => {
      it('Then the pack bitmap answers with the same object the midx bitmap would have', async () => {
        // Arrange
        const fixture = await buildDualBitmapFixture('pref-out-of-range');
        const digestLength = fixture.ctx.hashConfig.digestLength;
        // objectCount for this midx is 1 — bit 1 is out of range, a range
        // violation rather than a structural parse fault.
        const outOfRangeBody = buildBitmap(blobOnlyBitmapSpec(digestLength, [1]));
        await writeSyntheticBitmap(
          fixture.ctx,
          midxBitmapPathOf(fixture.ctx, fixture.hex),
          outOfRangeBody,
        );
        const pack = await firstRegisteredPack(fixture.ctx);
        const bitmapBytesSpy = vi.spyOn(pack, 'bitmapBytes');

        // Act
        const result = await computeClosure(fixture.ctx, {
          tier: 'bitmap',
          wants: [fixture.blobId],
          not: [],
          objects: true,
        });

        // Assert
        expect(result.tier).toBe('bitmap');
        expect(bitmapBytesSpy).toHaveBeenCalled();
        expect(result.objects).toEqual([{ id: fixture.blobId, type: 'blob' }]);
      });
    });
  });
});
