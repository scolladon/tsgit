/**
 * Unit tests for the Tier-1 `pack-objects` command — the packfile-writing
 * counterpart to `rev-list`, at the OPPOSITE default tier (bitmap unless
 * told not to).
 *
 * Coverage:
 *  - round trip: closure oids land in the written `.pack`/`.idx`
 *  - nothing else written: pack dir gains exactly two files
 *  - empty closure: still writes a valid 0-object pack, no throw
 *  - tier default (bitmap) vs `useBitmapIndex: false` (walk) on a
 *    have-bearing, bitmap-bearing fixture — object COUNTS, never `packId`
 *  - tier agreement with no haves — object SETS, never `packId`
 *  - `outputDirectory` supplied vs omitted — registry refresh
 *  - refusal — an unresolvable want
 */
import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { add } from '../../../../src/application/commands/add.js';
import { commit } from '../../../../src/application/commands/commit.js';
import { init } from '../../../../src/application/commands/init.js';
import { packObjects } from '../../../../src/application/commands/pack-objects.js';
import { revList } from '../../../../src/application/commands/rev-list.js';
import {
  getPackRegistry,
  readObject,
  refreshPackRegistry,
} from '../../../../src/application/primitives/read-object.js';
import { TsgitError } from '../../../../src/domain/index.js';
import type { AuthorIdentity, ObjectId } from '../../../../src/domain/objects/index.js';
import { serializeObject } from '../../../../src/domain/objects/index.js';
import { allObjectIds, parsePackIndex } from '../../../../src/domain/storage/pack-index.js';
import type { Context } from '../../../../src/ports/context.js';
import { type BitmapEntrySpec, buildBitmap } from '../../domain/storage/arbitraries.js';
import {
  type EntrySpec,
  writeSyntheticBitmap,
  writeSyntheticPack,
} from '../primitives/pack-fixture.js';

const AUTHOR: AuthorIdentity = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};

const packDirOf = (ctx: Context): string => `${ctx.layout.gitDir}/objects/pack`;

const idxIdsOf = async (
  ctx: Context,
  dir: string,
  packId: ObjectId,
): Promise<ReadonlySet<string>> => {
  const bytes = await ctx.fs.read(`${dir}/pack-${packId}.idx`);
  return new Set(allObjectIds(parsePackIndex(bytes)));
};

interface SeededRepo {
  readonly ctx: Context;
}

const seedOneCommit = async (): Promise<SeededRepo> => {
  const ctx = createMemoryContext();
  await init(ctx);
  await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'hello');
  await add(ctx, ['a.txt']);
  await commit(ctx, { message: 'seed', author: AUTHOR });
  return { ctx };
};

interface HaveBearingBitmapFixture {
  readonly ctx: Context;
  /** `C2` — reaches every object in the fixture's 8-object pack. */
  readonly wantCommitId: ObjectId;
  /** `C1` — a direct parent of `C2`; its OWN tree never references `a.txt`'s blob. */
  readonly notCommitId: ObjectId;
  /** `a.txt`'s blob — written by `C0` (an ancestor of `notCommitId`, not
   *  `notCommitId` itself) and reused verbatim by `C2`. Reachable from the
   *  `not` tip's own ancestry, but not from its own tree — exactly the case
   *  the walk tier over-reports and the bitmap tier does not. */
  readonly sharedBlobId: ObjectId;
}

const rawContentOf = async (
  ctx: Context,
  id: ObjectId,
): Promise<{ type: 'commit' | 'tree' | 'blob' | 'tag'; content: Uint8Array }> => {
  const object = await readObject(ctx, id);
  const full = serializeObject(object, ctx.hashConfig);
  const nul = full.indexOf(0);
  return { type: object.type, content: full.subarray(nul + 1) };
};

/**
 * A 3-commit chain — `C0` (writes `a.txt`), `C1` (drops `a.txt`, adds
 * `b.txt`), `C2` (re-adds `a.txt` with the SAME content, reusing the blob)
 * — packed into ONE synthetic pack with a single hand-written bitmap entry
 * covering `C2`'s whole 8-object closure. `C1` carries no entry of its own;
 * `resolveBitmapClosure`'s fallback walk still computes its closure exactly
 * (unlike the walk TIER, which only marks a `not` tip's own tree plus one
 * hop of boundary trees) — so `wants: [C2], not: [C1]` is a fixture where
 * the two tiers legitimately disagree on count.
 */
const buildHaveBearingBitmapFixture = async (): Promise<HaveBearingBitmapFixture> => {
  const ctx = createMemoryContext();
  await init(ctx);

  await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'shared');
  await add(ctx, ['a.txt']);
  const c0 = (await commit(ctx, { message: 'gen-0', author: AUTHOR })).id;

  await ctx.fs.rm(`${ctx.layout.workDir}/a.txt`);
  await ctx.fs.writeUtf8(`${ctx.layout.workDir}/b.txt`, 'own');
  await add(ctx, [], { all: true });
  const c1 = (await commit(ctx, { message: 'gen-1', author: AUTHOR })).id;

  await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'shared');
  await add(ctx, ['a.txt']);
  const c2 = (await commit(ctx, { message: 'gen-2', author: AUTHOR })).id;

  const c0Obj = await readObject(ctx, c0);
  const c1Obj = await readObject(ctx, c1);
  const c2Obj = await readObject(ctx, c2);
  if (c0Obj.type !== 'commit' || c1Obj.type !== 'commit' || c2Obj.type !== 'commit') {
    throw new Error('expected commits');
  }
  const t0Obj = await readObject(ctx, c0Obj.data.tree);
  const t1Obj = await readObject(ctx, c1Obj.data.tree);
  if (t0Obj.type !== 'tree' || t1Obj.type !== 'tree') throw new Error('expected trees');
  const blobAId = t0Obj.entries[0]?.id as ObjectId;
  const blobBId = t1Obj.entries[0]?.id as ObjectId;

  // Pack (insertion) order, hand-chosen so type streams and entry bits —
  // both indexed by PACK position — are known ahead of time.
  const order: ObjectId[] = [
    blobAId,
    c0Obj.data.tree,
    c0,
    blobBId,
    c1Obj.data.tree,
    c1,
    c2Obj.data.tree,
    c2,
  ];
  const specs: EntrySpec[] = [];
  for (const id of order) {
    const { type, content } = await rawContentOf(ctx, id);
    specs.push({ kind: 'base', type, content });
  }
  const packName = 'have-bearing';
  await writeSyntheticPack(ctx, packName, specs);

  const indexPositionOf = (id: ObjectId): number => [...order].sort().indexOf(id);
  const objectCount = order.length;
  const allPositions = order.map((_unused, i) => i);
  const typeStream = (bits: ReadonlyArray<number>) => ({ bitSize: objectCount, bits });
  const entrySpec: BitmapEntrySpec = {
    position: indexPositionOf(c2),
    xorOffset: 0,
    flags: 0,
    bitSize: objectCount,
    bits: allPositions,
  };
  const body = buildBitmap({
    optionFlags: 1,
    digestLength: ctx.hashConfig.digestLength,
    checksum: new Uint8Array(ctx.hashConfig.digestLength).fill(0xbb),
    typeStreams: [
      typeStream([2, 5, 7]), // commits: C0, C1, C2
      typeStream([1, 4, 6]), // trees: T0, T1, T2
      typeStream([0, 3]), // blobs: Ba, Bb
      typeStream([]), // tags
    ],
    entries: [entrySpec],
    trailingBytes: 0,
  });
  await writeSyntheticBitmap(
    ctx,
    `${ctx.layout.gitDir}/objects/pack/pack-${packName}.bitmap`,
    body,
  );
  // The `readObject` calls above (reading back c0/c1/c2 and their trees)
  // already triggered a pack-registry scan of this Context — one that saw
  // an empty pack directory, since the synthetic pack didn't exist yet.
  // Without this refresh, `packObjects`'s own registry lookup would still
  // see that stale, empty scan and silently fall back to the walk tier.
  refreshPackRegistry(ctx);

  return { ctx, wantCommitId: c2, notCommitId: c1, sharedBlobId: blobAId };
};

describe('packObjects', () => {
  describe('Given a seeded repo', () => {
    describe('When packObjects is called with wants: ["HEAD"]', () => {
      it('Then a .pack and an .idx land whose oids exactly match the closure', async () => {
        // Arrange
        const { ctx } = await seedOneCommit();
        const sut = packObjects;

        // Act
        const result = await sut(ctx, { wants: ['HEAD'] });

        // Assert
        const dir = packDirOf(ctx);
        const packBytes = await ctx.fs.read(`${dir}/pack-${result.packId}.pack`);
        const idxBytes = await ctx.fs.read(`${dir}/pack-${result.packId}.idx`);
        expect(packBytes.length).toBe(result.packBytes);
        expect(idxBytes.length).toBe(result.indexBytes);

        const expected = await revList(ctx, { wants: ['HEAD'], objects: true });
        expect(result.objectCount).toBe(expected.count);
        expect(new Set(allObjectIds(parsePackIndex(idxBytes)))).toEqual(
          new Set(expected.entries.map((entry) => entry.id)),
        );
      });
    });
  });

  describe('Given the same seeded repo', () => {
    describe('When packObjects writes its pack', () => {
      it('Then the pack directory gains exactly three files — .pack, .idx and .rev, no bitmap', async () => {
        // Arrange
        const { ctx } = await seedOneCommit();
        const sut = packObjects;

        // Act
        await sut(ctx, { wants: ['HEAD'] });

        // Assert
        const entries = await ctx.fs.readdir(packDirOf(ctx));
        expect(entries).toHaveLength(3);
        expect(entries.some((entry) => entry.name.endsWith('.rev'))).toBe(true);
        expect(entries.some((entry) => entry.name.endsWith('.bitmap'))).toBe(false);
      });
    });
  });

  describe('Given wants fully covered by not', () => {
    describe('When packObjects is called', () => {
      it('Then objectCount is 0 and a valid 32-byte pack and index are still written', async () => {
        // Arrange
        const { ctx } = await seedOneCommit();
        const sut = packObjects;

        // Act
        const result = await sut(ctx, { wants: ['HEAD'], not: ['HEAD'] });

        // Assert — 12-byte header + 20-byte trailer, no throw.
        expect(result.objectCount).toBe(0);
        expect(result.packBytes).toBe(32);
        const packBytes = await ctx.fs.read(`${packDirOf(ctx)}/pack-${result.packId}.pack`);
        expect(packBytes.length).toBe(32);
      });
    });
  });

  describe('Given a bitmap-bearing fixture with a have', () => {
    describe('When packObjects runs at its default tier and again with useBitmapIndex: false', () => {
      it('Then the default (bitmap) count is smaller, and the difference is reachable from the not tip', async () => {
        // Arrange
        const { ctx, wantCommitId, notCommitId, sharedBlobId } =
          await buildHaveBearingBitmapFixture();
        const sut = packObjects;

        // Act
        const bitmapResult = await sut(ctx, { wants: [wantCommitId], not: [notCommitId] });
        const walkResult = await sut(ctx, {
          wants: [wantCommitId],
          not: [notCommitId],
          useBitmapIndex: false,
        });

        // Assert — the bitmap tier's exact set difference is smaller than the
        // walk's over-report; the difference is `sharedBlobId`, reachable
        // from the not tip's own ancestor (`C0`), not from `C1`'s own tree.
        expect(bitmapResult.objectCount).toBe(2);
        expect(walkResult.objectCount).toBe(3);
        const dir = packDirOf(ctx);
        const bitmapIds = await idxIdsOf(ctx, dir, bitmapResult.packId);
        const walkIds = await idxIdsOf(ctx, dir, walkResult.packId);
        const difference = [...walkIds].filter((id) => !bitmapIds.has(id));
        expect(difference).toEqual([sharedBlobId]);
      });
    });
  });

  describe('Given the same bitmap-bearing fixture with no haves', () => {
    describe('When packObjects runs at its default tier and again with useBitmapIndex: false', () => {
      it('Then the two tiers write the same object set, never compared by packId', async () => {
        // Arrange
        const { ctx, wantCommitId } = await buildHaveBearingBitmapFixture();
        const sut = packObjects;

        // Act
        const bitmapResult = await sut(ctx, { wants: [wantCommitId] });
        const walkResult = await sut(ctx, { wants: [wantCommitId], useBitmapIndex: false });

        // Assert — same SET, deliberately not asserting packId equality:
        // object order differs by tier, so the pack's own checksum differs too.
        expect(bitmapResult.objectCount).toBe(8);
        expect(walkResult.objectCount).toBe(8);
        const dir = packDirOf(ctx);
        const bitmapIds = await idxIdsOf(ctx, dir, bitmapResult.packId);
        const walkIds = await idxIdsOf(ctx, dir, walkResult.packId);
        expect(bitmapIds).toEqual(walkIds);
      });
    });
  });

  describe('Given outputDirectory is supplied', () => {
    describe('When packObjects is called', () => {
      it('Then the pack is written there and the repository pack registry is not refreshed', async () => {
        // Arrange
        const { ctx } = await seedOneCommit();
        const registry = getPackRegistry(ctx);
        const before = await registry.all();
        expect(before).toHaveLength(0);
        // A pack lands in the repository's own pack directory behind that
        // cached scan: surfacing it is the one and only thing a refresh does,
        // so leaving it unseen is what proves none happened.
        await writeSyntheticPack(ctx, 'behind-the-scan', [
          { kind: 'base', type: 'blob', content: new TextEncoder().encode('behind the scan') },
        ]);
        const customDir = `${ctx.layout.gitDir}/custom-packs`;
        const sut = packObjects;

        // Act
        const result = await sut(ctx, { wants: ['HEAD'], outputDirectory: customDir });

        // Assert — all three artefacts land in the external directory: the
        // `.rev` is a property of the `.idx`, not of the directory it's
        // written into.
        expect(await ctx.fs.exists(`${customDir}/pack-${result.packId}.pack`)).toBe(true);
        expect(await ctx.fs.exists(`${customDir}/pack-${result.packId}.idx`)).toBe(true);
        expect(await ctx.fs.exists(`${customDir}/pack-${result.packId}.rev`)).toBe(true);
        expect(await ctx.fs.exists(`${packDirOf(ctx)}/pack-${result.packId}.pack`)).toBe(false);
        const after = await registry.all();
        expect(after).toHaveLength(0);
      });
    });
  });

  describe('Given outputDirectory is omitted', () => {
    describe('When packObjects is called', () => {
      it('Then the pack lands in the repository pack directory and the registry is refreshed', async () => {
        // Arrange
        const { ctx } = await seedOneCommit();
        const registry = getPackRegistry(ctx);
        const before = await registry.all();
        expect(before).toHaveLength(0);
        const sut = packObjects;

        // Act
        const result = await sut(ctx, { wants: ['HEAD'] });

        // Assert — the just-written pack is visible through the SAME registry
        // handle without a fresh Context, proving the cache was invalidated.
        expect(await ctx.fs.exists(`${packDirOf(ctx)}/pack-${result.packId}.pack`)).toBe(true);
        const after = await registry.all();
        expect(after).toHaveLength(before.length + 1);
        expect(after.some((pack) => pack.packPath.includes(result.packId))).toBe(true);
      });
    });
  });

  describe('Given a want that does not resolve', () => {
    describe('When packObjects is called', () => {
      it('Then it throws with the refusal data.code', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await init(ctx);
        const sut = packObjects;

        // Act
        let caught: unknown;
        try {
          await sut(ctx, { wants: ['this-branch-does-not-exist'] });
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as TsgitError).data.code).toBe('OBJECT_NOT_FOUND');
      });
    });
  });
});
