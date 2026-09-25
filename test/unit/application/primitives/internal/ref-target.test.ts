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
import { writeSyntheticPack } from '../pack-fixture.js';

const REMEMBERED_TARGETS = 4096;
const TAG_REF = 'refs/tags/verified' as RefName;
const ENCODER = new TextEncoder();

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
});
