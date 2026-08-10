import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { add } from '../../../../src/application/commands/add.js';
import { commit } from '../../../../src/application/commands/commit.js';
import { init } from '../../../../src/application/commands/init.js';
import { revList } from '../../../../src/application/commands/rev-list.js';
import { TsgitError } from '../../../../src/domain/index.js';
import type { AuthorIdentity, ObjectId } from '../../../../src/domain/objects/index.js';
import type { Context } from '../../../../src/ports/context.js';

const AUTHOR: AuthorIdentity = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};

interface SeededRepo {
  readonly ctx: Context;
  readonly commitIds: ReadonlyArray<ObjectId>;
}

/** Three commits on `main`, each adding one distinct file. */
const seedThree = async (): Promise<SeededRepo> => {
  const ctx = createMemoryContext();
  await init(ctx);
  const commitIds: ObjectId[] = [];
  for (const [path, content, message] of [
    ['a.txt', 'a', 'first'],
    ['b.txt', 'b', 'second'],
    ['c.txt', 'c', 'third'],
  ] as const) {
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/${path}`, content);
    await add(ctx, [path]);
    const result = await commit(ctx, { message, author: AUTHOR });
    commitIds.push(result.id);
  }
  return { ctx, commitIds };
};

describe('revList', () => {
  describe('Given a repository with three commits', () => {
    describe('When revList is called with no options', () => {
      it('Then wants defaults to HEAD and count equals entries.length on the same call', async () => {
        // Arrange
        const { ctx, commitIds } = await seedThree();
        const sut = revList;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(new Set(result.entries.map((e) => e.id))).toEqual(new Set(commitIds));
        expect(result.entries.every((e) => e.type === 'commit')).toBe(true);
        expect(result.count).toBe(result.entries.length);
        expect(result.count).toBe(3);
      });
    });
  });

  describe('Given the same repository', () => {
    describe('When revList is called with objects: true', () => {
      it('Then count moves with objects (commits, trees, and blobs are all counted)', async () => {
        // Arrange
        const { ctx } = await seedThree();
        const sut = revList;

        // Act
        const withoutObjects = await sut(ctx, { objects: false });
        const withObjects = await sut(ctx, { objects: true });

        // Assert
        expect(withoutObjects.count).toBe(3);
        expect(withObjects.count).toBeGreaterThan(withoutObjects.count);
        expect(withObjects.count).toBe(withObjects.entries.length);
        expect(withObjects.entries.some((e) => e.type === 'tree')).toBe(true);
        expect(withObjects.entries.some((e) => e.type === 'blob')).toBe(true);
      });
    });
  });

  describe('Given a repository with three commits', () => {
    describe('When revList is called with wants: ["HEAD~2"]', () => {
      it('Then it resolves through the full revision grammar to the root commit alone', async () => {
        // Arrange
        const { ctx, commitIds } = await seedThree();
        const sut = revList;

        // Act
        const result = await sut(ctx, { wants: ['HEAD~2'] });

        // Assert — HEAD~2 from the third commit is the first (parentless) commit.
        expect(result.entries).toEqual([{ id: commitIds[0], type: 'commit', path: undefined }]);
      });
    });
  });

  describe('Given a repository with three commits', () => {
    describe('When revList is called with an oid prefix as a want', () => {
      it('Then it resolves through revParse to the same closure as the full oid', async () => {
        // Arrange
        const { ctx, commitIds } = await seedThree();
        const tip = commitIds[2] as ObjectId;
        const prefix = tip.slice(0, 7);
        const sut = revList;

        // Act
        const result = await sut(ctx, { wants: [prefix] });

        // Assert
        expect(new Set(result.entries.map((e) => e.id))).toEqual(new Set(commitIds));
      });
    });
  });

  describe('Given a repository with a tag ref pointing at the tip', () => {
    describe('When revList is called with the tag name as a want', () => {
      it('Then it resolves through revParse via the tag ref to the tip alone', async () => {
        // Arrange — HEAD~1 as `not` isolates the resolution to the tag's own
        // commit, proving the tag ref (not HEAD) drove the walk's seed.
        const { ctx, commitIds } = await seedThree();
        const tip = commitIds[2] as ObjectId;
        const middle = commitIds[1] as ObjectId;
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/tags/v1`, `${tip}\n`);
        const sut = revList;

        // Act
        const result = await sut(ctx, { wants: ['v1'], not: [middle] });

        // Assert
        expect(result.entries).toEqual([{ id: tip, type: 'commit', path: undefined }]);
      });
    });
  });

  describe('Given a repository with three commits', () => {
    describe('When revList is called with not excluding the root commit', () => {
      it('Then the excluded commit is absent from the entries', async () => {
        // Arrange
        const { ctx, commitIds } = await seedThree();
        const sut = revList;

        // Act
        const result = await sut(ctx, { wants: ['HEAD'], not: [commitIds[0] as ObjectId] });

        // Assert
        const ids = new Set(result.entries.map((e) => e.id));
        expect(ids.has(commitIds[0] as ObjectId)).toBe(false);
        expect(ids.has(commitIds[1] as ObjectId)).toBe(true);
        expect(ids.has(commitIds[2] as ObjectId)).toBe(true);
      });
    });
  });

  describe('Given a context that is not a repository', () => {
    describe('When revList is called', () => {
      it('Then it throws NOT_A_REPOSITORY', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const sut = revList;

        // Act
        let caught: unknown;
        try {
          await sut(ctx);
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as TsgitError).data.code).toBe('NOT_A_REPOSITORY');
      });
    });
  });
});
