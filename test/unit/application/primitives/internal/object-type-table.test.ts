import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import {
  assignObjectType,
  createObjectTypeTable,
  parseTypedObjectOrAbsent,
} from '../../../../../src/application/primitives/internal/object-type-table.js';
import * as readObjectModule from '../../../../../src/application/primitives/read-object.js';
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

    describe('When the same table types it a blob again', () => {
      it('Then it agrees without writing the table', () => {
        // Arrange
        const { ctx, logged } = logging();
        const table = createObjectTypeTable();
        const sut = assignObjectType;
        sut(ctx, table, ID, 'blob');
        const writes = vi.spyOn(table, 'set');

        // Act
        const result = sut(ctx, table, ID, 'blob');

        // Assert
        expect({ result, logged, writes: writes.mock.calls.length }).toEqual({
          result: true,
          logged: [],
          writes: 0,
        });
        expect(table.get(ID)).toBe('blob');
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

describe('parseTypedObjectOrAbsent', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Given an absent object', () => {
    describe('When it is parsed', () => {
      it('Then it answers undefined, logging nothing', async () => {
        // Arrange
        const { ctx, logged } = logging();
        const sut = parseTypedObjectOrAbsent;

        // Act
        const result = await sut(ctx, createObjectTypeTable(), ID);

        // Assert
        expect({ result, logged }).toEqual({ result: undefined, logged: [] });
      });
    });
  });

  describe('Given a read that fails other than on an absent object', () => {
    describe('When it is parsed', () => {
      it('Then the fault propagates', async () => {
        // Arrange
        const { ctx } = logging();
        const fault = new Error('unexpected');
        vi.spyOn(readObjectModule, 'readObject').mockRejectedValue(fault);
        const sut = parseTypedObjectOrAbsent;

        // Act
        const caught = await sut(ctx, createObjectTypeTable(), ID).then(
          () => undefined,
          (error: unknown) => error,
        );

        // Assert
        expect(caught).toBe(fault);
      });
    });
  });
});
