import { describe, expect, it, vi } from 'vitest';
import { probeLooseOid } from '../../../../../src/application/primitives/internal/loose-oid-cache.js';
import { rescanOnFullMiss } from '../../../../../src/application/primitives/internal/pack-miss-rescan.js';
import { createPackRegistry } from '../../../../../src/application/primitives/pack-registry.js';
import type { ObjectId } from '../../../../../src/domain/objects/index.js';
import { computeLooseObjectPath } from '../../../../../src/domain/storage/loose-path.js';
import { buildSeededContext } from '../fixtures.js';

const idOf = (n: number): ObjectId => n.toString(16).padStart(2, '0').repeat(20) as ObjectId;

/** A plain externally-resolvable promise: `resolve()` settles `promise`
 *  whenever the caller chooses to call it — the test below uses it to stand
 *  in for `registry.reprepare()`'s own promise, so it can control exactly
 *  when the mocked wave settles. */
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

  describe('Given a rescan wave whose reprepare rejects', () => {
    describe('When a second miss arrives after the rejection has settled', () => {
      it('Then a fresh wave runs its own reprepare and resolves', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const registry = await createPackRegistry(ctx);
        const reprepareSpy = vi
          .spyOn(registry, 'reprepare')
          .mockRejectedValueOnce(new Error('boom'))
          .mockResolvedValueOnce(undefined);

        // Act
        await expect(rescanOnFullMiss(ctx, registry, idOf(0))).rejects.toThrow('boom');
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

        // Act — A starts the wave, whose `.then` reaction on `reprepareGate`
        // now drops the session entry FIRST and only then forgets every id
        // that joined; the `.finally` chained onto that `.then`'s own result
        // is a safety net for the REJECTION path only, a no-op here. B's
        // join is registered as a SECOND, direct reaction on `reprepareGate`
        // itself, so it runs right after the wave's own `.then` — once the
        // entry is already gone — and starts a fresh wave of its own. B's
        // loose bytes land on disk before the wave settles at all.
        const waveA = rescanOnFullMiss(ctx, registry, idA);
        let waveB: Promise<void> | undefined;
        reprepareGate.then(() => {
          waveB = rescanOnFullMiss(ctx, registry, idB);
        });
        const loosePath = `${ctx.layout.gitDir}/objects/${computeLooseObjectPath(idB)}`;
        await ctx.fs.write(loosePath, new Uint8Array([1, 2, 3]));
        settleReprepare();
        await waveA;
        await waveB;

        // Assert — B's own prefix was dropped from the fanout cache too,
        // not just A's, so the retry sees the file the direct write added.
        expect(await probeLooseOid(ctx, idB)).toBe(true);
      });
    });
  });

  describe('Given two misses for different ids that join the SAME in-flight wave', () => {
    describe('When the wave settles', () => {
      it("Then the joining id's own fanout prefix is forgotten too, not just the wave starter's", async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const registry = await createPackRegistry(ctx);
        const idA = idOf(0xaa);
        const idB = idOf(0xbb);
        expect(await probeLooseOid(ctx, idA)).toBe(false);
        expect(await probeLooseOid(ctx, idB)).toBe(false);
        const { promise: reprepareGate, resolve: settleReprepare } = deferred();
        vi.spyOn(registry, 'reprepare').mockReturnValue(reprepareGate);

        // Act — B joins the wave A already started, both calls made before
        // reprepare() ever settles, so B never starts its own wave.
        const waveA = rescanOnFullMiss(ctx, registry, idA);
        const waveB = rescanOnFullMiss(ctx, registry, idB);
        const loosePathB = `${ctx.layout.gitDir}/objects/${computeLooseObjectPath(idB)}`;
        await ctx.fs.write(loosePathB, new Uint8Array([1, 2, 3]));
        settleReprepare();
        await waveA;
        await waveB;

        // Assert — B's own prefix was forgotten by the wave it only joined.
        expect(await probeLooseOid(ctx, idB)).toBe(true);
      });
    });
  });

  describe("Given wave A's own .then drops its entry, and wave B starts before A's .finally runs", () => {
    describe("When A's .finally fires, then a third miss arrives", () => {
      it("Then A's .finally does not delete B's entry — the third miss joins B, never a third reprepare", async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const registry = await createPackRegistry(ctx);
        const idA = idOf(0xa1);
        const idB = idOf(0xb2);
        const idC = idOf(0xc3);
        const gates: Array<() => void> = [];
        const reprepareSpy = vi.spyOn(registry, 'reprepare').mockImplementation(() => {
          const { promise, resolve } = deferred();
          gates.push(resolve);
          return promise;
        });

        // Act — A settles and its `.then` drops its own entry (one
        // microtask tick); B starts a fresh wave in the gap before A's
        // `.finally` runs (a second tick); C arrives once A's `.finally`
        // has already run its (guarded) drop.
        const waveA = rescanOnFullMiss(ctx, registry, idA);
        gates[0]?.();
        await Promise.resolve();
        const waveB = rescanOnFullMiss(ctx, registry, idB);
        await Promise.resolve();
        const waveC = rescanOnFullMiss(ctx, registry, idC);
        gates[1]?.();
        gates[2]?.();
        await waveA;
        await waveB;
        await waveC;

        // Assert — exactly two reprepare() calls: A's own, and B's, which C
        // joined rather than starting a third.
        expect(reprepareSpy).toHaveBeenCalledTimes(2);
      });
    });
  });
});
