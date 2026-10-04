import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import {
  assignObjectType,
  withObjectTypeTable,
} from '../../../../../src/application/primitives/internal/object-type-table.js';
import type { ObjectId } from '../../../../../src/domain/objects/index.js';
import type { Context } from '../../../../../src/ports/context.js';

const ID = 'a'.repeat(40) as ObjectId;

const logging = (): { readonly ctx: Context; readonly logged: string[] } => {
  const logged: string[] = [];
  const ctx: Context = {
    ...createMemoryContext(),
    logger: { error: (message: string) => logged.push(message) },
  };
  return { ctx, logged };
};

describe('withObjectTypeTable', () => {
  describe('Given an id typed a blob inside a scope', () => {
    describe('When a nested scope types it a commit', () => {
      it('Then the nested scope shares the table and the typing conflicts', async () => {
        // Arrange
        const { ctx, logged } = logging();
        const sut = withObjectTypeTable;

        // Act
        const result = await sut(ctx, async () => {
          assignObjectType(ctx, ID, 'blob');
          return sut(ctx, async () => assignObjectType(ctx, ID, 'commit'));
        });

        // Assert
        expect({ result, logged }).toEqual({
          result: false,
          logged: [`object ${ID} is a blob, not a commit`],
        });
      });
    });
  });

  describe('Given a scope that typed an id and then rejected', () => {
    describe('When a later scope types it otherwise', () => {
      it('Then the earlier typing is gone', async () => {
        // Arrange
        const { ctx, logged } = logging();
        const failure = new Error('boom');
        const sut = withObjectTypeTable;
        await sut(ctx, async () => {
          assignObjectType(ctx, ID, 'blob');
          throw failure;
        }).catch((error: unknown) => {
          if (error !== failure) throw error;
        });

        // Act
        const result = await sut(ctx, async () => assignObjectType(ctx, ID, 'commit'));

        // Assert
        expect({ result, logged }).toEqual({ result: true, logged: [] });
      });
    });
  });

  describe('Given no scope', () => {
    describe('When an id is typed twice differently', () => {
      it('Then nothing conflicts', () => {
        // Arrange
        const { ctx, logged } = logging();
        const sut = assignObjectType;
        sut(ctx, ID, 'blob');

        // Act
        const result = sut(ctx, ID, 'commit');

        // Assert
        expect({ result, logged }).toEqual({ result: true, logged: [] });
      });
    });
  });
});
