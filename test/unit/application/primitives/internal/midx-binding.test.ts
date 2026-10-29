import { describe, expect, it } from 'vitest';
import {
  findMidxHit,
  type LoadedMidx,
} from '../../../../../src/application/primitives/internal/midx-binding.js';
import { loadMidxSet } from '../../../../../src/application/primitives/internal/midx-source.js';
import type { RegisteredPack } from '../../../../../src/application/primitives/pack-registry.js';
import type { ObjectId } from '../../../../../src/domain/objects/index.js';
import { buildMidx } from '../../../domain/storage/arbitraries.js';
import { buildSeededContext } from '../fixtures.js';

const HELD_ID = 'a'.repeat(40) as ObjectId;
const ABSENT_ID = 'b'.repeat(40) as ObjectId;
const OFFSET = 12;

async function loadedMidx(bound: ReadonlyArray<RegisteredPack | undefined>): Promise<LoadedMidx> {
  const ctx = await buildSeededContext();
  const dir = `${ctx.layout.gitDir}/objects/pack`;
  await ctx.fs.write(
    `${dir}/multi-pack-index`,
    buildMidx({
      version: 1,
      hashVersion: 1,
      digestLength: 20,
      numBaseFiles: 0,
      packNames: ['pack-A.idx'],
      entries: [{ id: HELD_ID, packIndex: 0, offset: OFFSET }],
    }),
  );
  const { set } = await loadMidxSet(ctx, dir);
  return {
    set: set!,
    packsByLayer: [bound],
    claimedNames: new Set(),
    packFileOnDiskByLayer: [[false]],
  };
}

describe('findMidxHit', () => {
  describe('Given a midx whose owner pack for the id is bound, When findMidxHit runs', () => {
    it('Then it reports a hit carrying the owner pack and offset', async () => {
      // Arrange
      const pack = { name: 'pack-A' } as RegisteredPack;
      const midx = await loadedMidx([pack]);
      const sut = findMidxHit;

      // Act
      const result = sut(midx, HELD_ID);

      // Assert
      expect(result).toEqual({ kind: 'hit', hit: { pack, offset: OFFSET } });
    });
  });

  describe('Given a midx whose owner pack for the id never bound, When findMidxHit runs', () => {
    it('Then it reports owner-unavailable', async () => {
      // Arrange
      const midx = await loadedMidx([undefined]);
      const sut = findMidxHit;

      // Act
      const result = sut(midx, HELD_ID);

      // Assert
      expect(result).toEqual({ kind: 'owner-unavailable' });
    });
  });

  describe('Given a midx no layer of which holds the id, When findMidxHit runs', () => {
    it('Then it reports a miss', async () => {
      // Arrange
      const midx = await loadedMidx([{ name: 'pack-A' } as RegisteredPack]);
      const sut = findMidxHit;

      // Act
      const result = sut(midx, ABSENT_ID);

      // Assert
      expect(result).toEqual({ kind: 'miss' });
    });
  });
});
