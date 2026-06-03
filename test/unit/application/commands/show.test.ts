import { describe, expect, it } from 'vitest';

import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { add } from '../../../../src/application/commands/add.js';
import { commit } from '../../../../src/application/commands/commit.js';
import { init } from '../../../../src/application/commands/init.js';
import { revParse } from '../../../../src/application/commands/rev-parse.js';
import { show } from '../../../../src/application/commands/show.js';
import { readObject } from '../../../../src/application/primitives/read-object.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import type { AuthorIdentity, ObjectId, TagData } from '../../../../src/domain/objects/index.js';
import type { Context } from '../../../../src/ports/context.js';

const author: AuthorIdentity = {
  name: 'A U Thor',
  email: 'author@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

const seedTwoCommits = async (): Promise<Context> => {
  const ctx = createMemoryContext();
  await init(ctx);
  await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'l1\nl2\nl3\nl4\nl5\n');
  await add(ctx, ['a.txt']);
  await commit(ctx, { message: 'first', author });
  await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'l1\nl2\nL3\nl4\nl5\n');
  await add(ctx, ['a.txt']);
  await commit(ctx, { message: 'second', author });
  return ctx;
};

const writeAnnotatedTag = (ctx: Context, target: ObjectId): Promise<ObjectId> => {
  const data: TagData = {
    object: target,
    objectType: 'commit',
    tagName: 'v1.0',
    tagger: author,
    message: 'release one\n',
    extraHeaders: [],
  };
  return writeObject(ctx, { type: 'tag', id: '' as ObjectId, data });
};

describe('show', () => {
  describe('Given a repository at HEAD, When show() runs with no rev', () => {
    it('Then it returns the HEAD commit with its structured patch', async () => {
      // Arrange
      const ctx = await seedTwoCommits();
      const head = await revParse(ctx, 'HEAD');

      // Act
      const sut = await show(ctx);

      // Assert
      expect(sut.kind).toBe('commit');
      if (sut.kind !== 'commit') throw new Error('expected commit');
      expect(sut.id).toBe(head);
      expect(sut.commit.message).toBe('second\n');
      expect(sut.patch?.changes).toEqual([
        expect.objectContaining({ type: 'modify', path: 'a.txt' }),
      ]);
    });
  });

  describe('Given a root commit, When show() runs on it', () => {
    it('Then the patch is computed against the empty tree (an add)', async () => {
      // Arrange
      const ctx = await seedTwoCommits();
      const root = await revParse(ctx, 'HEAD~1');

      // Act
      const sut = await show(ctx, root);

      // Assert
      if (sut.kind !== 'commit') throw new Error('expected commit');
      expect(sut.patch?.changes).toEqual([
        expect.objectContaining({ type: 'add', newPath: 'a.txt' }),
      ]);
    });
  });

  describe('Given a commit touching a nested directory, When show() runs', () => {
    it('Then the patch recurses to the per-file change', async () => {
      // Arrange — a commit whose tree has a sub-directory; the single-level
      // tree diff would surface `sub` as a tree-add, so this pins the flatten.
      const ctx = createMemoryContext();
      await init(ctx);
      await ctx.fs.writeUtf8(`${ctx.layout.workDir}/sub/b.txt`, 'nested\n');
      await add(ctx, ['sub/b.txt']);
      await commit(ctx, { message: 'add nested', author });

      // Act
      const sut = await show(ctx);

      // Assert
      if (sut.kind !== 'commit') throw new Error('expected commit');
      expect(sut.patch?.changes).toEqual([
        expect.objectContaining({ type: 'add', newPath: 'sub/b.txt' }),
      ]);
    });
  });

  describe('Given withStat, When show() runs on a commit', () => {
    it('Then the patch changes carry per-file line counts', async () => {
      // Arrange
      const ctx = await seedTwoCommits();

      // Act — line 3 changed in a 5-line file: one added, one deleted.
      const sut = await show(ctx, 'HEAD', { withStat: true });

      // Assert
      if (sut.kind !== 'commit' || sut.patch === undefined) {
        throw new Error('expected a commit with a patch');
      }
      expect(sut.patch.changes[0]).toMatchObject({ added: 1, deleted: 1, binary: false });
    });
  });

  describe('Given withStat omitted, When show() runs on a commit', () => {
    it('Then the patch changes carry no count fields', async () => {
      // Arrange
      const ctx = await seedTwoCommits();

      // Act
      const sut = await show(ctx, 'HEAD');

      // Assert
      if (sut.kind !== 'commit' || sut.patch === undefined) {
        throw new Error('expected a commit with a patch');
      }
      expect(sut.patch.changes[0]).not.toHaveProperty('added');
    });
  });

  describe('Given a tree-ish rev, When show() runs', () => {
    it('Then it returns the tree entries', async () => {
      // Arrange
      const ctx = await seedTwoCommits();

      // Act
      const sut = await show(ctx, 'HEAD^{tree}');

      // Assert
      expect(sut.kind).toBe('tree');
      if (sut.kind !== 'tree') throw new Error('expected tree');
      expect(sut.entries.map((e) => e.name)).toContain('a.txt');
    });
  });

  describe('Given the same tree listed twice, When show() runs', () => {
    it('Then both results are returned (no commit-style de-duplication)', async () => {
      // Arrange
      const ctx = await seedTwoCommits();
      const tree = await revParse(ctx, 'HEAD^{tree}');

      // Act
      const sut = await show(ctx, [tree, tree]);

      // Assert — structured output returns one result per input rev, in order.
      expect(sut).toHaveLength(2);
      expect(sut.every((r) => r.kind === 'tree')).toBe(true);
    });
  });

  describe('Given a blob rev, When show() runs', () => {
    it('Then the raw blob content is returned', async () => {
      // Arrange
      const ctx = await seedTwoCommits();
      const tree = await readObject(ctx, await revParse(ctx, 'HEAD^{tree}'));
      if (tree.type !== 'tree') throw new Error('expected tree');
      const blobId = tree.entries.find((e) => e.name === 'a.txt')?.id;
      if (blobId === undefined) throw new Error('a.txt missing');

      // Act
      const sut = await show(ctx, blobId);

      // Assert
      expect(sut.kind).toBe('blob');
      if (sut.kind !== 'blob') throw new Error('expected blob');
      expect(decode(sut.content)).toBe('l1\nl2\nL3\nl4\nl5\n');
    });
  });

  describe('Given an annotated tag, When show() runs', () => {
    it('Then the tag data plus the recursed target commit are returned', async () => {
      // Arrange
      const ctx = await seedTwoCommits();
      const head = await revParse(ctx, 'HEAD');
      const tagId = await writeAnnotatedTag(ctx, head);
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/tags/v1.0`, `${tagId}\n`);

      // Act
      const sut = await show(ctx, 'v1.0');

      // Assert
      expect(sut.kind).toBe('tag');
      if (sut.kind !== 'tag') throw new Error('expected tag');
      expect(sut.id).toBe(tagId);
      expect(sut.tag.tagName).toBe('v1.0');
      expect(sut.target.kind).toBe('commit');
      expect(sut.target.id).toBe(head);
    });
  });

  describe('Given a merge commit, When show() runs', () => {
    it('Then one diff per parent is returned and no single patch', async () => {
      // Arrange
      const ctx = await seedTwoCommits();
      const head = await revParse(ctx, 'HEAD');
      const root = await revParse(ctx, 'HEAD~1');
      const headData = await readObject(ctx, head);
      if (headData.type !== 'commit') throw new Error('expected commit');
      const mergeId = await writeObject(ctx, {
        type: 'commit',
        id: '' as ObjectId,
        data: {
          tree: headData.data.tree,
          parents: [head, root],
          author,
          committer: author,
          message: 'merge feature',
          extraHeaders: [],
        },
      });

      // Act
      const sut = await show(ctx, mergeId);

      // Assert
      if (sut.kind !== 'commit') throw new Error('expected commit');
      expect(sut.patch).toBeUndefined();
      expect(sut.perParent).toHaveLength(2);
      // Merge tree == head's tree: diff vs head is empty; diff vs root carries the change.
      expect(sut.perParent?.[0]?.changes).toEqual([]);
      expect(sut.perParent?.[1]?.changes).toEqual([
        expect.objectContaining({ type: 'modify', path: 'a.txt' }),
      ]);
    });
  });

  describe('Given multiple revs, When show() runs', () => {
    it('Then one result per rev is returned in order', async () => {
      // Arrange
      const ctx = await seedTwoCommits();
      const head = await revParse(ctx, 'HEAD');
      const root = await revParse(ctx, 'HEAD~1');

      // Act
      const sut = await show(ctx, [head, root]);

      // Assert
      expect(sut).toHaveLength(2);
      expect(sut[0]?.id).toBe(head);
      expect(sut[1]?.id).toBe(root);
    });
  });

  describe('Given an empty rev list, When show() runs', () => {
    it('Then an empty array is returned', async () => {
      // Arrange
      const ctx = await seedTwoCommits();

      // Act
      const sut = await show(ctx, []);

      // Assert
      expect(sut).toEqual([]);
    });
  });

  describe('Given an unresolvable rev, When show() runs', () => {
    it('Then it propagates the resolution error', async () => {
      // Arrange
      const ctx = await seedTwoCommits();

      // Act
      let caught: unknown;
      try {
        await show(ctx, 'no-such-rev');
      } catch (err) {
        caught = err;
      }

      // Assert
      expect(caught).toBeInstanceOf(Error);
      expect((caught as { data?: { code?: string } }).data?.code).toBe('OBJECT_NOT_FOUND');
    });
  });
});
