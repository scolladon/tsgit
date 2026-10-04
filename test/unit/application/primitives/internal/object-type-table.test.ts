import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import {
  assignObjectType,
  createObjectTypeTable,
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

describe('assignObjectType', () => {
  describe('Given an id typed a blob in a table', () => {
    describe('When the same table types it a commit', () => {
      it('Then the typing conflicts', () => {
        // Arrange
        const { ctx, logged } = logging();
        const table = createObjectTypeTable();
        const sut = assignObjectType;
        sut(ctx, table, ID, 'blob');

        // Act
        const result = sut(ctx, table, ID, 'commit');

        // Assert
        expect({ result, logged }).toEqual({
          result: false,
          logged: [`object ${ID} is a blob, not a commit`],
        });
      });
    });

    describe('When another table types it a commit', () => {
      it('Then the earlier typing does not carry over', () => {
        // Arrange
        const { ctx, logged } = logging();
        const sut = assignObjectType;
        sut(ctx, createObjectTypeTable(), ID, 'blob');

        // Act
        const result = sut(ctx, createObjectTypeTable(), ID, 'commit');

        // Assert
        expect({ result, logged }).toEqual({ result: true, logged: [] });
      });
    });
  });

  describe('Given no table', () => {
    describe('When an id is typed twice differently', () => {
      it('Then nothing conflicts', () => {
        // Arrange
        const { ctx, logged } = logging();
        const sut = assignObjectType;
        sut(ctx, undefined, ID, 'blob');

        // Act
        const result = sut(ctx, undefined, ID, 'commit');

        // Assert
        expect({ result, logged }).toEqual({ result: true, logged: [] });
      });
    });
  });
});
