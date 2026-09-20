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

        // Assert — message(3) + key(8) + value(10) + fixed overhead(950)
        expect(size).toBe(3 + 8 + 10 + 950);
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

  describe('Given the default deltaCacheMaxBytes budget, and a commit-shaped entry sized through the REAL sizer', () => {
    describe('When resolving the memo entry cap and its byte valve', () => {
      it.each([
        { label: 'sha1', algorithm: 'sha1' as const, hexLength: 40, valve: 39_518_208 },
        { label: 'sha256', algorithm: 'sha256' as const, hexLength: 64, valve: 40_304_640 },
      ])(
        'Then at $label the real sizer reconciles with the typical entry allowance, and maxEntries × that real size never exceeds the valve',
        ({ algorithm, hexLength, valve }) => {
          // Arrange — one parent (this row's own hex width) plus a 216-byte
          // message, no signature and no extra headers: the shape
          // PARSED_OBJECT_TYPICAL_ENTRY_BYTES was measured on, whose doc
          // comment reconciles it as the sizer's 950 B fixed overhead + 216 B
          // message + 40 B sha1 parent = 1,206 B. Unlike a hand-picked literal,
          // this ties the measured constant to what `parsedObjectByteSize` —
          // the function that actually sizes every cached entry — computes for
          // that representative commit at this width.
          const typicalCommitData = {
            message: 'x'.repeat(216),
            extraHeaders: [],
            parents: ['a'.repeat(hexLength) as ObjectId],
          };
          const widthSurcharge = hexLength - 40;
          const ctx = createMemoryContext({ algorithm });
          const memo = parsedObjectMemoFor(ctx);
          const cap = memoMaxEntries(ctx);
          const resolvedValve = memoByteValve(ctx);
          const realTypicalBytes = parsedObjectByteSize(typicalCommitData, hexLength);

          // Act — a future retune that flips the binding constraint back to a
          // fixed entry cap would fail one of the assertions below instead of
          // shipping a dead cache silently.
          const admitted = memo?.set('typical', {} as never, realTypicalBytes);

          // Assert — reconciles the documented constant with the real sizer's
          // output at this width (retuning the sizer's own fixed overhead
          // breaks this), then proves the derived cap still respects the
          // valve at that real size.
          expect(realTypicalBytes).toBe(PARSED_OBJECT_TYPICAL_ENTRY_BYTES + widthSurcharge);
          expect(cap).toBe(32_768);
          expect(resolvedValve).toBe(valve);
          expect(cap * realTypicalBytes).toBeLessThanOrEqual(resolvedValve);
          expect(admitted).toBe(true);
        },
      );
    });
  });

  describe('Given a non-default deltaCacheMaxBytes of 4 MiB', () => {
    describe('When resolving the memo entry cap', () => {
      it('Then the cap derives from the dial — 8,192 entries', () => {
        // Arrange
        const ctx = createMemoryContext({ deltaCacheMaxBytes: 4 * 1024 * 1024 });

        // Act
        const cap = memoMaxEntries(ctx);

        // Assert
        expect(cap).toBe(8_192);
      });
    });

    describe('When resolving the memo byte valve', () => {
      it('Then it is entries × the measured typical entry cost, not the untouched dial', () => {
        // Arrange
        const ctx = createMemoryContext({ deltaCacheMaxBytes: 4 * 1024 * 1024 });

        // Act
        const valve = memoByteValve(ctx);

        // Assert
        expect(valve).toBe(9_879_552);
      });
    });
  });

  describe('Given a non-default deltaCacheMaxBytes of 4 MiB at sha256', () => {
    describe('When resolving the memo byte valve', () => {
      it('Then the width surcharge scales with the smaller dial-derived entry count', () => {
        // Arrange
        const ctx = createMemoryContext({
          algorithm: 'sha256',
          deltaCacheMaxBytes: 4 * 1024 * 1024,
        });

        // Act
        const valve = memoByteValve(ctx);

        // Assert
        expect(valve).toBe(10_076_160);
      });
    });
  });

  describe('Given an explicit parsedObjectMemoMaxEntries at sha256', () => {
    describe('When resolving the memo entry cap and its byte valve', () => {
      it('Then the explicit cap wins for entries, but the byte valve stays dial-derived', () => {
        // Arrange
        const ctx = createMemoryContext({ algorithm: 'sha256', parsedObjectMemoMaxEntries: 100 });

        // Act
        const cap = memoMaxEntries(ctx);
        const valve = memoByteValve(ctx);

        // Assert
        expect(cap).toBe(100);
        expect(valve).toBe(40_304_640);
      });
    });
  });

  describe('Given commits with 4 KiB messages, sized well past the typical-entry allowance', () => {
    describe('When more entries than the byte valve admits are inserted', () => {
      it('Then the entry count settles at the honest byte valve, not the untouched dial', () => {
        // Arrange — a 4 KiB message dwarfs the "typical" allowance, so each
        // entry costs far more than the constant that used to gate the
        // valve at the raw dial. Overshooting by 10 inserts proves eviction
        // actually happened rather than everything merely fitting.
        const oid40 = 'a'.repeat(40) as ObjectId;
        const bytes = parsedObjectByteSize(
          { message: 'x'.repeat(4096), extraHeaders: [], parents: [oid40] },
          40,
        );
        const ctx = createMemoryContext();
        const memo = parsedObjectMemoFor(ctx);
        const insertCount = Math.ceil(memoByteValve(ctx) / bytes) + 10;

        // Act
        for (let i = 0; i < insertCount; i += 1) {
          memo?.set(`commit-${i}`, {} as never, bytes);
        }

        // Assert — bound by the honest byte valve, strictly above what the
        // valve would have admitted had it been left at the raw dial.
        expect(memo?.entryCount).toBe(Math.floor(memoByteValve(ctx) / bytes));
        expect(memo?.entryCount).toBeGreaterThan(Math.floor((16 * 1024 * 1024) / bytes));
      });
    });
  });
});
