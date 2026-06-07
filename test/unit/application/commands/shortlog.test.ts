import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { add } from '../../../../src/application/commands/add.js';
import { commit } from '../../../../src/application/commands/commit.js';
import { init } from '../../../../src/application/commands/init.js';
import { shortlog } from '../../../../src/application/commands/shortlog.js';
import type { AuthorIdentity } from '../../../../src/domain/objects/index.js';
import type { Context } from '../../../../src/ports/context.js';

const ident = (name: string, ts: number, email = `${name}@x`): AuthorIdentity => ({
  name,
  email,
  timestamp: ts,
  timezoneOffset: '+0000',
});

const makeCommit = async (
  ctx: Context,
  path: string,
  message: string,
  author: AuthorIdentity,
  committer?: AuthorIdentity,
): Promise<string> => {
  await ctx.fs.writeUtf8(`${ctx.layout.workDir}/${path}`, path);
  await add(ctx, [path]);
  const result =
    committer === undefined
      ? await commit(ctx, { message, author })
      : await commit(ctx, { message, author, committer });
  return result.id;
};

describe('shortlog', () => {
  describe('Given commits by two authors, When shortlog runs with defaults', () => {
    it('Then groups are byte-sorted by name with oldest-first cleaned subjects', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await init(ctx);
      await makeCommit(ctx, 'f1', 'b-old', ident('Bob', 1000));
      await makeCommit(ctx, 'f2', '[PATCH] a-mid', ident('Ann', 2000));
      await makeCommit(ctx, 'f3', 'b-new', ident('Bob', 3000));
      const sut = shortlog;

      // Act
      const result = await sut(ctx);

      // Assert
      expect(result.map((g) => g.name)).toEqual(['Ann', 'Bob']);
      expect(result[0]?.commits.map((c) => c.subject)).toEqual(['a-mid']);
      expect(result[1]?.commits.map((c) => c.subject)).toEqual(['b-old', 'b-new']);
    });
  });

  describe('Given one author with two emails, When shortlog runs with defaults', () => {
    it('Then they merge into one name-group, each commit keeping its email', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await init(ctx);
      await makeCommit(ctx, 'f1', 's1', ident('Ann', 1000, 'ann@first'));
      await makeCommit(ctx, 'f2', 's2', ident('Ann', 2000, 'ann@second'));
      const sut = shortlog;

      // Act
      const result = await sut(ctx);

      // Assert
      expect(result).toHaveLength(1);
      expect(result[0]?.commits.map((c) => c.email)).toEqual(['ann@first', 'ann@second']);
    });
  });

  describe('Given an author distinct from the committer, When shortlog groups by committer', () => {
    it('Then the committer identity keys the group', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await init(ctx);
      await makeCommit(ctx, 'f1', 'm', ident('TheAuthor', 1000), ident('TheCommitter', 1000));
      const sut = shortlog;

      // Act
      const byAuthor = await sut(ctx);
      const byCommitter = await sut(ctx, { by: 'committer' });

      // Assert
      expect(byAuthor.map((g) => g.name)).toEqual(['TheAuthor']);
      expect(byCommitter.map((g) => g.name)).toEqual(['TheCommitter']);
    });
  });

  describe('Given a linear history, When shortlog excludes the first commit', () => {
    it('Then only commits outside the excluded range are summarised', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await init(ctx);
      const first = await makeCommit(ctx, 'f1', 'one', ident('Ann', 1000));
      await makeCommit(ctx, 'f2', 'two', ident('Ann', 2000));
      const sut = shortlog;

      // Act
      const result = await sut(ctx, { excluding: [first] });

      // Assert
      expect(result).toHaveLength(1);
      expect(result[0]?.commits.map((c) => c.subject)).toEqual(['two']);
    });
  });

  describe('Given a history, When shortlog starts from an explicit rev', () => {
    it('Then only commits reachable from that rev are summarised', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await init(ctx);
      await makeCommit(ctx, 'f1', 'one', ident('Ann', 1000));
      const second = await makeCommit(ctx, 'f2', 'two', ident('Ann', 2000));
      await makeCommit(ctx, 'f3', 'three', ident('Ann', 3000));
      const sut = shortlog;

      // Act
      const result = await sut(ctx, { rev: second });

      // Assert
      expect(result[0]?.commits.map((c) => c.subject)).toEqual(['one', 'two']);
    });
  });

  describe('Given an unborn branch, When shortlog runs', () => {
    it('Then it throws OBJECT_NOT_FOUND', async () => {
      // Arrange — seed a commit so the ref exists, then wipe it to simulate the
      // unborn-branch state (HEAD points at a ref that no longer resolves).
      const ctx = createMemoryContext();
      await init(ctx);
      await makeCommit(ctx, 'f1', 'one', ident('Ann', 1000));
      await ctx.fs.rm(`${ctx.layout.gitDir}/refs/heads/main`);
      const sut = shortlog;

      // Act
      let caught: unknown;
      try {
        await sut(ctx);
      } catch (err) {
        caught = err;
      }

      // Assert
      expect(caught).toBeInstanceOf(Error);
      expect((caught as { data?: { code?: string } }).data?.code).toBe('OBJECT_NOT_FOUND');
    });
  });

  describe('Given an unresolvable rev, When shortlog runs', () => {
    it('Then it throws OBJECT_NOT_FOUND', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await init(ctx);
      await makeCommit(ctx, 'f1', 'one', ident('Ann', 1000));
      const sut = shortlog;

      // Act
      let caught: unknown;
      try {
        await sut(ctx, { rev: 'no-such-rev' });
      } catch (err) {
        caught = err;
      }

      // Assert
      expect(caught).toBeInstanceOf(Error);
      expect((caught as { data?: { code?: string } }).data?.code).toBe('OBJECT_NOT_FOUND');
    });
  });
});
