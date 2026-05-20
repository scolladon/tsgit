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

describe('enumeratePushObjects', () => {
  it('Given empty haves and a single-commit want, When enumerated, Then yields commit + tree + blob (deduped)', async () => {
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

  it('Given haves cover the parent commit, When enumerated, Then only the tip commit closure is yielded', async () => {
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

  it('Given duplicate wants, When enumerated, Then each oid is yielded at most once', async () => {
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

  it('Given a gitlink entry inside the tree, When enumerated, Then the gitlink oid is NOT yielded', async () => {
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

  it('Given a tiny maxObjects cap (1), When enumerated, Then throws PACK_TOO_LARGE before draining', async () => {
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

  it('Given an annotated tag as a want, When enumerated, Then the tag oid AND the unwrapped commit closure are yielded', async () => {
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
