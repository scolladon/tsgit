import { describe, expect, it, vi } from 'vitest';
import { hasObject } from '../../../../src/application/primitives/has-object.js';
import { getPackRegistry } from '../../../../src/application/primitives/read-object.js';
import type { Blob, ObjectId } from '../../../../src/domain/objects/index.js';
import { serializeObject } from '../../../../src/domain/objects/index.js';
import type { Context } from '../../../../src/ports/context.js';
import type { PromisorRemote } from '../../../../src/ports/promisor.js';
import { buildSeededContext, instrumentedContext } from './fixtures.js';
import { writeSyntheticPack } from './pack-fixture.js';

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
