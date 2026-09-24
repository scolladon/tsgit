import { describe, expect, it, vi } from 'vitest';
import { rescanOnFullMiss } from '../../../../../src/application/primitives/internal/pack-miss-rescan.js';
import { createPackRegistry } from '../../../../../src/application/primitives/pack-registry.js';
import { buildSeededContext } from '../fixtures.js';

describe('rescanOnFullMiss', () => {
  describe('Given N concurrent full misses on the same registry', () => {
    describe('When rescanOnFullMiss is called concurrently for each', () => {
      it('Then registry.refresh runs exactly once for the whole wave', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const registry = await createPackRegistry(ctx);
        const refreshSpy = vi.spyOn(registry, 'refresh');

        // Act
        await Promise.all(Array.from({ length: 5 }, () => rescanOnFullMiss(ctx, registry)));

        // Assert
        expect(refreshSpy).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe('Given a rescan wave that has already settled', () => {
    describe('When rescanOnFullMiss is called again', () => {
      it('Then registry.refresh runs again for the new wave', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const registry = await createPackRegistry(ctx);
        const refreshSpy = vi.spyOn(registry, 'refresh');
        await rescanOnFullMiss(ctx, registry);

        // Act
        await rescanOnFullMiss(ctx, registry);

        // Assert
        expect(refreshSpy).toHaveBeenCalledTimes(2);
      });
    });
  });
});
