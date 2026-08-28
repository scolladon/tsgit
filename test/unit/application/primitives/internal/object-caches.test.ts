import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import {
  forgetParsedObjectMemo,
  parsedObjectByteSize,
  parsedObjectMemoFor,
  probeDeltaBaseCache,
} from '../../../../../src/application/primitives/internal/object-caches.js';
import {
  createPackRegistry,
  deltaBaseCacheKey,
} from '../../../../../src/application/primitives/pack-registry.js';
import { TsgitError } from '../../../../../src/domain/error.js';
import type { Commit, ObjectId } from '../../../../../src/domain/objects/index.js';
import { PACK_ENTRY_TYPE } from '../../../../../src/domain/storage/index.js';

const OID = 'a'.repeat(40) as ObjectId;

describe('forgetParsedObjectMemo', () => {
  describe('Given a parsed-object memo populated for a session', () => {
    describe('When forgetParsedObjectMemo is called for that id', () => {
      it('Then the memo no longer serves it', () => {
        // Arrange
        const ctx = createMemoryContext();
        const memo = parsedObjectMemoFor(ctx);
        const commit = { type: 'commit' } as unknown as Commit;
        memo?.set(OID, commit, 300);

        // Act
        forgetParsedObjectMemo(ctx, OID);

        // Assert
        expect(memo?.has(OID)).toBe(false);
      });
    });
  });
});

describe('parsedObjectByteSize', () => {
  describe('Given data with one extra header', () => {
    describe('When parsedObjectByteSize is called', () => {
      it("Then the size includes the header's key length PLUS its value length", () => {
        // Arrange
        const data = {
          message: 'msg',
          extraHeaders: [{ key: 'encoding', value: 'ISO-8859-1' }],
        };

        // Act
        const size = parsedObjectByteSize(data, 40);

        // Assert — message(3) + key(8) + value(10) + fixed overhead(256)
        expect(size).toBe(3 + 8 + 10 + 256);
      });
    });
  });
});

describe('probeDeltaBaseCache', () => {
  describe('Given a Context with caching disabled (zero deltaCache budget) sharing a registry populated by an enabled Context', () => {
    describe('When probeDeltaBaseCache is called on the disabled Context', () => {
      it('Then it returns undefined without reading the shared cache entry', () => {
        // Arrange
        const enabledCtx = createMemoryContext();
        const registry = createPackRegistry(enabledCtx);
        const key = deltaBaseCacheKey('pack-a', 10);
        registry.deltaBaseCache.set(
          key,
          { type: PACK_ENTRY_TYPE.BLOB, content: new Uint8Array(5), chainDepth: 0 },
          205,
        );
        const disabledCtx = {
          ...enabledCtx,
          deltaCache: { ...enabledCtx.deltaCache, maxSize: 0 },
        };

        // Act
        const result = probeDeltaBaseCache(disabledCtx, registry, key, OID, undefined);

        // Assert
        expect(result).toBeUndefined();
      });
    });
  });

  describe('Given a cached delta-base entry whose content exceeds maxBytes', () => {
    describe('When probeDeltaBaseCache is called with that cap', () => {
      it('Then it throws OBJECT_TOO_LARGE — the cap applies to cache hits, not only fresh reads', () => {
        // Arrange
        const ctx = createMemoryContext();
        const registry = createPackRegistry(ctx);
        const key = deltaBaseCacheKey('pack-a', 10);
        const content = new Uint8Array(50);
        registry.deltaBaseCache.set(
          key,
          { type: PACK_ENTRY_TYPE.BLOB, content, chainDepth: 0 },
          250,
        );

        // Act
        let caught: unknown;
        try {
          probeDeltaBaseCache(ctx, registry, key, OID, 10);
        } catch (e) {
          caught = e;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as TsgitError).data).toEqual({
          code: 'OBJECT_TOO_LARGE',
          id: OID,
          actualSize: 50,
          limit: 10,
        });
      });
    });
  });
});
