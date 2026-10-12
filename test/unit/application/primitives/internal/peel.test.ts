import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import { init } from '../../../../../src/application/commands/init.js';
import { createObjectTypeTable } from '../../../../../src/application/primitives/internal/object-type-table.js';
import { peel } from '../../../../../src/application/primitives/internal/peel.js';
import { writeObject } from '../../../../../src/application/primitives/write-object.js';
import type { TsgitError } from '../../../../../src/domain/error.js';
import type { ObjectId } from '../../../../../src/domain/objects/index.js';
import type { Context } from '../../../../../src/ports/context.js';
import { writeForgedTagLoop } from '../fixtures.js';

interface Logging {
  readonly ctx: Context;
  readonly logged: string[];
  readonly contexts: unknown[];
}

const logging = async (): Promise<Logging> => {
  const logged: string[] = [];
  const contexts: unknown[] = [];
  const ctx: Context = {
    ...createMemoryContext(),
    logger: {
      error: (message: string, context?: Readonly<Record<string, unknown>>) => {
        logged.push(message);
        contexts.push(context);
      },
    },
  };
  await init(ctx);
  return { ctx, logged, contexts };
};

const caught = async (run: () => Promise<unknown>): Promise<TsgitError['data'] | undefined> => {
  try {
    await run();
  } catch (error) {
    return (error as TsgitError).data;
  }
  return undefined;
};

describe('peel', () => {
  describe('Given a blob and a named peel to a commit', () => {
    describe('When it is peeled', () => {
      it('Then it logs the name, the wanted kind and the kind reached, and refuses', async () => {
        // Arrange
        const { ctx, logged, contexts } = await logging();
        const blob = await writeObject(ctx, {
          type: 'blob',
          id: '' as ObjectId,
          content: new TextEncoder().encode('a\n'),
        });
        const sut = peel;

        // Act
        const result = await caught(() =>
          sut(ctx, createObjectTypeTable(), blob, 'commit', 'rev^{commit}'),
        );

        // Assert
        expect({ result, logged, contexts }).toEqual({
          result: { code: 'OBJECT_NOT_FOUND', id: blob },
          logged: ['rev^{commit}: expected commit type, but the object dereferences to blob type'],
          contexts: [{ name: 'rev^{commit}', expected: 'commit', type: 'blob' }],
        });
      });
    });
  });

  describe('Given a forged tag naming itself and a named peel to a commit', () => {
    describe('When it is peeled', () => {
      it('Then it refuses without reporting a kind mismatch', async () => {
        // Arrange
        const { ctx, logged } = await logging();
        const loop = await writeForgedTagLoop(ctx);
        const sut = peel;

        // Act
        const result = await caught(() =>
          sut(ctx, createObjectTypeTable(), loop, 'commit', 'loop^{commit}'),
        );

        // Assert
        expect({ result, logged }).toEqual({
          result: { code: 'OBJECT_NOT_FOUND', id: loop },
          logged: [],
        });
      });
    });
  });
});
