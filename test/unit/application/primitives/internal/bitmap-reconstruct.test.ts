/**
 * Unit tests for XOR-chain reconstruction, exercised directly against a
 * hand-built container — no pack, no filesystem. The chain deliberately
 * OVERLAPS its deltas (each entry re-states a bit its base already carries)
 * so XOR and OR give different answers, and the memo is observed through the
 * `LruCache` the context declares rather than through the reconstructed set,
 * which a memo can never change.
 */
import { describe, expect, it } from 'vitest';
import {
  createReconstructionContext,
  type ReconstructionContext,
  reconstructEntry,
} from '../../../../../src/application/primitives/internal/bitmap-reconstruct.js';
import {
  bitmapEntryHeaders,
  createLruCache,
  type LruCache,
  parsePackBitmap,
} from '../../../../../src/domain/storage/index.js';
import { type BitmapSpec, buildBitmap } from '../../../domain/storage/arbitraries.js';

const DIGEST_LENGTH = 20;
const WORD_BITS = 32;
/** Three lanes — 12 bytes per reconstructed set, more than a cache sized in
 *  bytes rather than mebibytes would ever accept. */
const LANE_COUNT = 3;
const BIT_SIZE = LANE_COUNT * WORD_BITS;

/**
 * Terminator {0,1}, then two deltas each re-stating a bit their base already
 * sets: resolved(i) = stored(i) XOR resolved(i-1) gives {0,1}, {0,2}, {0,3},
 * while an OR-folded chain would accumulate {0,1}, {0,1,2}, {0,1,2,3}.
 */
const CHAIN_SPEC: BitmapSpec = {
  optionFlags: 0x0001,
  digestLength: DIGEST_LENGTH,
  checksum: new Uint8Array(DIGEST_LENGTH).fill(0xcc),
  typeStreams: [
    { bits: [], bitSize: BIT_SIZE },
    { bits: [], bitSize: BIT_SIZE },
    { bits: [], bitSize: BIT_SIZE },
    { bits: [], bitSize: 0 },
  ],
  entries: [
    { position: 0, xorOffset: 0, flags: 0, bits: [0, 1], bitSize: BIT_SIZE },
    { position: 1, xorOffset: 1, flags: 0, bits: [1, 2], bitSize: BIT_SIZE },
    { position: 2, xorOffset: 1, flags: 0, bits: [2, 3], bitSize: BIT_SIZE },
  ],
  trailingBytes: 0,
};

const TERMINATOR = 0;
const MIDDLE = 1;
const TIP = 2;

function freshContext(cache?: LruCache<Uint32Array>): ReconstructionContext {
  const bitmap = parsePackBitmap(buildBitmap(CHAIN_SPEC), DIGEST_LENGTH);
  const headers = bitmapEntryHeaders(bitmap);
  if (cache === undefined) return createReconstructionContext(bitmap, headers, LANE_COUNT);
  return { bitmap, headers, laneCount: LANE_COUNT, cache };
}

function setPositions(bits: Uint32Array): ReadonlyArray<number> {
  const positions: number[] = [];
  bits.forEach((word, lane) => {
    for (let bit = 0; bit < WORD_BITS; bit += 1) {
      if (((word >>> bit) & 1) === 1) positions.push(lane * WORD_BITS + bit);
    }
  });
  return positions;
}

interface CacheProbe {
  readonly cache: LruCache<Uint32Array>;
  readonly setKeys: ReadonlyArray<string>;
}

/** A real LRU that also records the key of every `set`, so a walk that stops
 *  at a cached base is distinguishable from one that folds past it — the two
 *  produce the very same bit set by construction. */
function probedCache(): CacheProbe {
  const delegate = createLruCache<Uint32Array>(1024 * 1024);
  const setKeys: string[] = [];
  return {
    setKeys,
    cache: {
      get: (key) => delegate.get(key),
      set: (key, value, byteSize) => {
        setKeys.push(key);
        delegate.set(key, value, byteSize);
      },
      has: (key) => delegate.has(key),
      delete: (key) => delegate.delete(key),
      clear: () => delegate.clear(),
      get currentSize() {
        return delegate.currentSize;
      },
      get maxSize() {
        return delegate.maxSize;
      },
      get entryCount() {
        return delegate.entryCount;
      },
    },
  };
}

describe('Given an XOR chain whose every delta re-states a bit its base already carries', () => {
  describe('When each entry is reconstructed in a cold context', () => {
    it.each([
      { label: 'the terminator', entryIndex: TERMINATOR, positions: [0, 1] },
      { label: 'the middle entry', entryIndex: MIDDLE, positions: [0, 2] },
      { label: 'the tip', entryIndex: TIP, positions: [0, 3] },
    ])(
      'Then $label resolves to the XOR-accumulated set, never the union',
      ({ entryIndex, positions }) => {
        // Arrange
        const rc = freshContext();
        const sut = reconstructEntry;

        // Act
        const result = sut(rc, entryIndex);

        // Assert
        expect(setPositions(result)).toEqual(positions);
      },
    );
  });
});

describe('Given a cold context in which the tip has just been reconstructed', () => {
  describe('When an entry the tip folded through is reconstructed afterwards', () => {
    it('Then it reports its own set — the chain walk never left it aliasing the tip', () => {
      // Arrange
      const rc = freshContext();
      const sut = reconstructEntry;
      sut(rc, TIP);

      // Act
      const result = sut(rc, MIDDLE);

      // Assert
      expect(setPositions(result)).toEqual([0, 2]);
    });
  });
});

describe('Given a context in which an entry’s base is already reconstructed', () => {
  describe('When the entry itself is reconstructed', () => {
    it('Then the base still reports its own set — the fold never wrote through it', () => {
      // Arrange
      const rc = freshContext();
      const sut = reconstructEntry;
      sut(rc, MIDDLE);

      // Act
      sut(rc, TIP);

      // Assert
      expect(setPositions(sut(rc, MIDDLE))).toEqual([0, 2]);
    });

    it('Then only that entry is folded and cached — the walk stops at the cached base', () => {
      // Arrange
      const probe = probedCache();
      const rc = freshContext(probe.cache);
      const sut = reconstructEntry;
      sut(rc, MIDDLE);
      const warmed = probe.setKeys.length;

      // Act
      sut(rc, TIP);

      // Assert
      expect(probe.setKeys.slice(warmed)).toEqual([String(TIP)]);
    });
  });
});

describe('Given a reconstruction context created for a three-lane artefact', () => {
  describe('When one entry is reconstructed', () => {
    it('Then the resolved set is retained in the context cache, which is sized for far larger sets', () => {
      // Arrange
      const rc = freshContext();
      const sut = reconstructEntry;

      // Act
      sut(rc, TERMINATOR);

      // Assert
      expect(rc.cache.entryCount).toBe(1);
      expect(rc.cache.currentSize).toBe(LANE_COUNT * 4);
    });
  });
});
