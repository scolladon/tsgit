import { describe, expect, it } from 'vitest';
import { describeCandidates } from '../../../../../src/application/primitives/internal/ambiguous-candidates.js';
import { writeObject } from '../../../../../src/application/primitives/write-object.js';
import { writeTree } from '../../../../../src/application/primitives/write-tree.js';
import type { AuthorIdentity, ObjectId } from '../../../../../src/domain/objects/index.js';
import { treeEntry } from '../../../../../src/domain/objects/tree.js';
import type { Context } from '../../../../../src/ports/context.js';
import { buildSeededContext } from '../fixtures.js';

const AUTHOR: AuthorIdentity = {
  name: 'A',
  email: 'a@x',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0200',
};
const TAGGER: AuthorIdentity = {
  name: 'T',
  email: 't@x',
  timestamp: 1_500_000_000,
  timezoneOffset: '-1000',
};

interface Objects {
  readonly blob: ObjectId;
  readonly tree: ObjectId;
  readonly commit: ObjectId;
  readonly tag: ObjectId;
  readonly untagged: ObjectId;
}

const writeBlob = (ctx: Context, text: string): Promise<ObjectId> =>
  writeObject(ctx, { type: 'blob', id: '' as ObjectId, content: new TextEncoder().encode(text) });

const writeTag = (
  ctx: Context,
  target: ObjectId,
  tagName: string,
  tagger: AuthorIdentity | undefined,
): Promise<ObjectId> =>
  writeObject(ctx, {
    type: 'tag',
    id: '' as ObjectId,
    data: {
      object: target,
      objectType: 'commit',
      tagName,
      ...(tagger === undefined ? {} : { tagger }),
      message: 'msg\n',
      extraHeaders: [],
    },
  });

const writeObjects = async (ctx: Context): Promise<Objects> => {
  const blob = await writeBlob(ctx, 'content\n');
  const tree = await writeTree(ctx, [treeEntry('100644', 'f', blob)]);
  const commit = await writeObject(ctx, {
    type: 'commit',
    id: '' as ObjectId,
    data: {
      tree,
      parents: [],
      author: AUTHOR,
      committer: { ...AUTHOR, timezoneOffset: '+0000' },
      message: 'first line\nsecond line\n\nbody\n',
      extraHeaders: [],
    },
  });
  const tag = await writeTag(ctx, commit, 'v1', TAGGER);
  const untagged = await writeTag(ctx, commit, 'w1', undefined);
  return { blob, tree, commit, tag, untagged };
};

describe('describeCandidates', () => {
  describe('Given a blob, a tree, a commit, a tag and a tag without a tagger', () => {
    describe('When every one is described', () => {
      it('Then they come tags first in id order, then the commit, tree and blob, each as git shows it', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const ids = await writeObjects(ctx);
        const sut = describeCandidates;
        const tagDate = { timestamp: TAGGER.timestamp, timezoneOffset: '+0000' };
        const tags = [
          { id: ids.tag, type: 'tag', date: tagDate, subject: 'v1' },
          {
            id: ids.untagged,
            type: 'tag',
            date: { timestamp: 0, timezoneOffset: '+0000' },
            subject: 'w1',
          },
        ].sort((a, b) => (a.id < b.id ? -1 : 1));

        // Act
        const result = await sut(ctx, [ids.blob, ids.tree, ids.commit, ids.untagged, ids.tag]);

        // Assert
        expect(result.readFaults).toEqual([]);
        expect(result.candidates).toEqual([
          ...tags,
          {
            id: ids.commit,
            type: 'commit',
            date: { timestamp: AUTHOR.timestamp, timezoneOffset: '+0200' },
            subject: 'first line second line',
          },
          { id: ids.tree, type: 'tree' },
          { id: ids.blob, type: 'blob' },
        ]);
      });
    });
  });

  describe('Given two blobs', () => {
    describe('When they are described in descending id order', () => {
      it('Then they come back in ascending id order', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const [low, high] = [await writeBlob(ctx, 'a\n'), await writeBlob(ctx, 'b\n')].sort();
        const sut = describeCandidates;

        // Act
        const result = await sut(ctx, [high as ObjectId, low as ObjectId]);

        // Assert
        expect(result.candidates).toEqual([
          { id: low, type: 'blob' },
          { id: high, type: 'blob' },
        ]);
      });
    });
  });

  describe('Given an id naming no object', () => {
    describe('When it is described', () => {
      it('Then it is listed as a bad object without any read fault', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const absent = 'ab'.repeat(20) as ObjectId;
        const sut = describeCandidates;

        // Act
        const result = await sut(ctx, [absent]);

        // Assert
        expect(result.candidates).toEqual([{ id: absent, type: 'bad-object' }]);
        expect(result.readFaults).toEqual([]);
      });
    });
  });

  describe('Given three unreadable loose objects passed in descending id order', () => {
    describe('When they are described', () => {
      it('Then the type reads replay in the merge-sort order of the id-sorted set', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const [a, b, c] = ['a', 'b', 'c'].map((digit) => digit.repeat(40) as ObjectId) as [
          ObjectId,
          ObjectId,
          ObjectId,
        ];
        for (const id of [a, b, c]) {
          const path = `${ctx.layout.gitDir}/objects/${id.slice(0, 2)}/${id.slice(2)}`;
          await ctx.fs.write(path, new Uint8Array([1]));
        }
        const fault = (id: ObjectId): unknown => ({
          id,
          reason: 'unexpected end of deflate stream',
        });
        const sut = describeCandidates;

        // Act
        const result = await sut(ctx, [c, b, a]);

        // Assert
        expect(result.candidates.map(({ id }) => id)).toEqual([a, b, c]);
        expect(result.readFaults).toEqual([b, c, a, b, a, b, c].map(fault));
      });
    });
  });
});
