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
    it('Then it renders the HEAD commit with its patch', async () => {
      // Arrange
      const ctx = await seedTwoCommits();
      const head = await revParse(ctx, 'HEAD');

      // Act
      const sut = await show(ctx);

      // Assert
      expect(sut.objects).toHaveLength(1);
      const result = sut.objects[0]!;
      expect(result.kind).toBe('commit');
      if (result.kind !== 'commit') throw new Error('expected commit');
      expect(result.id).toBe(head);
      expect(result.commit.message).toBe('second\n');
      expect(result.patch?.text).toContain('diff --git a/a.txt b/a.txt');
      expect(result.text.startsWith(`commit ${head}\n`)).toBe(true);
      expect(decode(sut.bytes)).toBe(result.text);
    });
  });

  describe('Given a root commit, When show() runs on it', () => {
    it('Then the patch is computed against the empty tree', async () => {
      // Arrange
      const ctx = await seedTwoCommits();
      const root = await revParse(ctx, 'HEAD~1');

      // Act
      const sut = await show(ctx, root);

      // Assert
      const result = sut.objects[0]!;
      if (result.kind !== 'commit') throw new Error('expected commit');
      expect(result.patch?.text).toContain('new file mode 100644');
      expect(result.patch?.text).toContain('--- /dev/null');
    });
  });

  describe('Given a tree-ish rev, When show() runs', () => {
    it('Then it lists the tree with the input echoed in the header', async () => {
      // Arrange
      const ctx = await seedTwoCommits();

      // Act
      const sut = await show(ctx, 'HEAD^{tree}');

      // Assert
      const result = sut.objects[0]!;
      expect(result.kind).toBe('tree');
      if (result.kind !== 'tree') throw new Error('expected tree');
      expect(result.text.startsWith('tree HEAD^{tree}\n\n')).toBe(true);
      expect(result.entries.map((e) => e.name)).toContain('a.txt');
    });
  });

  describe('Given a blob rev, When show() runs', () => {
    it('Then the raw blob content is returned', async () => {
      // Arrange
      const ctx = await seedTwoCommits();
      const tree = await readObject(ctx, await revParse(ctx, 'HEAD^{tree}'));
      if (tree.type !== 'tree') throw new Error('expected tree');
      const blobId = tree.entries.find((e) => e.name === 'a.txt')!.id;

      // Act
      const sut = await show(ctx, blobId);

      // Assert
      const result = sut.objects[0]!;
      expect(result.kind).toBe('blob');
      if (result.kind !== 'blob') throw new Error('expected blob');
      expect(decode(result.content)).toBe('l1\nl2\nL3\nl4\nl5\n');
      expect(sut.bytes).toEqual(result.content);
    });
  });

  describe('Given an annotated tag, When show() runs', () => {
    it('Then the tag block plus the recursed target commit are emitted', async () => {
      // Arrange
      const ctx = await seedTwoCommits();
      const head = await revParse(ctx, 'HEAD');
      const tagId = await writeAnnotatedTag(ctx, head);
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/tags/v1.0`, `${tagId}\n`);

      // Act
      const sut = await show(ctx, 'v1.0');

      // Assert
      const result = sut.objects[0]!;
      expect(result.kind).toBe('tag');
      if (result.kind !== 'tag') throw new Error('expected tag');
      expect(result.id).toBe(tagId);
      expect(result.tag.tagName).toBe('v1.0');
      expect(result.target.kind).toBe('commit');
      expect(result.text).toBe(
        'tag v1.0\nTagger: A U Thor <author@example.com>\nDate:   Tue Nov 14 22:13:20 2023 +0000\n\nrelease one\n',
      );
      expect(decode(sut.bytes).startsWith('tag v1.0\n')).toBe(true);
      expect(decode(sut.bytes)).toContain(`\n\ncommit ${head}\n`);
    });
  });

  describe('Given a merge commit, When show() runs', () => {
    it('Then a Merge line is emitted and no patch is computed', async () => {
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
      const result = sut.objects[0]!;
      if (result.kind !== 'commit') throw new Error('expected commit');
      expect(result.patch).toBeUndefined();
      expect(result.text).toContain(`Merge: ${head.slice(0, 7)} ${root.slice(0, 7)}`);
      expect(result.text).not.toContain('diff --git');
    });
  });

  describe('Given multiple revs, When show() runs', () => {
    it('Then one result per rev is returned and bytes are concatenated', async () => {
      // Arrange
      const ctx = await seedTwoCommits();
      const head = await revParse(ctx, 'HEAD');
      const root = await revParse(ctx, 'HEAD~1');

      // Act
      const sut = await show(ctx, [head, root]);

      // Assert
      expect(sut.objects).toHaveLength(2);
      const [first, second] = sut.objects;
      if (first?.kind !== 'commit' || second?.kind !== 'commit') {
        throw new Error('expected commits');
      }
      expect(decode(sut.bytes)).toBe(`${first.text}\n${second.text}`);
    });
  });

  describe('Given contextLines is set, When show() runs on a commit', () => {
    it('Then the patch hunk uses that many context lines', async () => {
      // Arrange
      const ctx = await seedTwoCommits();

      // Act
      const sut = await show(ctx, 'HEAD', { contextLines: 1 });

      // Assert — line 3 changed in a 5-line file; one context line each side ⇒ -2,3 +2,3.
      const result = sut.objects[0]!;
      if (result.kind !== 'commit') throw new Error('expected commit');
      expect(result.patch?.text).toContain('@@ -2,3 +2,3 @@');
    });
  });

  describe('Given an empty rev list, When show() runs', () => {
    it('Then no objects and empty bytes are returned', async () => {
      // Arrange
      const ctx = await seedTwoCommits();

      // Act
      const sut = await show(ctx, []);

      // Assert
      expect(sut.objects).toHaveLength(0);
      expect(sut.bytes).toEqual(new Uint8Array(0));
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
