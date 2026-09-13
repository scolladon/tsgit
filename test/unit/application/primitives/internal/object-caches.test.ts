import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import {
  cacheDeltaBase,
  forgetParsedObjectMemo,
  memoByteValve,
  memoMaxEntries,
  PARSED_OBJECT_TYPICAL_ENTRY_BYTES,
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
      it('Then it returns undefined without reading the shared cache entry', async () => {
        // Arrange
        const enabledCtx = createMemoryContext();
        const registry = await createPackRegistry(enabledCtx);
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
      it('Then it throws OBJECT_TOO_LARGE — the cap applies to cache hits, not only fresh reads', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const registry = await createPackRegistry(ctx);
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

describe('cacheDeltaBase', () => {
  describe('Given a Context with caching enabled', () => {
    describe('When cacheDeltaBase is called with content that fits the cache', () => {
      it('Then it returns true and the entry becomes resident', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const registry = await createPackRegistry(ctx);
        const key = deltaBaseCacheKey('pack-a', 10);
        const content = new Uint8Array(5);

        // Act
        const result = cacheDeltaBase(ctx, registry, key, PACK_ENTRY_TYPE.BLOB, content, 0);

        // Assert
        expect(result).toBe(true);
        expect(registry.deltaBaseCache.has(key)).toBe(true);
      });
    });
  });

  describe('Given content whose entry size exceeds the whole cache budget', () => {
    describe('When cacheDeltaBase is called', () => {
      it("Then it returns false, forwarding LruCache.set's refusal", async () => {
        // Arrange — a 10-byte cache can never admit a 5-byte content entry
        // once the fixed 200-byte overhead is added (205 > 10).
        const ctx = createMemoryContext({ deltaBaseCacheMaxBytes: 10 });
        const registry = await createPackRegistry(ctx);
        const key = deltaBaseCacheKey('pack-a', 10);

        // Act
        const result = cacheDeltaBase(
          ctx,
          registry,
          key,
          PACK_ENTRY_TYPE.BLOB,
          new Uint8Array(5),
          0,
        );

        // Assert
        expect(result).toBe(false);
        expect(registry.deltaBaseCache.has(key)).toBe(false);
      });
    });
  });

  describe('Given a Context with caching disabled (zero deltaCache budget)', () => {
    describe('When cacheDeltaBase is called', () => {
      it('Then it returns false and writes nothing', async () => {
        // Arrange
        const enabledCtx = createMemoryContext();
        const registry = await createPackRegistry(enabledCtx);
        const disabledCtx = {
          ...enabledCtx,
          deltaCache: { ...enabledCtx.deltaCache, maxSize: 0 },
        };
        const key = deltaBaseCacheKey('pack-a', 10);

        // Act
        const result = cacheDeltaBase(
          disabledCtx,
          registry,
          key,
          PACK_ENTRY_TYPE.BLOB,
          new Uint8Array(5),
          0,
        );

        // Assert
        expect(result).toBe(false);
        expect(registry.deltaBaseCache.has(key)).toBe(false);
      });
    });
  });
});

describe('parsedObjectMemoFor — entry-bound sizing', () => {
  describe('Given a 5,000-commit-shaped walk at the default deltaCacheMaxBytes budget', () => {
    describe('When 5,000 distinct commit-shaped entries are inserted', () => {
      it('Then every entry is retained — the byte cap no longer binds first', () => {
        // Arrange
        const ctx = createMemoryContext();
        const memo = parsedObjectMemoFor(ctx);
        const walkLength = 5_000;

        // Act — 256 bytes/entry mirrors a short-message, parentless commit.
        for (let i = 0; i < walkLength; i += 1) {
          memo?.set(`commit-${i}`, {} as never, 256);
        }

        // Assert — the previous 1/16-of-16MiB byte cap (1 MiB) admitted only
        // ~4,096 entries at this size; the new full-valve sizing admits the
        // whole walk.
        expect(memo?.entryCount).toBe(walkLength);
      });
    });
  });

  describe('Given the default deltaCacheMaxBytes budget', () => {
    describe('When resolving the memo entry cap and its byte valve', () => {
      it('Then maxEntries × typicalEntryBytes never exceeds the valve, and a typical entry is admitted', () => {
        // Arrange
        const ctx = createMemoryContext();
        const memo = parsedObjectMemoFor(ctx);
        const cap = memoMaxEntries(ctx);
        const valve = memoByteValve(ctx);

        // Act — a future retune that flips the binding constraint back to a
        // fixed entry cap would fail one of the assertions below instead of
        // shipping a dead cache silently.
        const admitted = memo?.set('typical', {} as never, PARSED_OBJECT_TYPICAL_ENTRY_BYTES);

        // Assert — literal at the default, decoupled from the production formula.
        expect(cap).toBe(32_768);
        expect(valve).toBe(16 * 1024 * 1024);
        expect(cap * PARSED_OBJECT_TYPICAL_ENTRY_BYTES).toBeLessThanOrEqual(valve);
        expect(admitted).toBe(true);
      });
    });
  });

  describe('Given a non-default deltaCacheMaxBytes of 4 MiB', () => {
    describe('When resolving the memo entry cap', () => {
      it('Then the cap derives from the valve — 8,192 entries', () => {
        // Arrange
        const ctx = createMemoryContext({ deltaCacheMaxBytes: 4 * 1024 * 1024 });

        // Act
        const cap = memoMaxEntries(ctx);

        // Assert
        expect(cap).toBe(8_192);
      });
    });
  });
});
