import { describe, expect, it } from 'vitest';
import { hasObject } from '../../../../src/application/primitives/has-object.js';
import type { Blob, ObjectId } from '../../../../src/domain/objects/index.js';
import { serializeObject } from '../../../../src/domain/objects/index.js';
import type { Context } from '../../../../src/ports/context.js';
import type { PromisorRemote } from '../../../../src/ports/promisor.js';
import { buildSeededContext } from './fixtures.js';
import { writeSyntheticPack } from './pack-fixture.js';

describe('hasObject', () => {
  describe('Given an object present only as a loose file', () => {
    describe('When probing hasObject', () => {
      it('Then it returns true', async () => {
        // Arrange
        const blob: Blob = { type: 'blob', content: new Uint8Array([1, 2, 3]), id: '' as ObjectId };
        const ctx = await buildSeededContext({ objects: [blob] });
        const id = (await ctx.hash.hashHex(serializeObject(blob, ctx.hashConfig))) as ObjectId;

        // Act
        const result = await hasObject(ctx, id);

        // Assert
        expect(result).toBe(true);
      });
    });
  });

  describe('Given an object present only in a pack', () => {
    describe('When probing hasObject', () => {
      it('Then it returns true', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const content = new TextEncoder().encode('packed content\n');
        const [id] = await writeSyntheticPack(ctx, 'has-object-pack', [
          { kind: 'base', type: 'blob', content },
        ]);

        // Act
        const result = await hasObject(ctx, id as ObjectId);

        // Assert
        expect(result).toBe(true);
      });
    });
  });

  describe('Given an object absent from loose and packs', () => {
    describe('When probing hasObject', () => {
      it('Then it returns false', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const missingId = 'f'.repeat(40) as ObjectId;

        // Act
        const result = await hasObject(ctx, missingId);

        // Assert
        expect(result).toBe(false);
      });
    });
  });

  describe('Given a partial repo with a promisor remote and an absent object', () => {
    describe('When probing hasObject', () => {
      it('Then it returns false without invoking the promisor', async () => {
        // Arrange
        const base = await buildSeededContext();
        const calls = { count: 0 };
        const promisor: PromisorRemote = {
          fetch: async (oids) => {
            calls.count += 1;
            return { attempted: true, requested: oids.length, fetched: 0 };
          },
        };
        const ctx: Context = { ...base, promisor };
        const missingId = 'e'.repeat(40) as ObjectId;

        // Act
        const result = await hasObject(ctx, missingId);

        // Assert
        expect(result).toBe(false);
        expect(calls.count).toBe(0);
      });
    });
  });
});
