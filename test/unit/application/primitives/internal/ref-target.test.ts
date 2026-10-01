import { describe, expect, it, vi } from 'vitest';
import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import { forgetLooseOidPrefix } from '../../../../../src/application/primitives/internal/loose-oid-cache.js';
import { assertRefTargetValid } from '../../../../../src/application/primitives/internal/ref-target.js';
import { getPackRegistry } from '../../../../../src/application/primitives/read-object.js';
import { writeObject } from '../../../../../src/application/primitives/write-object.js';
import type { TsgitError } from '../../../../../src/domain/error.js';
import type { Blob, ObjectId, RefName } from '../../../../../src/domain/objects/index.js';
import { serializeObject } from '../../../../../src/domain/objects/index.js';
import { computeLooseObjectPath } from '../../../../../src/domain/storage/loose-path.js';
import { buildSeededContext, instrumentedContext } from '../fixtures.js';
import { writeSyntheticPack, writeSyntheticPackIn } from '../pack-fixture.js';

const REMEMBERED_TARGETS = 4096;
const TAG_REF = 'refs/tags/verified' as RefName;
const ENCODER = new TextEncoder();
const COMMIT_BODY = `tree ${'0'.repeat(40)}\nauthor A <a@a> 0 +0000\ncommitter A <a@a> 0 +0000\n\nm\n`;
const PRIMARY_OBJECTS = '/repo/.git/objects';
const ALT_OBJECTS = '/repo/alt/objects';
// A multi-pack-index whose signature is flipped: the alternate cannot load.
const FLIPPED_SIGNATURE_MIDX = Uint8Array.from([
  0x00,
  0x49,
  0x44,
  0x58,
  1,
  1,
  1,
  0,
  ...new Array(8).fill(0),
]);

const contextWithUnusableAlternate = async () => {
  const ctx = createMemoryContext({
    files: { [`${PRIMARY_OBJECTS}/info/alternates`]: ENCODER.encode(`${ALT_OBJECTS}\n`) },
  });
  await ctx.fs.mkdir(ALT_OBJECTS);
  await ctx.fs.write(`${ALT_OBJECTS}/pack/multi-pack-index`, FLIPPED_SIGNATURE_MIDX);
  return ctx;
};

const rejectionData = async (attempt: Promise<unknown>): Promise<unknown> => {
  try {
    await attempt;
  } catch (error) {
    return (error as TsgitError).data;
  }
  return undefined;
};

describe('assertRefTargetValid', () => {
  describe('Given more distinct blobs verified on one Context than it remembers', () => {
    describe('When the oldest and the newest are verified again', () => {
      it('Then only the oldest has been forgotten — its stored bytes are read again', async () => {
        // Arrange — ctx.deltaCache is disabled so this test isolates the
        // property it means to prove (`verifiedTargets`' own bounded memo
        // evicting its oldest entry) from openBlobSource's buffered arms,
        // which would otherwise keep every tiny blob content-cached forever
        // and mask the eviction behind a content-cache hit.
        const base = createMemoryContext({ deltaCacheMaxBytes: 0 });
        const ids: ObjectId[] = [];
        for (let index = 0; index <= REMEMBERED_TARGETS; index += 1) {
          const content = ENCODER.encode(`blob ${index}`);
          ids.push(await writeObject(base, { type: 'blob', id: '' as ObjectId, content }));
        }
        const { ctx, calls } = instrumentedContext(base);
        for (const id of ids) await assertRefTargetValid(ctx, TAG_REF, id);
        const oldest = ids[0] as ObjectId;
        const newest = ids[REMEMBERED_TARGETS] as ObjectId;
        const before = calls().length;
        const sut = assertRefTargetValid;

        // Act
        await sut(ctx, TAG_REF, oldest);
        await sut(ctx, TAG_REF, newest);

        // Assert
        const touchesOf = (id: ObjectId): readonly string[] => {
          const path = `${base.layout.gitDir}/objects/${computeLooseObjectPath(id)}`;
          return calls()
            .slice(before)
            .filter((call) => call.path === path && call.method !== 'exists')
            .map((call) => call.method);
        };
        expect(touchesOf(oldest).length).toBeGreaterThan(0);
        expect(touchesOf(newest)).toEqual([]);
      });
    });
  });

  describe('Given a memoised target moved into a pack written after the registry last scanned', () => {
    describe('When the target is verified again for a second ref write', () => {
      it('Then the write succeeds via exactly one reprepare()', async () => {
        // Arrange
        const content = ENCODER.encode('moved into a pack');
        const blob: Blob = { type: 'blob', content, id: '' as ObjectId };
        const ctx = await buildSeededContext({ objects: [blob] });
        const id = (await ctx.hash.hashHex(serializeObject(blob, ctx.hashConfig))) as ObjectId;
        await assertRefTargetValid(ctx, TAG_REF, id); // populates the memo
        const registry = await getPackRegistry(ctx);
        await registry.all(); // forces the initial scan while the pack dir is still empty
        const loosePath = `${ctx.layout.gitDir}/objects/${computeLooseObjectPath(id)}`;
        await ctx.fs.rm(loosePath);
        // Mirrors the gc/repack primitive's own invalidation of the loose
        // membership cache right after it unlinks a just-repacked object.
        forgetLooseOidPrefix(ctx, id);
        await writeSyntheticPack(ctx, 'ref-target-moved', [
          { kind: 'base', type: 'blob', content },
        ]);
        const reprepareSpy = vi.spyOn(registry, 'reprepare');

        // Act
        await assertRefTargetValid(ctx, TAG_REF, id);

        // Assert
        expect(reprepareSpy).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe('Given a memoised target that has since vanished entirely', () => {
    describe('When the target is verified again for a second ref write', () => {
      it('Then it refuses as OBJECT_NOT_FOUND via exactly one reprepare()', async () => {
        // Arrange
        const content = ENCODER.encode('vanishes without a trace');
        const blob: Blob = { type: 'blob', content, id: '' as ObjectId };
        const ctx = await buildSeededContext({ objects: [blob] });
        const id = (await ctx.hash.hashHex(serializeObject(blob, ctx.hashConfig))) as ObjectId;
        await assertRefTargetValid(ctx, TAG_REF, id); // populates the memo
        const loosePath = `${ctx.layout.gitDir}/objects/${computeLooseObjectPath(id)}`;
        await ctx.fs.rm(loosePath);
        forgetLooseOidPrefix(ctx, id);
        const registry = await getPackRegistry(ctx);
        const reprepareSpy = vi.spyOn(registry, 'reprepare');

        // Act
        let caught: unknown;
        try {
          await assertRefTargetValid(ctx, TAG_REF, id);
        } catch (err) {
          caught = err;
        }

        // Assert
        expect((caught as TsgitError).data).toEqual({ code: 'OBJECT_NOT_FOUND', id });
        expect(reprepareSpy).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe('Given a small packed blob target and an unusable alternate', () => {
    describe('When assertRefTargetValid', () => {
      it("Then it rejects with the alternate's error data", async () => {
        // Arrange
        const ctx = await contextWithUnusableAlternate();
        const [id] = await writeSyntheticPackIn(ctx, PRIMARY_OBJECTS, 'p', [
          { kind: 'base', type: 'blob', content: ENCODER.encode('small') },
        ]);
        const sut = assertRefTargetValid;

        // Act
        const data = await rejectionData(sut(ctx, TAG_REF, id as ObjectId));

        // Assert
        expect(data).toMatchObject({ code: 'INVALID_MULTI_PACK_INDEX' });
      });
    });
  });

  describe('Given a packed commit target and an unusable alternate', () => {
    describe('When assertRefTargetValid', () => {
      it('Then the alternate is never reached', async () => {
        // Arrange
        const ctx = await contextWithUnusableAlternate();
        const [id] = await writeSyntheticPackIn(ctx, PRIMARY_OBJECTS, 'p', [
          { kind: 'base', type: 'commit', content: ENCODER.encode(COMMIT_BODY) },
        ]);
        const sut = assertRefTargetValid;

        // Act
        const data = await rejectionData(sut(ctx, TAG_REF, id as ObjectId));

        // Assert
        expect(data).toBeUndefined();
      });
    });
  });
});
