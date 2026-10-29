import { describe, expect, it, vi } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { hasObject } from '../../../../src/application/primitives/has-object.js';
import { getPackRegistry } from '../../../../src/application/primitives/read-object.js';
import type { Blob, ObjectId } from '../../../../src/domain/objects/index.js';
import { serializeHeader, serializeObject } from '../../../../src/domain/objects/index.js';
import { computeLooseObjectPath } from '../../../../src/domain/storage/loose-path.js';
import { PACK_HEADER_SIZE } from '../../../../src/domain/storage/pack-entry.js';
import type { Context } from '../../../../src/ports/context.js';
import type { PromisorRemote } from '../../../../src/ports/promisor.js';
import { buildMidx } from '../../domain/storage/arbitraries.js';
import { buildSeededContext, instrumentedContext } from './fixtures.js';
import { writeSyntheticPack, writeSyntheticPackIn } from './pack-fixture.js';

describe('hasObject', () => {
  describe('Given an object present only as a loose file', () => {
    describe('When probing hasObject', () => {
      it('Then it returns true', async () => {
        // Arrange
        const blob: Blob = { type: 'blob', content: new Uint8Array([1, 2, 3]), id: '' as ObjectId };
        const ctx = await buildSeededContext({ objects: [blob] });
        const id = (await ctx.hash.hashHex(serializeObject(blob, ctx.hashConfig))) as ObjectId;

        // Act
        const result = await hasObject(ctx, id);

        // Assert
        expect(result).toBe(true);
      });
    });
  });

  describe('Given an object present only in a pack', () => {
    describe('When probing hasObject', () => {
      it('Then it returns true', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const content = new TextEncoder().encode('packed content\n');
        const [id] = await writeSyntheticPack(ctx, 'has-object-pack', [
          { kind: 'base', type: 'blob', content },
        ]);

        // Act
        const result = await hasObject(ctx, id as ObjectId);

        // Assert
        expect(result).toBe(true);
      });
    });
  });

  describe('Given a pack written directly to disk after the registry already scanned', () => {
    describe('When probing hasObject for the newly-packed id', () => {
      it('Then it answers false without re-scanning, as git has_object does without a recheck', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const registry = await getPackRegistry(ctx);
        await registry.all();
        const content = new TextEncoder().encode('packed content\n');
        const [id] = await writeSyntheticPack(ctx, 'has-object-late-pack', [
          { kind: 'base', type: 'blob', content },
        ]);

        // Act
        const result = await hasObject(ctx, id as ObjectId);

        // Assert
        expect(result).toBe(false);
      });
    });
  });

  describe('Given a pack written directly to disk after the registry already scanned', () => {
    describe('When probing hasObject in recheck mode', () => {
      it('Then it re-scans and finds the newly-packed id', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const registry = await getPackRegistry(ctx);
        await registry.all();
        const content = new TextEncoder().encode('packed content\n');
        const [id] = await writeSyntheticPack(ctx, 'has-object-late-pack-recheck', [
          { kind: 'base', type: 'blob', content },
        ]);

        // Act
        const result = await hasObject(ctx, id as ObjectId, { mode: 'recheck' });

        // Assert
        expect(result).toBe(true);
      });
    });
  });

  describe('Given many ids absent from loose and packs', () => {
    describe('When probing hasObject for each', () => {
      it('Then the pack registry is never refreshed or re-scanned', async () => {
        // Arrange — quick mode (the default hasObject takes here) must
        // never touch EITHER re-scan mechanism: `refresh()`'s full teardown,
        // or `reprepare()`'s incremental re-scan a recheck-mode miss goes
        // through instead.
        const ctx = await buildSeededContext();
        const registry = await getPackRegistry(ctx);
        const refresh = vi.spyOn(registry, 'refresh');
        const reprepare = vi.spyOn(registry, 'reprepare');
        const missingIds = Array.from({ length: 20 }, (_, i) =>
          i.toString(16).padStart(40, 'e'),
        ) as ObjectId[];

        // Act
        for (const id of missingIds) await hasObject(ctx, id);

        // Assert
        expect(refresh).not.toHaveBeenCalled();
        expect(reprepare).not.toHaveBeenCalled();
      });
    });
  });

  describe('Given an id absent from loose and packs', () => {
    describe('When hasObject runs in recheck mode', () => {
      it('Then it returns false and reprepare is called exactly once', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const registry = await getPackRegistry(ctx);
        const reprepare = vi.spyOn(registry, 'reprepare');
        const missingId = 'd'.repeat(40) as ObjectId;

        // Act
        const result = await hasObject(ctx, missingId, { mode: 'recheck' });

        // Assert
        expect(result).toBe(false);
        expect(reprepare).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe('Given an object absent from loose and packs', () => {
    describe('When probing hasObject', () => {
      it('Then it returns false', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const missingId = 'f'.repeat(40) as ObjectId;

        // Act
        const result = await hasObject(ctx, missingId);

        // Assert
        expect(result).toBe(false);
      });
    });
  });

  describe('Given a partial repo with a promisor remote and an absent object', () => {
    describe('When probing hasObject', () => {
      it('Then it returns false without invoking the promisor', async () => {
        // Arrange
        const base = await buildSeededContext();
        const calls = { count: 0 };
        const promisor: PromisorRemote = {
          fetch: async (oids) => {
            calls.count += 1;
            return { attempted: true, requested: oids.length, fetched: 0 };
          },
        };
        const ctx: Context = { ...base, promisor };
        const missingId = 'e'.repeat(40) as ObjectId;

        // Act
        const result = await hasObject(ctx, missingId);

        // Assert
        expect(result).toBe(false);
        expect(calls.count).toBe(0);
      });
    });
  });

  describe('Given an object present only as a loose file', () => {
    describe('When probing hasObject with an instrumented filesystem', () => {
      it('Then the loose fallback lists the fanout dir instead of calling exists', async () => {
        // Arrange
        const blob: Blob = { type: 'blob', content: new Uint8Array([4, 5, 6]), id: '' as ObjectId };
        const base = await buildSeededContext({ objects: [blob] });
        const id = (await base.hash.hashHex(serializeObject(blob, base.hashConfig))) as ObjectId;
        const { ctx, calls } = instrumentedContext(base);

        // Act
        const result = await hasObject(ctx, id);

        // Assert
        expect(result).toBe(true);
        expect(calls().some((call) => call.method === 'exists')).toBe(false);
      });
    });
  });

  describe('Given two hasObject probes for the same loose-only fanout dir', () => {
    describe('When both probes run', () => {
      it('Then exactly one readdir call serves both probes', async () => {
        // Arrange
        const blob: Blob = { type: 'blob', content: new Uint8Array([7, 8, 9]), id: '' as ObjectId };
        const base = await buildSeededContext({ objects: [blob] });
        const id = (await base.hash.hashHex(serializeObject(blob, base.hashConfig))) as ObjectId;
        const fanoutDir = `${base.layout.gitDir}/objects/${id.slice(0, 2)}`;
        const { ctx, calls } = instrumentedContext(base);

        // Act
        await hasObject(ctx, id);
        await hasObject(ctx, id);

        // Assert
        const fanoutReaddirCalls = calls().filter(
          (call) => call.method === 'readdir' && call.path === fanoutDir,
        );
        expect(fanoutReaddirCalls).toHaveLength(1);
      });
    });
  });
});

const ENC = new TextEncoder();
const ALT_OBJECTS = '/repo/alt/objects';

const contextWithAlternate = async (): Promise<Context> => {
  const ctx = createMemoryContext({
    files: { '/repo/.git/objects/info/alternates': ENC.encode(`${ALT_OBJECTS}\n`) },
  });
  await ctx.fs.mkdir(ALT_OBJECTS);
  return ctx;
};

describe('hasObject through alternates', () => {
  describe('Given an object only in an alternate pack', () => {
    describe('When probing hasObject', () => {
      it('Then it returns true', async () => {
        // Arrange
        const ctx = await contextWithAlternate();
        const [id] = await writeSyntheticPackIn(ctx, ALT_OBJECTS, 'alt', [
          { kind: 'base', type: 'blob', content: ENC.encode('alt packed') },
        ]);

        // Act
        const result = await hasObject(ctx, id as ObjectId);

        // Assert
        expect(result).toBe(true);
      });
    });
  });

  describe('Given an object only loose in an alternate', () => {
    describe('When probing hasObject', () => {
      it('Then it returns true', async () => {
        // Arrange
        const ctx = await contextWithAlternate();
        const content = ENC.encode('alt loose');
        const bytes = new Uint8Array([...serializeHeader('blob', content.length), ...content]);
        const id = (await ctx.hash.hashHex(bytes)) as ObjectId;
        await ctx.fs.write(
          `${ALT_OBJECTS}/${computeLooseObjectPath(id)}`,
          await ctx.compressor.deflate(bytes),
        );

        // Act
        const result = await hasObject(ctx, id);

        // Assert
        expect(result).toBe(true);
      });
    });
  });

  describe('Given an object in no source', () => {
    describe('When probing hasObject', () => {
      it('Then it returns false', async () => {
        // Arrange
        const ctx = await contextWithAlternate();

        // Act
        const result = await hasObject(ctx, 'e'.repeat(40) as ObjectId);

        // Assert
        expect(result).toBe(false);
      });
    });
  });

  describe('Given a pack added to the alternate after the first scan', () => {
    describe('When probing hasObject in recheck mode', () => {
      it('Then it finds the late pack', async () => {
        // Arrange
        const ctx = await contextWithAlternate();
        await hasObject(ctx, 'e'.repeat(40) as ObjectId);
        const [id] = await writeSyntheticPackIn(ctx, ALT_OBJECTS, 'late', [
          { kind: 'base', type: 'blob', content: ENC.encode('arrived later') },
        ]);

        // Act
        const result = await hasObject(ctx, id as ObjectId, { mode: 'recheck' });

        // Assert
        expect(result).toBe(true);
      });
    });
  });
});

describe('hasObject when the midx owner pack is gone', () => {
  const SHARED = new TextEncoder().encode('owner-gone-blob');

  async function midxAssigningSharedBlobToDeletedOwner(ctx: Context): Promise<ObjectId> {
    const [id] = await writeSyntheticPack(ctx, 'A', [
      { kind: 'base', type: 'blob', content: SHARED },
    ]);
    await writeSyntheticPack(ctx, 'B', [
      { kind: 'base', type: 'blob', content: SHARED },
      { kind: 'base', type: 'blob', content: new TextEncoder().encode('other') },
    ]);
    await ctx.fs.rm(`${ctx.layout.gitDir}/objects/pack/pack-B.pack`);
    await ctx.fs.write(
      `${ctx.layout.gitDir}/objects/pack/multi-pack-index`,
      buildMidx({
        version: 1,
        hashVersion: 1,
        digestLength: 20,
        numBaseFiles: 0,
        packNames: ['pack-A.idx', 'pack-B.idx'],
        entries: [{ id: id as ObjectId, packIndex: 1, offset: PACK_HEADER_SIZE }],
      }),
    );
    return id as ObjectId;
  }

  describe('Given another pack holds the object the midx assigns to a deleted pack', () => {
    describe('When probing hasObject in recheck mode', () => {
      it('Then it returns true', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const id = await midxAssigningSharedBlobToDeletedOwner(ctx);

        // Act
        const sut = hasObject;
        const result = await sut(ctx, id, { mode: 'recheck' });

        // Assert
        expect(result).toBe(true);
      });
    });

    describe('When probing hasObject in quick mode', () => {
      it('Then it keeps the false negative, as git has_object does', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const id = await midxAssigningSharedBlobToDeletedOwner(ctx);

        // Act
        const sut = hasObject;
        const result = await sut(ctx, id);

        // Assert
        expect(result).toBe(false);
      });
    });
  });
});
