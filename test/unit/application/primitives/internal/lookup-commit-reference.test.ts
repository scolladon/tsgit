import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import { init } from '../../../../../src/application/commands/init.js';
import { lookupTypedCommitReferenceQuietly } from '../../../../../src/application/primitives/internal/lookup-commit-reference.js';
import { createObjectTypeTable } from '../../../../../src/application/primitives/internal/object-type-table.js';
import { writeObject } from '../../../../../src/application/primitives/write-object.js';
import type { AuthorIdentity, ObjectId } from '../../../../../src/domain/objects/index.js';
import type { Context } from '../../../../../src/ports/context.js';

const author: AuthorIdentity = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};

const ABSENT = 'b'.repeat(40) as ObjectId;

const logging = async (): Promise<{ readonly ctx: Context; readonly logged: string[] }> => {
  const logged: string[] = [];
  const ctx: Context = {
    ...createMemoryContext(),
    logger: { error: (message: string) => logged.push(message) },
  };
  await init(ctx);
  return { ctx, logged };
};

const writeEmptyTree = (ctx: Context): Promise<ObjectId> =>
  writeObject(ctx, { type: 'tree', id: '' as ObjectId, entries: [] });

const writeCommitOn = (ctx: Context, tree: ObjectId): Promise<ObjectId> =>
  writeObject(ctx, {
    type: 'commit',
    id: '' as ObjectId,
    data: { tree, parents: [], author, committer: author, message: 'c', extraHeaders: [] },
  });

describe('lookupTypedCommitReferenceQuietly', () => {
  describe('Given an id naming a tree', () => {
    describe('When it is looked up quietly', () => {
      it('Then it names no commit and logs nothing', async () => {
        // Arrange
        const { ctx, logged } = await logging();
        const tree = await writeEmptyTree(ctx);
        const sut = lookupTypedCommitReferenceQuietly;

        // Act
        const result = await sut(ctx, createObjectTypeTable(), tree);

        // Assert
        expect({ result, logged }).toEqual({ result: undefined, logged: [] });
      });
    });
  });

  describe('Given an id naming no stored object', () => {
    describe('When it is looked up quietly', () => {
      it('Then it names no commit and logs nothing', async () => {
        // Arrange
        const { ctx, logged } = await logging();
        const sut = lookupTypedCommitReferenceQuietly;

        // Act
        const result = await sut(ctx, createObjectTypeTable(), ABSENT);

        // Assert
        expect({ result, logged }).toEqual({ result: undefined, logged: [] });
      });
    });
  });

  describe('Given a commit', () => {
    describe('When it is looked up quietly into a fresh table', () => {
      it('Then it names that commit', async () => {
        // Arrange
        const { ctx, logged } = await logging();
        const commit = await writeCommitOn(ctx, await writeEmptyTree(ctx));
        const sut = lookupTypedCommitReferenceQuietly;

        // Act
        const result = await sut(ctx, createObjectTypeTable(), commit);

        // Assert
        expect({ result, logged }).toEqual({ result: commit, logged: [] });
      });
    });

    describe('When the table already typed its tree a commit', () => {
      it('Then the parse fails and logs its own lines, quiet or not', async () => {
        // Arrange
        const { ctx, logged } = await logging();
        const tree = await writeEmptyTree(ctx);
        const commit = await writeCommitOn(ctx, tree);
        const table = createObjectTypeTable();
        table.set(tree, 'commit');
        const sut = lookupTypedCommitReferenceQuietly;

        // Act
        const result = await sut(ctx, table, commit);

        // Assert
        expect({ result, logged }).toEqual({
          result: undefined,
          logged: [
            `object ${tree} is a commit, not a tree`,
            `bad tree pointer ${tree} in commit ${commit}`,
          ],
        });
      });
    });
  });
});
