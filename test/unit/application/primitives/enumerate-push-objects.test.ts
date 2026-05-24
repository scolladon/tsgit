/**
 * Unit tests for the prior `enumeratePushObjects` walker.
 *
 * Coverage:
 *  - empty haves + single want → full closure (commit + tree + blob)
 *  - haves cover the parent commit → only the tip's closure is yielded
 *  - dedup across multiple wants → each oid yielded once
 *  - gitlink entries are skipped (mode 160000)
 *  - cap overflow → throws PACK_TOO_LARGE
 */
import { describe, expect, it } from 'vitest';

import { enumeratePushObjects } from '../../../../src/application/primitives/enumerate-push-objects.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import { writeTree } from '../../../../src/application/primitives/write-tree.js';
import { TsgitError } from '../../../../src/domain/index.js';
import type { Blob, Commit, FileMode, ObjectId } from '../../../../src/domain/objects/index.js';
import type { Context } from '../../../../src/ports/context.js';
import { buildSeededContext } from './fixtures.js';

interface SeededCommit {
  readonly commitId: ObjectId;
  readonly treeId: ObjectId;
  readonly blobId: ObjectId;
}

const seedCommit = async (
  ctx: Context,
  parent: ObjectId | undefined,
  fileContent: string,
): Promise<SeededCommit> => {
  const blob: Blob = {
    type: 'blob',
    content: new TextEncoder().encode(fileContent),
    id: '' as ObjectId,
  };
  const blobId = await writeObject(ctx, blob);
  const treeId = await writeTree(ctx, [
    { name: 'README.md', mode: '100644' as FileMode, id: blobId },
  ]);
  const author = {
    name: 'A',
    email: 'a@a',
    timestamp: 0,
    timezoneOffset: '+0000',
  };
  const commit: Commit = {
    type: 'commit',
    id: '' as ObjectId,
    data: {
      tree: treeId,
      parents: parent === undefined ? [] : [parent],
      author,
      committer: author,
      message: fileContent,
      extraHeaders: [],
    },
  };
  const commitId = await writeObject(ctx, commit);
  return { commitId, treeId, blobId };
};

const collect = async (iter: AsyncIterable<ObjectId>): Promise<ObjectId[]> => {
  const out: ObjectId[] = [];
  for await (const v of iter) out.push(v);
  return out;
};

const AUTHOR = {
  name: 'A',
  email: 'a@a',
  timestamp: 0,
  timezoneOffset: '+0000',
} as const;

/** Write a commit pointing at an already-seeded tree (lets two commits share a tree). */
const writeCommitForTree = async (
  ctx: Context,
  treeId: ObjectId,
  parent: ObjectId | undefined,
  message: string,
): Promise<ObjectId> => {
  const commit: Commit = {
    type: 'commit',
    id: '' as ObjectId,
    data: {
      tree: treeId,
      parents: parent === undefined ? [] : [parent],
      author: AUTHOR,
      committer: AUTHOR,
      message,
      extraHeaders: [],
    },
  };
  return writeObject(ctx, commit);
};

describe('enumeratePushObjects', () => {
  describe('Given empty haves and a single-commit want', () => {
    describe('When enumerated', () => {
      it('Then yields commit + tree + blob (deduped)', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const tip = await seedCommit(ctx, undefined, 'hello');

        // Act
        const sut = await collect(enumeratePushObjects(ctx, { wants: [tip.commitId], haves: [] }));

        // Assert — three distinct ids in the closure.
        const set = new Set(sut);
        expect(set.size).toBe(3);
        expect(set.has(tip.commitId)).toBe(true);
        expect(set.has(tip.treeId)).toBe(true);
        expect(set.has(tip.blobId)).toBe(true);
      });
    });
  });

  describe('Given haves cover the parent commit', () => {
    describe('When enumerated', () => {
      it('Then only the tip commit closure is yielded', async () => {
        // Arrange — kills the `until` boundary mutant: without honoring it,
        // the walker would yield the parent + its tree too.
        const ctx = await buildSeededContext();
        const parent = await seedCommit(ctx, undefined, 'gen-1');
        const tip = await seedCommit(ctx, parent.commitId, 'gen-2');

        // Act
        const sut = await collect(
          enumeratePushObjects(ctx, { wants: [tip.commitId], haves: [parent.commitId] }),
        );

        // Assert — only the tip commit + its tree + its blob.
        expect(sut).toContain(tip.commitId);
        expect(sut).toContain(tip.treeId);
        expect(sut).toContain(tip.blobId);
        expect(sut).not.toContain(parent.commitId);
        expect(sut).not.toContain(parent.treeId);
        // Their blob WOULD also be excluded since the trees differ (different
        // content per generation produces different blob oids).
        expect(sut).not.toContain(parent.blobId);
      });
    });
  });

  describe('Given duplicate wants', () => {
    describe('When enumerated', () => {
      it('Then each oid is yielded at most once', async () => {
        // Arrange — kills the dedup-Set mutant.
        const ctx = await buildSeededContext();
        const tip = await seedCommit(ctx, undefined, 'solo');

        // Act
        const sut = await collect(
          enumeratePushObjects(ctx, {
            wants: [tip.commitId, tip.commitId],
            haves: [],
          }),
        );

        // Assert
        expect(new Set(sut).size).toBe(sut.length);
      });
    });
  });

  describe('Given a gitlink entry inside the tree', () => {
    describe('When enumerated', () => {
      it('Then the gitlink oid is NOT yielded', async () => {
        // Arrange — set up a tree that contains a 160000 (submodule) entry.
        // The submodule oid is a fabricated commit oid that does NOT exist
        // locally; the walker must skip it without reading.
        const ctx = await buildSeededContext();
        const blob: Blob = {
          type: 'blob',
          content: new Uint8Array([0xab]),
          id: '' as ObjectId,
        };
        const blobId = await writeObject(ctx, blob);
        const submoduleOid = 'c'.repeat(40) as ObjectId;
        const treeId = await writeTree(ctx, [
          { name: 'submodule', mode: '160000' as FileMode, id: submoduleOid },
          { name: 'README.md', mode: '100644' as FileMode, id: blobId },
        ]);
        const author = {
          name: 'A',
          email: 'a@a',
          timestamp: 0,
          timezoneOffset: '+0000',
        };
        const commit: Commit = {
          type: 'commit',
          id: '' as ObjectId,
          data: {
            tree: treeId,
            parents: [],
            author,
            committer: author,
            message: 'with submodule',
            extraHeaders: [],
          },
        };
        const commitId = await writeObject(ctx, commit);

        // Act
        const sut = await collect(enumeratePushObjects(ctx, { wants: [commitId], haves: [] }));

        // Assert — submodule oid is NOT in the stream, blob IS.
        expect(sut).not.toContain(submoduleOid);
        expect(sut).toContain(blobId);
      });
    });
  });

  describe('Given a tiny maxObjects cap (1)', () => {
    describe('When enumerated', () => {
      it('Then throws PACK_TOO_LARGE before draining', async () => {
        // Arrange — kills the `>` vs `>=` cap-comparison mutant.
        const ctx = await buildSeededContext();
        const tip = await seedCommit(ctx, undefined, 'too big');

        // Act
        let caught: unknown;
        try {
          await collect(
            enumeratePushObjects(ctx, {
              wants: [tip.commitId],
              haves: [],
              maxObjects: 1,
            }),
          );
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        const data = (caught as TsgitError).data as {
          code: string;
          limit: number;
          objectCount: number;
        };
        expect(data.code).toBe('PACK_TOO_LARGE');
        expect(data.limit).toBe(1);
        // objectCount must reflect the SIZE THAT WOULD HAVE EXCEEDED the cap.
        // Kills the mutant that replaces `state.emitted.size + 1` with a
        // constant or with `state.emitted.size` post-insert.
        expect(data.objectCount).toBeGreaterThan(data.limit);
      });
    });
  });

  describe('Given an annotated tag as a want', () => {
    describe('When enumerated', () => {
      it('Then the tag oid AND the unwrapped commit closure are yielded', async () => {
        // Arrange — write a commit, then an annotated tag pointing at it.
        const ctx = await buildSeededContext();
        const tip = await seedCommit(ctx, undefined, 'tagged');
        const tag = {
          type: 'tag' as const,
          id: '' as ObjectId,
          data: {
            object: tip.commitId,
            objectType: 'commit' as const,
            tagName: 'v1.0',
            tagger: {
              name: 'A',
              email: 'a@a',
              timestamp: 0,
              timezoneOffset: '+0000',
            },
            message: 'release\n',
            extraHeaders: [],
          },
        };
        const tagId = await writeObject(ctx, tag);

        // Act — supply the TAG oid as a want; the walker must record the tag
        // and follow its target to the commit.
        const sut = await collect(enumeratePushObjects(ctx, { wants: [tagId], haves: [] }));

        // Assert — tag oid + commit + tree + blob all in the stream.
        expect(sut).toContain(tagId);
        expect(sut).toContain(tip.commitId);
        expect(sut).toContain(tip.treeId);
        expect(sut).toContain(tip.blobId);
      });
    });
  });

  describe('Given two commits sharing the same tree', () => {
    describe('When enumerated', () => {
      it('Then the shared tree and blob are yielded exactly once', async () => {
        // Arrange — kills the dedup `state.emitted.has(id)` mutants in `tryEmit`:
        // under `if (false)` / `return true`, the shared tree (and blob) would be
        // yielded a second time when the parent commit is walked.
        const ctx = await buildSeededContext();
        const blob: Blob = {
          type: 'blob',
          content: new TextEncoder().encode('shared'),
          id: '' as ObjectId,
        };
        const blobId = await writeObject(ctx, blob);
        const treeId = await writeTree(ctx, [
          { name: 'README.md', mode: '100644' as FileMode, id: blobId },
        ]);
        // Parent and child point at the SAME tree (an empty/no-op commit).
        const parentId = await writeCommitForTree(ctx, treeId, undefined, 'gen-1');
        const childId = await writeCommitForTree(ctx, treeId, parentId, 'gen-2');

        // Act
        const sut = await collect(enumeratePushObjects(ctx, { wants: [childId], haves: [] }));

        // Assert — both commits yielded, tree and blob each appear exactly once.
        expect(sut).toContain(parentId);
        expect(sut).toContain(childId);
        expect(sut.filter((id) => id === treeId)).toHaveLength(1);
        expect(sut.filter((id) => id === blobId)).toHaveLength(1);
      });
    });
  });

  describe('Given a want commit with a missing parent', () => {
    describe('When enumerated', () => {
      it('Then the tip closure is yielded and the missing parent is skipped', async () => {
        // Arrange — kills the `ignoreMissing: true` BooleanLiteral mutant: under
        // `ignoreMissing: false`, walkCommits would throw OBJECT_NOT_FOUND on the
        // fabricated (never-written) parent oid instead of skipping it.
        const ctx = await buildSeededContext();
        const blob: Blob = {
          type: 'blob',
          content: new TextEncoder().encode('orphan'),
          id: '' as ObjectId,
        };
        const blobId = await writeObject(ctx, blob);
        const treeId = await writeTree(ctx, [
          { name: 'README.md', mode: '100644' as FileMode, id: blobId },
        ]);
        const missingParent = 'e'.repeat(40) as ObjectId;
        const tipId = await writeCommitForTree(ctx, treeId, missingParent, 'tip');

        // Act
        const sut = await collect(enumeratePushObjects(ctx, { wants: [tipId], haves: [] }));

        // Assert — closure resolved despite the missing parent.
        expect(sut).toContain(tipId);
        expect(sut).toContain(treeId);
        expect(sut).toContain(blobId);
        expect(sut).not.toContain(missingParent);
      });
    });
  });

  describe('Given maxObjects one below the closure size', () => {
    describe('When enumerated', () => {
      it('Then throws PACK_TOO_LARGE exactly at the boundary', async () => {
        // Arrange — closure is exactly 3 objects (commit + tree + blob). With
        // maxObjects=2 the cap must trip on the 3rd `tryEmit`. Kills:
        //  - L53 `>=` -> `>`: under `>`, size-2 add of the 3rd object is allowed.
        //  - L90/L91/L94 condition -> `true`: skipping a `tryEmit` call drops the
        //    cap increment so the throw never fires.
        const ctx = await buildSeededContext();
        const tip = await seedCommit(ctx, undefined, 'boundary');

        // Act
        let caught: unknown;
        try {
          await collect(
            enumeratePushObjects(ctx, { wants: [tip.commitId], haves: [], maxObjects: 2 }),
          );
        } catch (err) {
          caught = err;
        }

        // Assert — throws with the exact overflow count.
        expect(caught).toBeInstanceOf(TsgitError);
        const data = (caught as TsgitError).data as {
          code: string;
          limit: number;
          objectCount: number;
        };
        expect(data.code).toBe('PACK_TOO_LARGE');
        expect(data.limit).toBe(2);
        expect(data.objectCount).toBe(3);
      });
    });
  });

  describe('Given a commit whose tree contains a subdirectory', () => {
    describe('When enumerated', () => {
      it('Then the nested blob is yielded (recursive walk)', async () => {
        // Arrange — kills the `recursive: true` BooleanLiteral mutant: under
        // `recursive: false`, walkTree would not descend into the subtree and the
        // nested blob would be missing from the push closure.
        const ctx = await buildSeededContext();
        const nestedBlob: Blob = {
          type: 'blob',
          content: new TextEncoder().encode('nested'),
          id: '' as ObjectId,
        };
        const nestedBlobId = await writeObject(ctx, nestedBlob);
        const subTreeId = await writeTree(ctx, [
          { name: 'deep.txt', mode: '100644' as FileMode, id: nestedBlobId },
        ]);
        const rootTreeId = await writeTree(ctx, [
          { name: 'sub', mode: '40000' as FileMode, id: subTreeId },
        ]);
        const commitId = await writeCommitForTree(ctx, rootTreeId, undefined, 'with subdir');

        // Act
        const sut = await collect(enumeratePushObjects(ctx, { wants: [commitId], haves: [] }));

        // Assert — both the subtree and its nested blob are in the closure.
        expect(sut).toContain(subTreeId);
        expect(sut).toContain(nestedBlobId);
      });
    });
  });

  describe('Given a tag chain deeper than the unwrap cap', () => {
    describe('When enumerated', () => {
      it('Then the unwrap stops at the cap and the deepest tag is not recorded', async () => {
        // Arrange — build a chain of 17 annotated tags (tag1 -> ... -> tag17 ->
        // commit). The cap is 16: only 16 tags are unwrapped and the commit is
        // never reached as a walk seed. Kills:
        //  - L131 `i < 16` -> `i <= 16`: would record a 17th tag and reach commit.
        //  - L131 `i += 1` -> `i -= 1`: would loop until the chain ends naturally,
        //    recording all 17 tags and reaching the commit.
        const ctx = await buildSeededContext();
        const tip = await seedCommit(ctx, undefined, 'deep-tagged');
        let target: ObjectId = tip.commitId;
        let targetType: 'commit' | 'tag' = 'commit';
        const tagIds: ObjectId[] = [];
        for (let depth = 1; depth <= 17; depth += 1) {
          const tag = {
            type: 'tag' as const,
            id: '' as ObjectId,
            data: {
              object: target,
              objectType: targetType,
              tagName: `v${depth}`,
              tagger: AUTHOR,
              message: `tag-${depth}\n`,
              extraHeaders: [],
            },
          };
          const tagId = await writeObject(ctx, tag);
          tagIds.push(tagId);
          target = tagId;
          targetType = 'tag';
        }
        const outermostTag = tagIds[16] as ObjectId;
        const deepestTag = tagIds[0] as ObjectId;

        // Act — push the outermost tag (17 deep).
        const sut = await collect(enumeratePushObjects(ctx, { wants: [outermostTag], haves: [] }));

        // Assert — exactly 16 tags recorded; deepest tag, commit and blob excluded.
        expect(sut).toContain(outermostTag);
        expect(sut).not.toContain(deepestTag);
        expect(sut).not.toContain(tip.commitId);
        expect(sut).not.toContain(tip.blobId);
        expect(sut).toHaveLength(16);
      });
    });
  });
});
