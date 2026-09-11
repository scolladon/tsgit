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
import * as closureNotMarksModule from '../../../../../src/application/primitives/internal/closure-not-marks.js';
import * as readCommitMetaModule from '../../../../../src/application/primitives/internal/read-commit-meta.js';
import * as resolveMaxTreeDepthModule from '../../../../../src/application/primitives/internal/resolve-max-tree-depth.js';
import * as readObjectModule from '../../../../../src/application/primitives/read-object.js';
import { getPackRegistry } from '../../../../../src/application/primitives/read-object.js';
import { MAX_WALK_QUEUE_SIZE } from '../../../../../src/application/primitives/types.js';
import { REASON_WALK_QUEUE_OVERFLOW } from '../../../../../src/application/primitives/validators.js';
import { writeObject } from '../../../../../src/application/primitives/write-object.js';
import { writeTree } from '../../../../../src/application/primitives/write-tree.js';
import { invalidWalkInput } from '../../../../../src/domain/error.js';
import { TsgitError } from '../../../../../src/domain/index.js';
import type {
  AuthorIdentity,
  Blob,
  Commit,
  FileMode,
  ObjectId,
  Tag,
} from '../../../../../src/domain/objects/index.js';
import { treeEntry } from '../../../../../src/domain/objects/tree.js';
import {
  computeLooseObjectPath,
  lookupPackIndex,
  packNameHash,
  parsePackIndex,
} from '../../../../../src/domain/storage/index.js';
import type { Context } from '../../../../../src/ports/context.js';
import {
  type BitmapSpec,
  buildBitmap,
  buildMidx,
  type MidxSpec,
} from '../../../domain/storage/arbitraries.js';
import {
  buildSeededContext,
  buildSharedSubtreeChain,
  seedMaxTreeDepth,
  writeCommitGraph,
} from '../fixtures.js';
import { writeSyntheticBitmap, writeSyntheticPack } from '../pack-fixture.js';

const AUTHOR: AuthorIdentity = {
  name: 'A',
  email: 'a@a',
  timestamp: 0,
  timezoneOffset: '+0000',
};

/** Build a chain of `levels` nested DIRECTORY wrappers (git's `40000` tree
 *  mode) around a real, blob-containing leaf tree — a small,
 *  config-cap-reachable stand-in for the 1000+-level fixtures a hardcoded
 *  1024 cap used to require. */
const buildDeepTree = async (ctx: Context, levels: number): Promise<ObjectId> => {
  const leafBlob = await writeBlob(ctx, 'deep-not-leaf');
  let current: ObjectId = await writeTree(ctx, [
    treeEntry('100644' as FileMode, 'f.txt', leafBlob),
  ]);
  for (let i = 0; i < levels; i += 1) {
    current = await writeTree(ctx, [treeEntry('40000' as FileMode, 'sub', current)]);
  }
  return current;
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
  const t1 = await writeTree(ctx, [treeEntry('100644' as FileMode, 'file.txt', b1)]);
  const c1 = await writeCommit(ctx, t1, [], 'gen-1');
  const b2 = await writeBlob(ctx, 'gen-2');
  const t2 = await writeTree(ctx, [treeEntry('100644' as FileMode, 'file.txt', b2)]);
  const c2 = await writeCommit(ctx, t2, [c1], 'gen-2');
  const b3 = await writeBlob(ctx, 'gen-3');
  const t3 = await writeTree(ctx, [treeEntry('100644' as FileMode, 'file.txt', b3)]);
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
    treeEntry('100644' as FileMode, 'shared.txt', sharedBlob),
  ]);
  const root = await writeCommit(ctx, rootTree, [], 'root');

  const changedBlob = await writeBlob(ctx, 'changed');
  const haveTree = await writeTree(ctx, [
    treeEntry('100644' as FileMode, 'shared.txt', changedBlob),
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
        expect(byId.get(chain.t1)?.nameHash).toBe(0);
        expect(byId.get(chain.b1)?.nameHash).toBe(
          packNameHash(new TextEncoder().encode('file.txt')),
        );
      });
    });
  });

  describe('Given two commits whose trees place the same blob under two different names', () => {
    describe('When computeClosure walks from the tip commit', () => {
      it("Then the blob keeps the tip commit's naming — the first the walk emits it under", async () => {
        // Arrange — the walk visits the tip commit (and its tree) before the
        // root commit's, so tryEmit's first-seen rule keeps the tip's name,
        // not the chronologically earlier root's.
        const ctx = await buildSeededContext();
        const sharedBlobId = await writeBlob(ctx, 'shared-across-generations');
        const rootTreeId = await writeTree(ctx, [
          treeEntry('100644' as FileMode, 'root-name.txt', sharedBlobId),
        ]);
        const rootCommitId = await writeCommit(ctx, rootTreeId, [], 'root generation');
        const tipTreeId = await writeTree(ctx, [
          treeEntry('100644' as FileMode, 'tip-name.txt', sharedBlobId),
        ]);
        const tipCommitId = await writeCommit(ctx, tipTreeId, [rootCommitId], 'tip generation');
        const sut = computeClosure;

        // Act
        const result = await sut(ctx, {
          tier: 'walk',
          wants: [tipCommitId],
          not: [],
          objects: true,
        });

        // Assert
        const blobObject = result.objects.find((o) => o.id === sharedBlobId);
        expect(blobObject?.nameHash).toBe(packNameHash(new TextEncoder().encode('tip-name.txt')));
      });
    });
  });

  describe('Given a want that is an annotated tag', () => {
    describe('When computeClosure is called', () => {
      it('Then the tag oid and the peeled commit are both in the result', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const blobId = await writeBlob(ctx, 'tagged');
        const treeId = await writeTree(ctx, [treeEntry('100644' as FileMode, 'f.txt', blobId)]);
        const commitId = await writeCommit(ctx, treeId, [], 'tagged');
        const tagId = await writeTag(ctx, commitId, 'commit', 'v1.0');
        const sut = computeClosure;

        // Act
        const result = await sut(ctx, { tier: 'walk', wants: [tagId], not: [], objects: false });

        // Assert — a tag has no path, so it carries nameHash 0, like a commit.
        const ids = new Set(result.objects.map((o) => o.id));
        expect(ids).toEqual(new Set([tagId, commitId]));
        expect(result.objects.find((o) => o.id === tagId)).toStrictEqual({
          id: tagId,
          type: 'tag',
          nameHash: 0,
        });
      });
    });
  });

  describe('Given a tag-of-tag chain', () => {
    describe('When computeClosure is called', () => {
      it('Then both tag oids and the peeled commit are in the result', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const blobId = await writeBlob(ctx, 'deep-tagged');
        const treeId = await writeTree(ctx, [treeEntry('100644' as FileMode, 'f.txt', blobId)]);
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
          treeEntry('100644' as FileMode, 'deep.txt', nestedBlobId),
        ]);
        const topBlobId = await writeBlob(ctx, 'top');
        const rootTreeId = await writeTree(ctx, [
          treeEntry('100644' as FileMode, 'top.txt', topBlobId),
          treeEntry('40000' as FileMode, 'sub', subTreeId),
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
        expect(result.objects.find((o) => o.id === rootTreeId)?.nameHash).toBe(0);
        expect(result.objects.find((o) => o.id === nestedBlobId)?.nameHash).toBe(
          packNameHash(new TextEncoder().encode('sub/deep.txt')),
        );
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

        // Assert — no path, and the directly-wanted-blob divergence: git
        // would use the pending object's own name, tsgit names it 0.
        expect(result.objects).toStrictEqual([{ id: blobId, type: 'blob', nameHash: 0 }]);
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
          treeEntry('160000' as FileMode, 'submodule', gitlinkOid),
          treeEntry('100644' as FileMode, 'f.txt', blobId),
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
          treeEntry('100644' as FileMode, 'deep.txt', nestedBlobId),
        ]);
        const directBlobId = await writeBlob(ctx, 'direct');
        const outerTreeId = await writeTree(ctx, [
          treeEntry('100644' as FileMode, 'top.txt', directBlobId),
          treeEntry('40000' as FileMode, 'sub', innerTreeId),
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
        // tree (including the nested one) is excluded. A commit has no
        // path, so its nameHash is 0.
        expect(result.objects).toStrictEqual([{ id: commitId, type: 'commit', nameHash: 0 }]);
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
          treeEntry('100644' as FileMode, 'z.txt', markedBlobId),
          treeEntry('100644' as FileMode, 'other.txt', otherBlobId),
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
          treeEntry('100644' as FileMode, 'leaf.txt', sharedBlobId),
        ]);
        const outerTreeId = await writeTree(ctx, [
          treeEntry('40000' as FileMode, 'a', sharedTreeId),
          treeEntry('40000' as FileMode, 'b', sharedTreeId),
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
        // are excluded. A commit has no path, so its nameHash is 0.
        expect(result.objects).toStrictEqual([{ id: commitId, type: 'commit', nameHash: 0 }]);
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
          treeEntry('100644' as FileMode, 'leaf.txt', sharedBlobId),
        ]);
        const outerTreeId = await writeTree(ctx, [
          treeEntry('40000' as FileMode, 'a', sharedTreeId),
          treeEntry('40000' as FileMode, 'b', sharedTreeId),
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
          treeEntry('100644' as FileMode, 'z.txt', markedBlobId),
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
          treeEntry('160000' as FileMode, 'submodule', sharedId),
        ]);
        const wantTreeId = await writeTree(ctx, [
          treeEntry('100644' as FileMode, 'kept.txt', sharedId),
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
          treeEntry('100644' as FileMode, 'absent.txt', absentId),
        ]);
        const keptBlobId = await writeBlob(ctx, 'kept');
        const wantTreeId = await writeTree(ctx, [
          treeEntry('100644' as FileMode, 'kept.txt', keptBlobId),
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
          treeEntry('100644' as FileMode, 'h.txt', notBlobId),
        ]);
        const notTipId = await writeCommit(ctx, notTreeId, [absentParent], 'grafted have');
        const wantBlobId = await writeBlob(ctx, 'want');
        const wantTreeId = await writeTree(ctx, [
          treeEntry('100644' as FileMode, 'w.txt', wantBlobId),
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
          treeEntry('160000' as FileMode, 'submodule', gitlinkOid),
          treeEntry('100644' as FileMode, 'marked.txt', markedBlobId),
        ]);
        const wantTreeId = await writeTree(ctx, [
          treeEntry('100644' as FileMode, 'marked.txt', markedBlobId),
          treeEntry('100644' as FileMode, 'kept.txt', keptBlobId),
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

  describe('Given a repository configured with core.maxTreeDepth = 4', () => {
    describe('When a not id is nested 4 levels deep', () => {
      it('Then it completes', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await seedMaxTreeDepth(ctx, '4');
        const notTreeId = await buildDeepTree(ctx, 4);
        const blobId = await writeBlob(ctx, 'shallow want leaf');
        const treeId = await writeTree(ctx, [treeEntry('100644' as FileMode, 'f.txt', blobId)]);
        const commitId = await writeCommit(ctx, treeId, [], 'shallow want');
        const sut = computeClosure;

        // Act
        const result = await sut(ctx, {
          tier: 'walk',
          wants: [commitId],
          not: [notTreeId],
          objects: false,
        });

        // Assert — no throw; the unrelated want commit is still emitted
        expect(result.objects.map((o) => o.id)).toContain(commitId);
      });
    });

    describe('When a not id is nested 5 levels deep', () => {
      it('Then it throws TREE_DEPTH_EXCEEDED with depth === 5, not a stack overflow', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await seedMaxTreeDepth(ctx, '4');
        const notTreeId = await buildDeepTree(ctx, 5);
        const blobId = await writeBlob(ctx, 'unreachable want');
        const treeId = await writeTree(ctx, [treeEntry('100644' as FileMode, 'f.txt', blobId)]);
        const commitId = await writeCommit(ctx, treeId, [], 'shallow want');
        const sut = computeClosure;

        // Act
        let caught: unknown;
        try {
          await sut(ctx, { tier: 'walk', wants: [commitId], not: [notTreeId], objects: false });
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        const data = (caught as TsgitError).data;
        if (data.code !== 'TREE_DEPTH_EXCEEDED') {
          expect.fail(`expected TREE_DEPTH_EXCEEDED, got ${data.code}`);
        }
        expect(data.depth).toBe(5);
      });
    });
  });

  describe('Given a repository configured with core.maxTreeDepth = 4 and a not id 20x past the cap', () => {
    describe('When computeClosure marks it uninteresting', () => {
      it('Then it throws TREE_DEPTH_EXCEEDED with depth === 5, not the deeper structural depth', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await seedMaxTreeDepth(ctx, '4');
        const notTreeId = await buildDeepTree(ctx, 80);
        const blobId = await writeBlob(ctx, 'unreachable want');
        const treeId = await writeTree(ctx, [treeEntry('100644' as FileMode, 'f.txt', blobId)]);
        const commitId = await writeCommit(ctx, treeId, [], 'shallow want');
        const sut = computeClosure;

        // Act
        let caught: unknown;
        try {
          await sut(ctx, { tier: 'walk', wants: [commitId], not: [notTreeId], objects: false });
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        const data = (caught as TsgitError).data;
        if (data.code !== 'TREE_DEPTH_EXCEEDED') {
          expect.fail(`expected TREE_DEPTH_EXCEEDED, got ${data.code}`);
        }
        expect(data.depth).toBe(5);
      });
    });
  });

  describe('Given the same depth-4 not id tested at two different core.maxTreeDepth values', () => {
    describe('When core.maxTreeDepth = 4', () => {
      it('Then it completes', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await seedMaxTreeDepth(ctx, '4');
        const notTreeId = await buildDeepTree(ctx, 4);
        const blobId = await writeBlob(ctx, 'boundary want leaf');
        const treeId = await writeTree(ctx, [treeEntry('100644' as FileMode, 'f.txt', blobId)]);
        const commitId = await writeCommit(ctx, treeId, [], 'boundary want');
        const sut = computeClosure;

        // Act
        const result = await sut(ctx, {
          tier: 'walk',
          wants: [commitId],
          not: [notTreeId],
          objects: false,
        });

        // Assert — no throw; the unrelated want commit is still emitted
        expect(result.objects.map((o) => o.id)).toContain(commitId);
      });
    });

    describe('When core.maxTreeDepth = 3', () => {
      it('Then it throws TREE_DEPTH_EXCEEDED with depth === 4', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await seedMaxTreeDepth(ctx, '3');
        const notTreeId = await buildDeepTree(ctx, 4);
        const blobId = await writeBlob(ctx, 'boundary want leaf');
        const treeId = await writeTree(ctx, [treeEntry('100644' as FileMode, 'f.txt', blobId)]);
        const commitId = await writeCommit(ctx, treeId, [], 'boundary want');
        const sut = computeClosure;

        // Act
        let caught: unknown;
        try {
          await sut(ctx, { tier: 'walk', wants: [commitId], not: [notTreeId], objects: false });
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        const data = (caught as TsgitError).data;
        if (data.code !== 'TREE_DEPTH_EXCEEDED') {
          expect.fail(`expected TREE_DEPTH_EXCEEDED, got ${data.code}`);
        }
        expect(data.depth).toBe(4);
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
        const treeId = await writeTree(ctx, [treeEntry('100644' as FileMode, 'f.txt', blobId)]);
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
        const treeId = await writeTree(ctx, [treeEntry('100644' as FileMode, 'f.txt', blobId)]);
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
        const treeId = await writeTree(ctx, [treeEntry('100644' as FileMode, 'f.txt', blobId)]);
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
          treeEntry('100644' as FileMode, 'h.txt', haveBlobId),
        ]);
        const haveId = await writeCommit(ctx, haveTreeId, [rootId], 'have');
        const wantBlobId = await writeBlob(ctx, 'want');
        const wantTreeId = await writeTree(ctx, [
          treeEntry('100644' as FileMode, 'w.txt', wantBlobId),
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

  describe('Given two commit seeds under noWalk with a not tip (noWalk ignored with a range)', () => {
    describe('When computeClosure emits the seeds', () => {
      it('Then the walk runs and excludes the covered seed, emitting only the other', async () => {
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
        const exactIds = new Set(exact.objects.map((o) => o.id));
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
        const exactIds = new Set(exact.objects.map((o) => o.id));
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
          treeEntry('100644' as FileMode, 'shared.txt', sharedBlob),
        ]);
        const root = await writeCommit(ctx, rootTree, [], 'root');

        const haveOnlyBlob = await writeBlob(ctx, 'have-only');
        const haveTree = await writeTree(ctx, [
          treeEntry('100644' as FileMode, 'have-only.txt', haveOnlyBlob),
        ]);
        const have = await writeCommit(ctx, haveTree, [root], 'have');

        const wantOnlyBlob = await writeBlob(ctx, 'want-only');
        const wantTree = await writeTree(ctx, [
          treeEntry('100644' as FileMode, 'shared.txt', sharedBlob),
          treeEntry('100644' as FileMode, 'want-only.txt', wantOnlyBlob),
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
          treeEntry('100644' as FileMode, 'boundary-only.txt', boundaryOnlyBlob),
        ]);
        const boundary = await writeCommit(ctx, boundaryTree, [], 'boundary');

        const haveOnlyBlob = await writeBlob(ctx, 'have-only');
        const haveTree = await writeTree(ctx, [
          treeEntry('100644' as FileMode, 'have-only.txt', haveOnlyBlob),
        ]);
        const have = await writeCommit(ctx, haveTree, [boundary], 'have');

        const leftBlob = await writeBlob(ctx, 'left');
        const leftTree = await writeTree(ctx, [
          treeEntry('100644' as FileMode, 'left.txt', leftBlob),
        ]);
        const left = await writeCommit(ctx, leftTree, [boundary], 'left');

        const rightBlob = await writeBlob(ctx, 'right');
        const rightTree = await writeTree(ctx, [
          treeEntry('100644' as FileMode, 'right.txt', rightBlob),
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

  describe('Given a walk-tier closure over two linked commits with objects: true', () => {
    describe('When computeClosure buffers the walked commits for markBoundaryTrees', () => {
      it('Then each buffered record carries exactly id, tree and parents', async () => {
        // Arrange — a spy on the callee, not `toEqual` on the whole record: a
        // subset comparison cannot see an extra key (e.g. a full `Commit`'s
        // `data`/`type`) left on the buffered value.
        const ctx = await buildSeededContext();
        const treeId = await writeTree(ctx, []);
        const rootId = await writeCommit(ctx, treeId, [], 'root');
        const headId = await writeCommit(ctx, treeId, [rootId], 'head');
        const boundarySpy = vi.spyOn(closureNotMarksModule, 'markBoundaryTrees');
        const sut = computeClosure;

        // Act
        await sut(ctx, { tier: 'walk', wants: [headId], not: [], objects: true });

        // Assert
        const walked = boundarySpy.mock.calls[0]![1];
        expect(walked).toHaveLength(2);
        for (const record of walked) {
          expect(Object.keys(record).sort()).toEqual(['id', 'parents', 'tree']);
        }
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
        const treeId = await writeTree(ctx, [treeEntry('100644' as FileMode, 'f.txt', blobId)]);
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
        const treeId = await writeTree(ctx, [treeEntry('100644' as FileMode, 'f.txt', blobId)]);
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

  describe('Given a not-marked subtree also reachable, unchanged, from the want side', () => {
    describe('When computeClosure walks objects: true', () => {
      it('Then the marking pass reads it (its own type check, then markTree) and the want-side walk attempts no further read of it', async () => {
        // Arrange — a content-addressed byte cache already absorbs a repeat
        // read of the identical id at the filesystem layer, so the
        // observable under test is the WALK's own decision to
        // attempt (`readObject`) a further read at all, not whether that
        // attempt reaches disk. The not-side marking pass already costs two
        // attempts for a `not` id that is a
        // tree (`markUninteresting`'s own type check, then `markTree`'s);
        // the third attempt, from the want-side walk redundantly descending
        // an already-marked subtree, is what the prune removes.
        const ctx = await buildSeededContext();
        const markedLeafBlob = await writeBlob(ctx, 'marked-leaf');
        const markedSubtreeId = await writeTree(ctx, [
          treeEntry('100644' as FileMode, 'leaf.txt', markedLeafBlob),
        ]);
        const otherBlobId = await writeBlob(ctx, 'kept');
        const wantTreeId = await writeTree(ctx, [
          treeEntry('40000' as FileMode, 'marked', markedSubtreeId),
          treeEntry('100644' as FileMode, 'kept.txt', otherBlobId),
        ]);
        const commitId = await writeCommit(ctx, wantTreeId, [], 'reuses a not-marked subtree');
        const sut = computeClosure;
        const readSpy = vi.spyOn(readObjectModule, 'readObject');

        // Act
        await sut(ctx, { tier: 'walk', wants: [commitId], not: [markedSubtreeId], objects: true });

        // Assert
        const attemptsOnMarkedSubtree = readSpy.mock.calls.filter(
          ([, id]) => id === markedSubtreeId,
        );
        expect(attemptsOnMarkedSubtree).toHaveLength(2);
      });
    });
  });

  describe('Given a root tree already emitted while walking an earlier commit', () => {
    describe('When computeClosure walks a later commit that reuses that exact tree', () => {
      it('Then the later commit never attempts a second readObject of that tree', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const blobId = await writeBlob(ctx, 'reused root');
        const treeId = await writeTree(ctx, [treeEntry('100644' as FileMode, 'f.txt', blobId)]);
        const parentId = await writeCommit(ctx, treeId, [], 'gen-1');
        const childId = await writeCommit(ctx, treeId, [parentId], 'gen-2');
        const sut = computeClosure;
        const readSpy = vi.spyOn(readObjectModule, 'readObject');

        // Act
        await sut(ctx, { tier: 'walk', wants: [childId], not: [], objects: true });

        // Assert — one attempt as the tip commit's own root, none for the
        // parent's identical root.
        const attemptsOnTree = readSpy.mock.calls.filter(([, id]) => id === treeId);
        expect(attemptsOnTree).toHaveLength(1);
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
            treeEntry('100644' as FileMode, 'f.txt', blobId),
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

  describe('Given a shared-subtree commit chain and an empty commit reusing its tip tree', () => {
    describe('When computeClosure walks objects from the empty commit', () => {
      it('Then the emitted entries are ordered and shaped exactly as recorded on the unpruned walk', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const chain = await buildSharedSubtreeChain(ctx);
        const sut = computeClosure;

        // Act
        const result = await sut(ctx, {
          tier: 'walk',
          wants: [chain.c3],
          not: [],
          objects: true,
        });

        // Assert — the exact ordered entry list captured on the unpruned
        // walk; the closure prune must reproduce it
        // byte-for-byte (equivalence argument: a pruned subtree contributes
        // nothing to this sequence today either).
        expect(result.objects).toStrictEqual([
          {
            id: '00a4e3116c60e67c73ad2b29fbbbd9b5cb828617' as ObjectId,
            type: 'commit',
            nameHash: 0,
          },
          {
            id: '7b68225667655b86be79e69007843bf429ce9067' as ObjectId,
            type: 'tree',
            path: '',
            nameHash: 0,
          },
          {
            id: '66f21de1c93afc3c24f8b668be9b0cc1762efa3a' as ObjectId,
            type: 'tree',
            path: 'a',
            nameHash: 1627389952,
          },
          {
            id: '304f2c24d9b50ed16781dfcda37f5da6140aa420' as ObjectId,
            type: 'blob',
            path: 'a/one',
            nameHash: 2290941952,
          },
          {
            id: '0b2f0396109eada52018c2ecc4d373abd52f09b1' as ObjectId,
            type: 'blob',
            path: 'a/two',
            nameHash: 2501705728,
          },
          {
            id: '77b7bffcc4087df500799be9b62b4145b367a9e7' as ObjectId,
            type: 'tree',
            path: 'b',
            nameHash: 1644167168,
          },
          {
            id: '847c83df585334723e9fbdd0f954d4c953ced4ac' as ObjectId,
            type: 'blob',
            path: 'b/one',
            nameHash: 2291007488,
          },
          {
            id: 'da9b11c7b65f351faffd81ab161c338e504a35d4' as ObjectId,
            type: 'blob',
            path: 'b/two',
            nameHash: 2501771264,
          },
          {
            id: 'f86601129a7fbbf8b94617d239aa6e93712ce2f5' as ObjectId,
            type: 'commit',
            nameHash: 0,
          },
          {
            id: '0c390bf764a562d037f67f4c6ba65b769926f8fd' as ObjectId,
            type: 'commit',
            nameHash: 0,
          },
          {
            id: 'e6cdd70da23364b27db4b180bbce0d4ad9ce0e2f' as ObjectId,
            type: 'tree',
            path: '',
            nameHash: 0,
          },
          {
            id: 'c923bf899d649c44f4a42d4fb273170e5ac234df' as ObjectId,
            type: 'tree',
            path: 'b',
            nameHash: 1644167168,
          },
          {
            id: '1834ee9324eab6e6fa7d7df9a8c6915b81e86920' as ObjectId,
            type: 'commit',
            nameHash: 0,
          },
          {
            id: '2b5396c9a8aa16db82ed23f17eebd290688e2f98' as ObjectId,
            type: 'tree',
            path: '',
            nameHash: 0,
          },
          {
            id: 'b408f90a2e66f6cb77f82740f1ccc1a4886d9536' as ObjectId,
            type: 'tree',
            path: 'a',
            nameHash: 1627389952,
          },
          {
            id: '125f069b69a1ec3e1b4c707d56998e13c238ce50' as ObjectId,
            type: 'blob',
            path: 'a/one',
            nameHash: 2290941952,
          },
        ]);
      });
    });
  });

  describe('Given a closure spanning several commits, each carrying its own tree, with objects: true', () => {
    describe('When computeClosure walks the closure', () => {
      it('Then core.maxTreeDepth is resolved exactly once for the whole closure, not once per commit', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const commitCount = 5;
        let parentId: ObjectId | undefined;
        let tipId: ObjectId = '' as ObjectId;
        for (let generation = 0; generation < commitCount; generation += 1) {
          const blobId = await writeBlob(ctx, `gen-${generation}`);
          const treeId = await writeTree(ctx, [
            treeEntry('100644' as FileMode, 'file.txt', blobId),
          ]);
          tipId = await writeCommit(ctx, treeId, parentId ? [parentId] : [], `gen-${generation}`);
          parentId = tipId;
        }
        const resolveSpy = vi.spyOn(resolveMaxTreeDepthModule, 'resolveMaxTreeDepth');
        const sut = computeClosure;

        // Act
        await sut(ctx, { tier: 'walk', wants: [tipId], not: [], objects: true });

        // Assert
        expect(resolveSpy).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe('Given a closure whose want side revisits an already-emitted shared subtree before a fresh object trips the cap', () => {
    describe('When MAX_PUSH_OBJECTS is lowered to trip PACK_TOO_LARGE right after that revisit', () => {
      it('Then the refusal data is the exact count the duplicate revisit could not move', async () => {
        // Arrange — mock the shared cap down so a small closure trips it; see
        // the identical pattern above for why the module graph is scoped.
        vi.resetModules();
        vi.doMock('../../../../../src/application/primitives/types.js', async (importOriginal) => {
          const actual =
            await importOriginal<
              typeof import('../../../../../src/application/primitives/types.js')
            >();
          return { ...actual, MAX_PUSH_OBJECTS: 7 };
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
          const writeScopedBlob = async (content: string): Promise<ObjectId> => {
            const blob: Blob = {
              type: 'blob',
              content: new TextEncoder().encode(content),
              id: '' as ObjectId,
            };
            return scopedWriteObject(ctx, blob);
          };
          const writeScopedCommit = async (
            tree: ObjectId,
            parents: ReadonlyArray<ObjectId>,
            message: string,
          ): Promise<ObjectId> => {
            const commit: Commit = {
              type: 'commit',
              id: '' as ObjectId,
              data: { tree, parents, author: AUTHOR, committer: AUTHOR, message, extraHeaders: [] },
            };
            return scopedWriteObject(ctx, commit);
          };

          const sharedLeafBlob = await writeScopedBlob('shared-leaf');
          const sharedSubtreeId = await scopedWriteTree(ctx, [
            treeEntry('100644' as FileMode, 'leaf.txt', sharedLeafBlob),
          ]);
          const uniqueBlobC1 = await writeScopedBlob('c1-own');
          const tree1 = await scopedWriteTree(ctx, [
            treeEntry('40000' as FileMode, 'a_shared', sharedSubtreeId),
            treeEntry('100644' as FileMode, 'z_uniqueC1', uniqueBlobC1),
          ]);
          const commit1 = await writeScopedCommit(tree1, [], 'c1');
          const uniqueBlobC2 = await writeScopedBlob('c2-own');
          const tree2 = await scopedWriteTree(ctx, [
            treeEntry('40000' as FileMode, 'a_shared', sharedSubtreeId),
            treeEntry('100644' as FileMode, 'z_uniqueC2', uniqueBlobC2),
          ]);
          const commit2 = await writeScopedCommit(tree2, [commit1], 'c2');

          // Act — unique emissions in order: commit2, tree2, sharedSubtreeId,
          // sharedLeafBlob, uniqueBlobC2 (5), commit1 (6), tree1 (7), then
          // `a_shared` revisits the already-emitted sharedSubtreeId/leaf (free,
          // no cap effect either way) before `z_uniqueC1` (8th) trips the cap.
          let caught: unknown;
          try {
            await sut(ctx, { tier: 'walk', wants: [commit2], not: [], objects: true });
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
          expect(data.limit).toBe(7);
          expect(data.objectCount).toBe(8);
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
    const index = parsePackIndex(idxBytes, 20);
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

        // Assert — a reachability artefact encodes types and bits, never
        // names, so the bitmap tier leaves nameHash absent, not 0.
        expect(result.tier).toBe('bitmap');
        expect(bitmapBytesSpy).not.toHaveBeenCalled();
        expect(result.objects).toStrictEqual([{ id: fixture.blobId, type: 'blob' }]);
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

        // Assert — the walk tier answered this one, so unlike the bitmap
        // tier it carries the directly-wanted-blob nameHash of 0.
        expect(result.tier).toBe('walk');
        expect(result.objects).toEqual([{ id: fixture.blobId, type: 'blob', nameHash: 0 }]);
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

        // Assert — the walk tier answered this one, so unlike the bitmap
        // tier it carries the directly-wanted-blob nameHash of 0.
        expect(result.tier).toBe('walk');
        expect(bitmapBytesSpy).not.toHaveBeenCalled();
        expect(result.objects).toEqual([{ id: fixture.blobId, type: 'blob', nameHash: 0 }]);
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

/** Remove `id`'s loose object from the memory store — the shape a
 *  `--filter=tree:0` partial clone with a promisor gap, or a pruned/corrupt
 *  repository, presents to the not-side marker. */
const deleteLooseObject = async (ctx: Context, id: ObjectId): Promise<void> => {
  await ctx.fs.rm(`${ctx.layout.gitDir}/objects/${computeLooseObjectPath(id)}`);
};

interface MissingRootTreeFixture {
  readonly have: ObjectId;
  readonly want: ObjectId;
  readonly haveRootTree: ObjectId;
  readonly wantRootTree: ObjectId;
  readonly treeA1: ObjectId;
  readonly aOneV1: ObjectId;
  readonly treeB1: ObjectId;
  readonly bOneV1: ObjectId;
}

/**
 * `base` writes `a/one` and `b/one`; `have` edits `a/one` (subtree `a`
 * changes, `b` is reused wholesale); `want` edits `b/one` (subtree `b`
 * changes, `a` is reused wholesale from `have`). With every object present,
 * marking `have` prunes subtree `a` and its blob from `want`'s emission.
 */
const buildMissingRootTreeFixture = async (ctx: Context): Promise<MissingRootTreeFixture> => {
  const aOneV0 = await writeBlob(ctx, 'a/one v0');
  const aOneV1 = await writeBlob(ctx, 'a/one v1');
  const bOneV0 = await writeBlob(ctx, 'b/one v0');
  const bOneV1 = await writeBlob(ctx, 'b/one v1');
  const treeA0 = await writeTree(ctx, [treeEntry('100644' as FileMode, 'one', aOneV0)]);
  const treeA1 = await writeTree(ctx, [treeEntry('100644' as FileMode, 'one', aOneV1)]);
  const treeB0 = await writeTree(ctx, [treeEntry('100644' as FileMode, 'one', bOneV0)]);
  const treeB1 = await writeTree(ctx, [treeEntry('100644' as FileMode, 'one', bOneV1)]);
  const baseRootTree = await writeTree(ctx, [
    treeEntry('40000' as FileMode, 'a', treeA0),
    treeEntry('40000' as FileMode, 'b', treeB0),
  ]);
  const base = await writeCommit(ctx, baseRootTree, [], 'base');
  const haveRootTree = await writeTree(ctx, [
    treeEntry('40000' as FileMode, 'a', treeA1),
    treeEntry('40000' as FileMode, 'b', treeB0),
  ]);
  const have = await writeCommit(ctx, haveRootTree, [base], 'have');
  const wantRootTree = await writeTree(ctx, [
    treeEntry('40000' as FileMode, 'a', treeA1),
    treeEntry('40000' as FileMode, 'b', treeB1),
  ]);
  const want = await writeCommit(ctx, wantRootTree, [have], 'want');
  return { have, want, haveRootTree, wantRootTree, treeA1, aOneV1, treeB1, bOneV1 };
};

interface MissingSubtreeFixture {
  readonly have: ObjectId;
  readonly want: ObjectId;
  readonly subtreeX: ObjectId;
  readonly subtreeY: ObjectId;
  readonly yBlob: ObjectId;
  readonly sharedBlob: ObjectId;
  readonly subtreeW: ObjectId;
  readonly wantRootTree: ObjectId;
}

/**
 * `have` holds `x/f` and `y/g`; `want` adds `w/f2` carrying the SAME blob as
 * `x/f`, and reuses `x` and `y` wholesale. With every object present, marking
 * `have` prunes that blob through subtree `x`, so `want` emits only its own
 * root tree and `w`.
 */
const buildMissingSubtreeFixture = async (ctx: Context): Promise<MissingSubtreeFixture> => {
  const sharedBlob = await writeBlob(ctx, 'shared-blob');
  const yBlob = await writeBlob(ctx, 'y-content');
  const subtreeX = await writeTree(ctx, [treeEntry('100644' as FileMode, 'f', sharedBlob)]);
  const subtreeY = await writeTree(ctx, [treeEntry('100644' as FileMode, 'g', yBlob)]);
  const subtreeW = await writeTree(ctx, [treeEntry('100644' as FileMode, 'f2', sharedBlob)]);
  const haveRootTree = await writeTree(ctx, [
    treeEntry('40000' as FileMode, 'x', subtreeX),
    treeEntry('40000' as FileMode, 'y', subtreeY),
  ]);
  const have = await writeCommit(ctx, haveRootTree, [], 'have');
  const wantRootTree = await writeTree(ctx, [
    treeEntry('40000' as FileMode, 'w', subtreeW),
    treeEntry('40000' as FileMode, 'x', subtreeX),
    treeEntry('40000' as FileMode, 'y', subtreeY),
  ]);
  const want = await writeCommit(ctx, wantRootTree, [have], 'want');
  return { have, want, subtreeX, subtreeY, yBlob, sharedBlob, subtreeW, wantRootTree };
};

describe('computeClosure — a not-side tree missing from the local object store', () => {
  describe('Given a not tip whose own root tree object is absent locally', () => {
    describe('When computeClosure walks the objects closure', () => {
      it('Then the unreadable tree alone stays pruned and everything under the want is over-reported', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const fixture = await buildMissingRootTreeFixture(ctx);
        await deleteLooseObject(ctx, fixture.haveRootTree);
        const sut = computeClosure;

        // Act
        const result = await sut(ctx, {
          tier: 'walk',
          wants: [fixture.want],
          not: [fixture.have],
          objects: true,
        });

        // Assert — real git 2.55.0 on the identical shape exits 0 and lists
        // exactly this set: nothing under the unreadable tree can be marked, so
        // subtree `a` and its blob come back although the intact repository
        // prunes both.
        expect(new Set(result.objects.map((object) => object.id))).toEqual(
          new Set([
            fixture.want,
            fixture.wantRootTree,
            fixture.treeA1,
            fixture.aOneV1,
            fixture.treeB1,
            fixture.bOneV1,
          ]),
        );
      });
    });
  });

  describe('Given a not tip whose root tree is readable but one of its subtrees is absent locally', () => {
    describe('When computeClosure walks the objects closure', () => {
      it('Then only that subtree’s contents are over-reported, the subtree id and its siblings staying pruned', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const fixture = await buildMissingSubtreeFixture(ctx);
        await deleteLooseObject(ctx, fixture.subtreeX);
        const sut = computeClosure;

        // Act
        const result = await sut(ctx, {
          tier: 'walk',
          wants: [fixture.want],
          not: [fixture.have],
          objects: true,
        });

        // Assert — real git 2.55.0 on the identical shape adds exactly the
        // shared blob: `x` itself is still marked (so `want` never descends
        // into it), sibling `y` and its blob are still pruned in full.
        expect(new Set(result.objects.map((object) => object.id))).toEqual(
          new Set([fixture.want, fixture.wantRootTree, fixture.subtreeW, fixture.sharedBlob]),
        );
      });
    });
  });
});

const asCommits = async (ctx: Context, ids: ReadonlyArray<ObjectId>): Promise<Commit[]> => {
  const commits: Commit[] = [];
  for (const id of ids) {
    const object = await readObjectModule.readObject(ctx, id);
    if (object.type !== 'commit') throw new Error('expected a commit');
    commits.push(object);
  }
  return commits;
};

interface FourCommitChain extends LinearChain {
  readonly c4: ObjectId;
  readonly t4: ObjectId;
  readonly b4: ObjectId;
}

/** `buildLinearChain` plus a fourth generation, so a `not` tip (`c3`) still
 *  has two strict ancestors behind it and one interesting commit ahead. */
const buildFourCommitChain = async (ctx: Context): Promise<FourCommitChain> => {
  const chain = await buildLinearChain(ctx);
  const b4 = await writeBlob(ctx, 'gen-4');
  const t4 = await writeTree(ctx, [treeEntry('100644' as FileMode, 'file.txt', b4)]);
  const c4 = await writeCommit(ctx, t4, [chain.c3], 'gen-4');
  return { ...chain, c4, t4, b4 };
};

interface OddParentFixture {
  readonly have: ObjectId;
  readonly want: ObjectId;
  readonly wantRootTree: ObjectId;
  readonly wantBlob: ObjectId;
  readonly shared: ObjectId;
  readonly sharedTree: ObjectId;
  readonly sharedBlob: ObjectId;
}

/**
 * `have` is a merge of `oddParent` — an oid the marker cannot turn into a
 * commit — and `shared`, a real commit that `want` also names as a parent. If
 * the not-side marker stops at `oddParent`, `shared` is never marked and the
 * interesting walk emits it; if it steps over it, `shared` is pruned.
 */
const buildOddParentFixture = async (
  ctx: Context,
  oddParent: ObjectId,
): Promise<OddParentFixture> => {
  const sharedBlob = await writeBlob(ctx, 'shared');
  const sharedTree = await writeTree(ctx, [treeEntry('100644' as FileMode, 'f.txt', sharedBlob)]);
  const shared = await writeCommit(ctx, sharedTree, [], 'shared');
  const haveBlob = await writeBlob(ctx, 'have');
  const haveTree = await writeTree(ctx, [treeEntry('100644' as FileMode, 'f.txt', haveBlob)]);
  const have = await writeCommit(ctx, haveTree, [oddParent, shared], 'have');
  const wantBlob = await writeBlob(ctx, 'want');
  const wantRootTree = await writeTree(ctx, [treeEntry('100644' as FileMode, 'f.txt', wantBlob)]);
  const want = await writeCommit(ctx, wantRootTree, [have, shared], 'want');
  return { have, want, wantRootTree, wantBlob, shared, sharedTree, sharedBlob };
};

describe('computeClosure — marking the not side', () => {
  describe('Given a commit-graph covering the whole not-side ancestry', () => {
    describe('When computeClosure marks that ancestry', () => {
      it('Then no strict not-side ancestor has its commit body read', async () => {
        // Arrange — the graph already serves the only two fields the marker
        // wants (root tree and parents); the tip itself is still read, since
        // the marker must learn its object type before it can mark anything.
        const ctx = await buildSeededContext();
        const chain = await buildFourCommitChain(ctx);
        await writeCommitGraph(ctx, [
          await asCommits(ctx, [chain.c1, chain.c2, chain.c3, chain.c4]),
        ]);
        const readSpy = vi.spyOn(readObjectModule, 'readObject');
        const sut = computeClosure;

        // Act
        await sut(ctx, {
          tier: 'walk',
          wants: [chain.c4],
          not: [chain.c3],
          objects: true,
        });

        // Assert
        const idsRead = readSpy.mock.calls.map(([, id]) => id);
        expect(idsRead).not.toContain(chain.c1);
        expect(idsRead).not.toContain(chain.c2);
      });
    });
  });

  describe('Given the same history with and without a commit-graph', () => {
    describe('When computeClosure prunes the same not tip from both', () => {
      it('Then both emit the identical object set', async () => {
        // Arrange — the two fixtures are content-addressed from identical
        // inputs, so every oid matches across them.
        const graphed = await buildSeededContext();
        const chain = await buildFourCommitChain(graphed);
        await writeCommitGraph(graphed, [
          await asCommits(graphed, [chain.c1, chain.c2, chain.c3, chain.c4]),
        ]);
        const bare = await buildSeededContext();
        await buildFourCommitChain(bare);
        const request = {
          tier: 'walk',
          wants: [chain.c4],
          not: [chain.c3],
          objects: true,
        } as const;

        // Act
        const withGraph = await computeClosure(graphed, request);
        const withoutGraph = await computeClosure(bare, request);

        // Assert
        expect(new Set(withGraph.objects.map((object) => object.id))).toEqual(
          new Set(withoutGraph.objects.map((object) => object.id)),
        );
      });
    });
  });

  describe('Given a not-side commit one of whose parents has no object at all', () => {
    describe('When computeClosure marks that ancestry', () => {
      it('Then the absent parent is stepped over and the sibling parent is still marked', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const fixture = await buildOddParentFixture(ctx, '1'.repeat(40) as ObjectId);
        const sut = computeClosure;

        // Act
        const result = await sut(ctx, {
          tier: 'walk',
          wants: [fixture.want],
          not: [fixture.have],
          objects: true,
        });

        // Assert — `shared` and everything under it stayed pruned.
        expect(new Set(result.objects.map((object) => object.id))).toEqual(
          new Set([fixture.want, fixture.wantRootTree, fixture.wantBlob]),
        );
      });
    });
  });

  describe('Given a not-side commit one of whose parent oids names a blob', () => {
    describe('When computeClosure marks that ancestry', () => {
      it('Then the non-commit parent is stepped over and the sibling parent is still marked', async () => {
        // Arrange — a separate row from the absent-parent one: two independent
        // conditions guard the same enqueue, and one input cannot prove both.
        const ctx = await buildSeededContext();
        const notACommit = await writeBlob(ctx, 'not a commit');
        const fixture = await buildOddParentFixture(ctx, notACommit);
        const sut = computeClosure;

        // Act
        const result = await sut(ctx, {
          tier: 'walk',
          wants: [fixture.want],
          not: [fixture.have],
          objects: true,
        });

        // Assert
        expect(new Set(result.objects.map((object) => object.id))).toEqual(
          new Set([fixture.want, fixture.wantRootTree, fixture.wantBlob]),
        );
      });
    });
  });
});

describe("computeClosure — the not-side ancestry walk keeps the commit walk's frontier discipline", () => {
  const buildWantOver = async (
    ctx: Context,
    notTip: ObjectId,
  ): Promise<{
    readonly wantId: ObjectId;
    readonly treeId: ObjectId;
    readonly blobId: ObjectId;
  }> => {
    const blobId = await writeBlob(ctx, 'want-side content');
    const treeId = await writeTree(ctx, [treeEntry('100644' as FileMode, 'w.txt', blobId)]);
    const wantId = await writeCommit(ctx, treeId, [notTip], 'want');
    return { wantId, treeId, blobId };
  };

  describe('Given a commit-graph covering the not side and a signal aborted right after the tip is consulted', () => {
    describe('When computeClosure marks the not side', () => {
      it('Then the ancestry walk stops at its own loop-top check before consulting the parent', async () => {
        // Arrange — under a graph the marker performs no object read inside
        // its loop, so no other abort check can fire there: the loop-top check
        // is the only thing between consulting the tip and consulting its
        // parent. The abort lands as the tip's meta resolves.
        const ctx = await buildSeededContext();
        const blobId = await writeBlob(ctx, 'have');
        const treeId = await writeTree(ctx, [treeEntry('100644' as FileMode, 'h.txt', blobId)]);
        const rootId = await writeCommit(ctx, treeId, [], 'root');
        const notTipId = await writeCommit(ctx, treeId, [rootId], 'have');
        const { wantId } = await buildWantOver(ctx, notTipId);
        const layer = await Promise.all(
          [rootId, notTipId, wantId].map(
            async (id) => (await readObjectModule.readObject(ctx, id)) as Commit,
          ),
        );
        await writeCommitGraph(ctx, [layer]);
        const controller = new AbortController();
        const original = readCommitMetaModule.readCommitMeta;
        const metaSpy = vi
          .spyOn(readCommitMetaModule, 'readCommitMeta')
          .mockImplementation(async (c, id) => {
            const meta = await original(c, id);
            controller.abort();
            return meta;
          });
        const sut = computeClosure;

        // Act
        let caught: unknown;
        try {
          await sut(
            { ...ctx, signal: controller.signal },
            { tier: 'walk', wants: [wantId], not: [notTipId], objects: true },
          );
          expect.unreachable();
        } catch (error) {
          caught = error;
        }

        // Assert — the tip was consulted once; its parent never was
        expect((caught as TsgitError).data.code).toBe('OPERATION_ABORTED');
        expect(metaSpy).toHaveBeenCalledTimes(1);
        metaSpy.mockRestore();
      });
    });
  });

  describe('Given a not tip naming more distinct parents than the frontier bound admits', () => {
    describe('When computeClosure marks its ancestry', () => {
      it("Then it refuses with the commit walk's own queue-overflow reason", async () => {
        // Arrange — MAX_WALK_QUEUE_SIZE + 1 distinct, never-written parent
        // oids: the marker must refuse exactly as `walkCommits` does, not walk
        // an unbounded frontier.
        const ctx = await buildSeededContext();
        const blobId = await writeBlob(ctx, 'have');
        const treeId = await writeTree(ctx, [treeEntry('100644' as FileMode, 'h.txt', blobId)]);
        const parents = Array.from(
          { length: MAX_WALK_QUEUE_SIZE + 1 },
          (_, i) => i.toString(16).padStart(40, '0') as ObjectId,
        );
        const notTipId = await writeCommit(ctx, treeId, parents, 'octopus have');
        const { wantId } = await buildWantOver(ctx, notTipId);
        const sut = computeClosure;

        // Act
        let caught: unknown;
        try {
          await sut(ctx, { tier: 'walk', wants: [wantId], not: [notTipId], objects: true });
          expect.unreachable();
        } catch (error) {
          caught = error;
        }

        // Assert
        expect((caught as TsgitError).data).toMatchObject({
          code: 'INVALID_WALK_INPUT',
          reason: REASON_WALK_QUEUE_OVERFLOW,
        });
      });
    });
  });

  describe('Given a not-side layer every commit of the layer above names in full', () => {
    describe('When computeClosure marks the not side', () => {
      it('Then each parent is queued once, so 67,600 parent references stay under the bound', async () => {
        // Arrange — 260 roots and 260 commits each naming all 260 roots, all
        // below the not tip: 67,600 parent references, more than the bound
        // admits as raw pushes, but at most 260 distinct pending ids.
        const ctx = await buildSeededContext();
        const blobId = await writeBlob(ctx, 'have');
        const treeId = await writeTree(ctx, [treeEntry('100644' as FileMode, 'h.txt', blobId)]);
        const roots: ObjectId[] = [];
        for (let i = 0; i < 260; i += 1)
          roots.push(await writeCommit(ctx, treeId, [], `root ${i}`));
        const layer: ObjectId[] = [];
        for (let i = 0; i < 260; i += 1)
          layer.push(await writeCommit(ctx, treeId, roots, `layer ${i}`));
        const notTipId = await writeCommit(ctx, treeId, layer, 'have');
        const {
          wantId,
          treeId: wantTreeId,
          blobId: wantBlobId,
        } = await buildWantOver(ctx, notTipId);
        const sut = computeClosure;

        // Act
        const result = await sut(ctx, {
          tier: 'walk',
          wants: [wantId],
          not: [notTipId],
          objects: true,
        });

        // Assert — the whole not side is marked; only the want's own objects survive
        expect(new Set(result.objects.map((o) => o.id))).toEqual(
          new Set([wantId, wantTreeId, wantBlobId]),
        );
      });
    });
  });
});

describe('computeClosure — the not-side ancestry walk consults each commit once and rethrows what it cannot classify', () => {
  const haveTree = async (ctx: Context): Promise<ObjectId> => {
    const blobId = await writeBlob(ctx, 'have');
    return writeTree(ctx, [treeEntry('100644' as FileMode, 'h.txt', blobId)]);
  };
  const consulted = (spy: { mock: { calls: ReadonlyArray<ReadonlyArray<unknown>> } }): ObjectId[] =>
    spy.mock.calls.map((call) => call[1] as ObjectId);

  describe('Given two not tips sharing an ancestry, When computeClosure marks the not side', () => {
    it("Then the second tip's walk stops on the ancestry the first already marked, consulting no commit twice", async () => {
      // Arrange
      const ctx = await buildSeededContext();
      const treeId = await haveTree(ctx);
      const rootId = await writeCommit(ctx, treeId, [], 'root');
      const tip2 = await writeCommit(ctx, treeId, [rootId], 'have two');
      const tip1 = await writeCommit(ctx, treeId, [tip2], 'have one');
      const wantId = await writeCommit(ctx, treeId, [tip1], 'want');
      const metaSpy = vi.spyOn(readCommitMetaModule, 'readCommitMeta');
      const sut = computeClosure;

      // Act
      await sut(ctx, { tier: 'walk', wants: [wantId], not: [tip1, tip2], objects: true });

      // Assert
      const ids = consulted(metaSpy);
      expect(new Set(ids).size).toBe(ids.length);
      expect(new Set(ids)).toEqual(new Set([tip1, tip2, rootId]));
      metaSpy.mockRestore();
    });
  });

  describe('Given a not-side parent the store lacks, named by two children, When computeClosure marks the not side', () => {
    it('Then the missing parent is consulted once — the miss is remembered', async () => {
      // Arrange
      const ctx = await buildSeededContext();
      const treeId = await haveTree(ctx);
      const missing = 'e'.repeat(40) as ObjectId;
      const c1 = await writeCommit(ctx, treeId, [missing], 'child one');
      const c2 = await writeCommit(ctx, treeId, [missing], 'child two');
      const notTipId = await writeCommit(ctx, treeId, [c1, c2], 'have');
      const wantId = await writeCommit(ctx, treeId, [notTipId], 'want');
      const metaSpy = vi.spyOn(readCommitMetaModule, 'readCommitMeta');
      const sut = computeClosure;

      // Act
      await sut(ctx, { tier: 'walk', wants: [wantId], not: [notTipId], objects: true });

      // Assert
      expect(consulted(metaSpy).filter((id) => id === missing)).toHaveLength(1);
      metaSpy.mockRestore();
    });
  });

  describe('Given a not-side parent the store lacks, named again by a commit that pops after the miss, When computeClosure marks the not side', () => {
    it('Then the parent is consulted once — the remembered miss stops the second enqueue', async () => {
      // Arrange — the frontier is FIFO: tip → [c1, c2]; c1 → [missing]; c2 → [d];
      // d → [missing]. It pops c1, c2, missing, d in that order, so d names the
      // parent after its miss was recorded and after it left the pending set —
      // only the remembered miss can stop the second consultation.
      const ctx = await buildSeededContext();
      const treeId = await haveTree(ctx);
      const missing = 'e'.repeat(40) as ObjectId;
      const c1 = await writeCommit(ctx, treeId, [missing], 'child one');
      const d = await writeCommit(ctx, treeId, [missing], 'grandchild');
      const c2 = await writeCommit(ctx, treeId, [d], 'child two');
      const notTipId = await writeCommit(ctx, treeId, [c1, c2], 'have');
      const wantId = await writeCommit(ctx, treeId, [notTipId], 'want');
      const metaSpy = vi.spyOn(readCommitMetaModule, 'readCommitMeta');
      const sut = computeClosure;

      // Act
      await sut(ctx, { tier: 'walk', wants: [wantId], not: [notTipId], objects: true });

      // Assert
      expect(consulted(metaSpy).filter((id) => id === missing)).toHaveLength(1);
      metaSpy.mockRestore();
    });
  });

  describe('Given a not tip naming an already-marked parent beside exactly the bound of fresh parents', () => {
    describe('When computeClosure marks the not side', () => {
      it('Then the marked parent is not queued again, so the walk stays within the bound and completes', async () => {
        // Arrange — M is marked when A pops; if A's reference to M were queued
        // regardless, the pending count would reach the bound one push early
        // and the walk would refuse instead of completing.
        const ctx = await buildSeededContext();
        const treeId = await haveTree(ctx);
        const m = await writeCommit(ctx, treeId, [], 'marked first');
        const fresh = Array.from(
          { length: MAX_WALK_QUEUE_SIZE },
          (_, i) => i.toString(16).padStart(40, '0') as ObjectId,
        );
        const a = await writeCommit(ctx, treeId, [m, ...fresh], 'octopus');
        const notTipId = await writeCommit(ctx, treeId, [m, a], 'have');
        const wantId = await writeCommit(ctx, treeId, [notTipId], 'want');
        const sut = computeClosure;

        // Act
        const result = await sut(ctx, {
          tier: 'walk',
          wants: [wantId],
          not: [notTipId],
          objects: true,
        });

        // Assert
        expect(result.objects.map((o) => o.id)).toContain(wantId);
      });
    });
  });

  describe.each([
    { label: 'a classified refusal', make: () => invalidWalkInput('boom') },
    { label: 'an unclassified failure', make: () => new Error('boom') },
  ])(
    'Given a not-side tree read that fails with $label, When computeClosure marks the not side',
    ({ make }) => {
      it('Then computeClosure rethrows that very error instead of treating the tree as missing', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const treeId = await haveTree(ctx);
        const notTipId = await writeCommit(ctx, treeId, [], 'have');
        const wantId = await writeCommit(ctx, treeId, [notTipId], 'want');
        const thrown = make();
        const original = readObjectModule.readObject;
        const readSpy = vi
          .spyOn(readObjectModule, 'readObject')
          .mockImplementation(async (c, id) => {
            if (id === treeId) throw thrown;
            return original(c, id);
          });
        const sut = computeClosure;

        // Act
        let caught: unknown;
        try {
          await sut(ctx, { tier: 'walk', wants: [wantId], not: [notTipId], objects: true });
          expect.unreachable();
        } catch (error) {
          caught = error;
        }

        // Assert
        expect(caught).toBe(thrown);
        readSpy.mockRestore();
      });
    },
  );

  describe.each([
    { label: 'a classified refusal', make: () => invalidWalkInput('boom') },
    { label: 'an unclassified failure', make: () => new Error('boom') },
  ])(
    'Given a not-side ancestor read that fails with $label, When computeClosure marks the not side',
    ({ make }) => {
      it('Then computeClosure rethrows that very error instead of skipping the ancestor', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const treeId = await haveTree(ctx);
        const rootId = await writeCommit(ctx, treeId, [], 'root');
        const notTipId = await writeCommit(ctx, treeId, [rootId], 'have');
        const wantId = await writeCommit(ctx, treeId, [notTipId], 'want');
        const thrown = make();
        const original = readCommitMetaModule.readCommitMeta;
        const metaSpy = vi
          .spyOn(readCommitMetaModule, 'readCommitMeta')
          .mockImplementation(async (c, id) => {
            if (id === rootId) throw thrown;
            return original(c, id);
          });
        const sut = computeClosure;

        // Act
        let caught: unknown;
        try {
          await sut(ctx, { tier: 'walk', wants: [wantId], not: [notTipId], objects: true });
          expect.unreachable();
        } catch (error) {
          caught = error;
        }

        // Assert
        expect(caught).toBe(thrown);
        metaSpy.mockRestore();
      });
    },
  );

  describe('Given a commit not tip that is a boundary of the want, When computeClosure runs commits-only vs objects', () => {
    it('Then no tree is read commits-only, but the boundary tree is read under objects', async () => {
      // Arrange — the not tip is the want's parent, so under objects its tree
      // is an edge parent that markBoundaryTrees marks; commits-only reads no
      // tree at all.
      const ctx = await buildSeededContext();
      const treeId = await haveTree(ctx);
      const notTipId = await writeCommit(ctx, treeId, [], 'have');
      const wantId = await writeCommit(ctx, treeId, [notTipId], 'want');
      const readSpy = vi.spyOn(readObjectModule, 'readObject');
      const sut = computeClosure;

      // Act
      await sut(ctx, { tier: 'walk', wants: [wantId], not: [notTipId], objects: false });
      const commitsOnlyReads = consulted(readSpy);
      readSpy.mockClear();
      await sut(ctx, { tier: 'walk', wants: [wantId], not: [notTipId], objects: true });
      const objectsReads = consulted(readSpy);

      // Assert — the objects closure is the control that proves the read is observable
      expect(commitsOnlyReads).not.toContain(treeId);
      expect(objectsReads).toContain(treeId);
      readSpy.mockRestore();
    });
  });

  describe('Given a want and an unrelated commit not tip that share a blob, When computeClosure emits objects', () => {
    it("Then the shared blob is still emitted — a non-boundary not tip's own tree is left unmarked", async () => {
      // Arrange — W and T have no common history; both trees name the same blob.
      // git's `rev-list --objects W ^T` emits the shared blob because T's tree is
      // never an edge parent of the interesting walk, so it is never marked
      // (session-verified against git 2.55.0: 4 objects, the shared blob among
      // them).
      const ctx = await buildSeededContext();
      const shared = await writeBlob(ctx, 'shared');
      const wOnly = await writeBlob(ctx, 'w-only');
      const treeW = await writeTree(ctx, [
        treeEntry('100644' as FileMode, 'shared.txt', shared),
        treeEntry('100644' as FileMode, 'w.txt', wOnly),
      ]);
      const treeT = await writeTree(ctx, [treeEntry('100644' as FileMode, 'shared.txt', shared)]);
      const wantId = await writeCommit(ctx, treeW, [], 'W');
      const notTipId = await writeCommit(ctx, treeT, [], 'T');
      const sut = computeClosure;

      // Act
      const result = await sut(ctx, {
        tier: 'walk',
        wants: [wantId],
        not: [notTipId],
        objects: true,
      });
      const ids = new Set(result.objects.map((entry) => entry.id));

      // Assert — the not tip's own tree/blob are excluded, but the blob the want
      // ALSO reaches is emitted
      expect(ids).toContain(shared);
      expect(ids).toContain(wOnly);
      expect(ids).toContain(treeW);
      expect(ids).not.toContain(treeT);
      expect(ids).not.toContain(notTipId);
    });
  });

  describe('Given two not tips whose ancestries name the same absent parent, When computeClosure marks the not side', () => {
    it('Then that parent is consulted once across both tips — the miss memo is shared', async () => {
      // Arrange — tipA and tipB each name the same missing parent; the shared
      // memo must stop the second tip from re-reading it.
      const ctx = await buildSeededContext();
      const treeId = await haveTree(ctx);
      const missing = 'e'.repeat(40) as ObjectId;
      const tipA = await writeCommit(ctx, treeId, [missing], 'have A');
      const tipB = await writeCommit(ctx, treeId, [missing], 'have B');
      const wantId = await writeCommit(ctx, treeId, [tipA, tipB], 'want');
      const metaSpy = vi.spyOn(readCommitMetaModule, 'readCommitMeta');
      const sut = computeClosure;

      // Act
      await sut(ctx, { tier: 'walk', wants: [wantId], not: [tipA, tipB], objects: true });

      // Assert
      expect(consulted(metaSpy).filter((id) => id === missing)).toHaveLength(1);
      metaSpy.mockRestore();
    });
  });
});
