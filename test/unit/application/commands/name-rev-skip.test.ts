import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { add } from '../../../../src/application/commands/add.js';
import { commit } from '../../../../src/application/commands/commit.js';
import { describe as describeCommand } from '../../../../src/application/commands/describe.js';
import { init } from '../../../../src/application/commands/init.js';
import { nameRev } from '../../../../src/application/commands/name-rev.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import type { AuthorIdentity, ObjectId } from '../../../../src/domain/objects/index.js';
import type { Context } from '../../../../src/ports/context.js';

const ident: AuthorIdentity = {
  name: 'A U Thor',
  email: 'author@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};

/** Two blob contents whose ids share the abbreviation `abcd`. */
const SHARING_ABCD = ['x20507\n', 'x115828\n'];
const encoder = new TextEncoder();

interface Seeded {
  readonly ctx: Context;
  readonly logs: string[];
  readonly tip: ObjectId;
}

const seed = async (): Promise<Seeded> => {
  const logs: string[] = [];
  const base = createMemoryContext();
  const ctx = {
    ...base,
    logger: {
      info: (message: string) => logs.push(message),
      error: (message: string) => logs.push(`error: ${message}`),
    },
  } as Context;
  await init(ctx);
  await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'a\n');
  await add(ctx, ['a.txt']);
  const result = await commit(ctx, { message: 'a', author: ident, committer: ident });
  return { ctx, logs, tip: result.id };
};

describe('Given a revision that names no object', () => {
  describe.each(['nope', 'nope~1', 'HEAD:absent', 'HEAD^{tree}^{commit}'])(
    'When nameRev reads %s',
    (rev) => {
      it('Then it skips the argument with the note git prints instead of refusing', async () => {
        // Arrange
        const { ctx, logs } = await seed();
        const sut = nameRev;

        // Act
        const result = await sut(ctx, rev);

        // Assert
        expect(result).toBeUndefined();
        expect(logs.at(-1)).toBe(`Could not get sha1 for ${rev}. Skipping.`);
      });
    },
  );
});

describe('Given a full object id naming no object', () => {
  describe('When nameRev reads it', () => {
    it('Then it skips the argument as git does for an object it cannot parse', async () => {
      // Arrange
      const { ctx, logs } = await seed();
      const missing = '0123456789012345678901234567890123456789';
      const sut = nameRev;

      // Act
      const result = await sut(ctx, missing);

      // Assert
      expect(result).toBeUndefined();
      expect(logs).toEqual([`Could not get object for ${missing}. Skipping.`]);
    });
  });
});

describe('Given an abbreviated object id two objects share', () => {
  describe('When nameRev reads it', () => {
    it('Then it reports the ambiguity and skips the argument', async () => {
      // Arrange
      const { ctx, logs } = await seed();
      for (const text of SHARING_ABCD) {
        await writeObject(ctx, { type: 'blob', id: '' as ObjectId, content: encoder.encode(text) });
      }
      const shared = 'abcd';
      const sut = nameRev;

      // Act
      const result = await sut(ctx, shared);

      // Assert
      expect(result).toBeUndefined();
      expect(logs).toEqual([
        `error: short object ID ${shared} is ambiguous`,
        'error: The candidates are:',
        `Could not get sha1 for ${shared}. Skipping.`,
      ]);
    });
  });
});

describe('Given a revision describe --contains cannot read', () => {
  describe('When describe runs with contains', () => {
    it('Then it skips the argument as the name-rev it runs does', async () => {
      // Arrange
      const { ctx, logs } = await seed();
      const sut = describeCommand;

      // Act
      const result = await sut(ctx, 'nope', { contains: true });

      // Assert
      expect(result).toBeUndefined();
      expect(logs).toEqual(['Could not get sha1 for nope. Skipping.']);
    });
  });
});
