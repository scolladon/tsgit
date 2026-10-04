import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import { init } from '../../../../../src/application/commands/init.js';
import { requireReference } from '../../../../../src/application/commands/internal/require-reference.js';
import { writeObject } from '../../../../../src/application/primitives/write-object.js';
import type { TsgitError } from '../../../../../src/domain/index.js';
import type { Blob, ObjectId } from '../../../../../src/domain/objects/index.js';
import { serializeObject } from '../../../../../src/domain/objects/index.js';
import type { Context } from '../../../../../src/ports/context.js';

const BLOB: Blob = { type: 'blob', content: new Uint8Array([7, 8, 9]), id: '' as ObjectId };

const seeded = async (): Promise<{ readonly ctx: Context; readonly id: ObjectId }> => {
  const ctx = createMemoryContext();
  await init(ctx);
  const id = (await ctx.hash.hashHex(serializeObject(BLOB, ctx.hashConfig))) as ObjectId;
  return { ctx, id };
};

const caughtFrom = async (run: () => Promise<unknown>): Promise<unknown> => {
  try {
    await run();
  } catch (error) {
    return error;
  }
  return undefined;
};

describe('requireReference', () => {
  describe('Given a stored object', () => {
    describe('When it is required', () => {
      it('Then it resolves', async () => {
        // Arrange
        const { ctx, id } = await seeded();
        await writeObject(ctx, BLOB);
        const sut = requireReference;

        // Act
        const result = await sut(ctx, 'name', id);

        // Assert
        expect(result).toBeUndefined();
      });
    });
  });

  describe('Given an absent object and no promisor', () => {
    describe('When it is required', () => {
      it('Then it refuses naming the spelling, not the id', async () => {
        // Arrange
        const { ctx, id } = await seeded();
        const sut = requireReference;

        // Act
        const caught = await caughtFrom(() => sut(ctx, 'spelt', id));

        // Assert
        expect((caught as TsgitError).data).toEqual({ code: 'OBJECT_NOT_FOUND', id: 'spelt' });
      });
    });
  });

  describe('Given an absent object a promisor supplies', () => {
    describe('When it is required', () => {
      it('Then it is fetched and resolves', async () => {
        // Arrange
        const { ctx: base, id } = await seeded();
        const fetched: ObjectId[][] = [];
        let ctx!: Context;
        ctx = {
          ...base,
          promisor: {
            fetch: async (oids) => {
              fetched.push([...oids]);
              await writeObject(ctx, BLOB);
              return { attempted: true, requested: oids.length, fetched: oids.length };
            },
          },
        };
        const sut = requireReference;

        // Act
        await sut(ctx, 'spelt', id);

        // Assert
        expect(fetched).toEqual([[id]]);
      });
    });
  });

  describe('Given an absent object whose promisor fetch fails', () => {
    describe('When it is required', () => {
      it('Then the fetch failure propagates', async () => {
        // Arrange
        const { ctx: base, id } = await seeded();
        const failure = new Error('network down');
        const ctx: Context = {
          ...base,
          promisor: {
            fetch: async () => {
              throw failure;
            },
          },
        };
        const sut = requireReference;

        // Act
        const caught = await caughtFrom(() => sut(ctx, 'spelt', id));

        // Assert
        expect(caught).toBe(failure);
      });
    });
  });
});
