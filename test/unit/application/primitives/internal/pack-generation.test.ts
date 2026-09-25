import { describe, expect, it, vi } from 'vitest';
import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import { resolveIndexes } from '../../../../../src/application/primitives/internal/pack-generation.js';
import type { RegisteredPack } from '../../../../../src/application/primitives/pack-registry.js';
import { invalidPackIndex } from '../../../../../src/domain/storage/index.js';

/**
 * A `RegisteredPack` whose `.index()` always rejects with the given
 * (skippable) fault, every other field throwing if ever touched —
 * `resolveIndexes` only ever reads `name` and calls `index()`.
 */
function unreadableIdxPack(name: string, reason: string): RegisteredPack {
  const boom = (): never => {
    throw new Error('unexpected pack access');
  };
  return {
    name,
    instanceKey: `${name}#0`,
    index: () => Promise.reject(invalidPackIndex(reason)),
    packPath: `${name}.pack`,
    idxPath: `${name}.idx`,
    header: boom,
    offsetTable: boom,
    readSlice: boom,
    close: boom,
    hasRevIndex: false,
    revIndex: boom,
    packPositions: boom,
    hasBitmap: false,
    bitmapBytes: boom,
  };
}

describe('resolveIndexes', () => {
  describe('Given a pack whose .idx is unreadable', () => {
    describe('When resolveIndexes runs', () => {
      it('Then it warns with the exact skipping-unreadable-index message', async () => {
        // Arrange
        const warn = vi.fn();
        const ctx = { ...createMemoryContext(), logger: { warn } };
        const pack = unreadableIdxPack('pack-a', 'truncated');

        // Act
        await resolveIndexes(ctx, [pack], new Set());

        // Assert
        expect(warn).toHaveBeenCalledWith(
          'packRegistry: skipping unreadable pack index',
          expect.objectContaining({ idx: 'pack-a.idx' }),
        );
      });
    });
  });

  describe('Given the same warnedIdx set threaded across two resolveIndexes calls for the same unreadable idx', () => {
    describe('When resolveIndexes runs a second time', () => {
      it('Then it does not warn again — the first call already recorded the idx', async () => {
        // Arrange
        const warn = vi.fn();
        const ctx = { ...createMemoryContext(), logger: { warn } };
        const pack = unreadableIdxPack('pack-a', 'truncated');
        const warnedIdx = new Set<string>();

        // Act
        await resolveIndexes(ctx, [pack], warnedIdx);
        await resolveIndexes(ctx, [pack], warnedIdx);

        // Assert
        expect(warn).toHaveBeenCalledTimes(1);
      });
    });
  });
});
