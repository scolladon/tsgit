import { describe, expect, it, vi } from 'vitest';
import { probeLooseOid } from '../../../../../src/application/primitives/internal/loose-oid-cache.js';
import { rescanOnFullMiss } from '../../../../../src/application/primitives/internal/pack-miss-rescan.js';
import { createPackRegistry } from '../../../../../src/application/primitives/pack-registry.js';
import type { ObjectId } from '../../../../../src/domain/objects/index.js';
import { computeLooseObjectPath } from '../../../../../src/domain/storage/loose-path.js';
import { buildSeededContext } from '../fixtures.js';

const idOf = (n: number): ObjectId => n.toString(16).padStart(2, '0').repeat(20) as ObjectId;

/** Resolves once `promise` (or `registry.reprepare`'s mocked stand-in for
 *  it) has settled and every reaction chained onto it BEFORE this call
 *  has run — used to land test code inside the exact microtask gap
 *  between `rescanOnFullMiss`'s own `.then` (the forget pass) and its
 *  `.finally` (the session-entry removal), by registering as a THIRD
 *  direct reaction on the SAME underlying promise. */
function deferred(): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

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

  describe('Given a miss for id B, in a DIFFERENT fanout prefix than an in-flight wave, joining right as that wave forgets its own ids', () => {
    describe("When B's loose file is written directly to disk before the wave settles", () => {
      it('Then B resolves on its retry — its own prefix was forgotten too', async () => {
        // Arrange — both prefixes' fanout listings are probed (and cached
        // empty) up front, exactly as a real full-object miss would.
        const ctx = await buildSeededContext();
        const registry = await createPackRegistry(ctx);
        const idA = idOf(0xaa);
        const idB = idOf(0xbb);
        expect(await probeLooseOid(ctx, idA)).toBe(false);
        expect(await probeLooseOid(ctx, idB)).toBe(false);
        const { promise: reprepareGate, resolve: settleReprepare } = deferred();
        vi.spyOn(registry, 'reprepare').mockReturnValue(reprepareGate);

        // Act — A starts the wave; B's join is registered as a THIRD
        // reaction directly on `reprepareGate`, landing in the exact
        // microtask gap between the wave's own `.then` (the forget pass)
        // and `.finally` (the session-entry removal) — see `deferred`'s
        // doc. B's loose bytes land on disk before the wave settles at all.
        const waveA = rescanOnFullMiss(ctx, registry, idA);
        let waveB: Promise<void> | undefined;
        reprepareGate.then(() => {
          waveB = rescanOnFullMiss(ctx, registry, idB);
        });
        const loosePath = `${ctx.layout.gitDir}/objects/${computeLooseObjectPath(idB)}`;
        await ctx.fs.write(loosePath, new Uint8Array([1, 2, 3]));
        settleReprepare();
        await waveA;

        // Act — B's retry.
        await waveB;

        // Assert — B's own prefix was dropped from the fanout cache too,
        // not just A's, so the retry sees the file the direct write added.
        expect(await probeLooseOid(ctx, idB)).toBe(true);
      });
    });
  });
});
