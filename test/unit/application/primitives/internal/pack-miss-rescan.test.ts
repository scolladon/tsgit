import { describe, expect, it, vi } from 'vitest';
import { rescanOnFullMiss } from '../../../../../src/application/primitives/internal/pack-miss-rescan.js';
import { createPackRegistry } from '../../../../../src/application/primitives/pack-registry.js';
import type { ObjectId } from '../../../../../src/domain/objects/index.js';
import { buildSeededContext } from '../fixtures.js';

const idOf = (n: number): ObjectId => n.toString(16).padStart(2, '0').repeat(20) as ObjectId;

describe('rescanOnFullMiss', () => {
  describe('Given N concurrent full misses on the same registry, for distinct ids', () => {
    describe('When rescanOnFullMiss is called concurrently for each', () => {
      it('Then registry.reprepare runs exactly once for the whole wave', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const registry = await createPackRegistry(ctx);
        const reprepareSpy = vi.spyOn(registry, 'reprepare');

        // Act
        await Promise.all(
          Array.from({ length: 5 }, (_unused, i) => rescanOnFullMiss(ctx, registry, idOf(i))),
        );

        // Assert
        expect(reprepareSpy).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe('Given a rescan wave that has already settled', () => {
    describe('When rescanOnFullMiss is called again', () => {
      it('Then registry.reprepare runs again for the new wave', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const registry = await createPackRegistry(ctx);
        const reprepareSpy = vi.spyOn(registry, 'reprepare');
        await rescanOnFullMiss(ctx, registry, idOf(0));

        // Act
        await rescanOnFullMiss(ctx, registry, idOf(1));

        // Assert
        expect(reprepareSpy).toHaveBeenCalledTimes(2);
      });
    });
  });
});
