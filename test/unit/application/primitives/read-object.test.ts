import { afterEach, describe, expect, it, vi } from 'vitest';
import * as configReadMod from '../../../../src/application/primitives/config-read.js';
import { deriveContext } from '../../../../src/application/primitives/derive-context.js';
import { assertRepoSettingsValid } from '../../../../src/application/primitives/internal/repo-settings-gate.js';
import { assertOperationalRepository } from '../../../../src/application/primitives/internal/repo-state.js';
import * as packRegistryMod from '../../../../src/application/primitives/pack-registry.js';
import {
  disposePackRegistry,
  getPackRegistry,
  peekPackRegistry,
  readObject,
  readObjectWithSize,
  readRawObject,
} from '../../../../src/application/primitives/read-object.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import { fileNotFound, type TsgitError } from '../../../../src/domain/error.js';
import type { Blob, ObjectId } from '../../../../src/domain/objects/index.js';
import { EMPTY_TREE_OID, serializeObject } from '../../../../src/domain/objects/index.js';
import type { Context } from '../../../../src/ports/context.js';
import type { PromisorRemote } from '../../../../src/ports/promisor.js';
import {
  buildSeededContext,
  instrumentedContext,
  seedMaxTreeDepth,
  writeLooseWithDeclaredSize,
  writeRawObjectBytes,
} from './fixtures.js';
import { writeSyntheticPack } from './pack-fixture.js';

const seedHead = async (ctx: Context): Promise<void> => {
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, 'ref: refs/heads/main\n');
};

describe('readObject', () => {
  describe('Given a seeded blob', () => {
    describe('When readObject is called', () => {
      it('Then returns the Blob', async () => {
        // Arrange
        const blob: Blob = { type: 'blob', content: new Uint8Array([4, 5, 6]), id: '' as ObjectId };
        const ctx = await buildSeededContext({ objects: [blob] });
        const id = (await ctx.hash.hashHex(serializeObject(blob, ctx.hashConfig))) as ObjectId;

        // Act
        const result = await readObject(ctx, id);

        // Assert
        expect(result.type).toBe('blob');
      });
    });
  });

  describe('Given a missing id and default verifyHash', () => {
    describe('When readObject is called', () => {
      it('Then throws OBJECT_NOT_FOUND', async () => {
        // Arrange
        const ctx = await buildSeededContext();

        // Act
        try {
          await readObject(ctx, 'f'.repeat(40) as ObjectId);
          // Assert
          expect.unreachable();
        } catch (error) {
          expect((error as TsgitError).data.code).toBe('OBJECT_NOT_FOUND');
        }
      });
    });
  });

  describe('Given a corrupted loose file and the default', () => {
    describe('When readObject is called', () => {
      it('Then it returns the bytes', async () => {
        // Arrange
        // Kills the `options?.verifyHash ?? false` BooleanLiteral mutant to
        // `true`: the default must stay unverified, or a corrupt object would
        // be refused instead of served, matching canonical git's unverified
        // cat-file/log/show reads.
        const ctx = await buildSeededContext();
        const fakeId = 'a'.repeat(40) as ObjectId;
        const { computeLooseObjectPath } = await import(
          '../../../../src/domain/storage/loose-path.js'
        );
        const rawBytes = new TextEncoder().encode('blob 3\0xyz');
        const compressed = await ctx.compressor.deflate(rawBytes);
        await ctx.fs.write(
          `${ctx.layout.gitDir}/objects/${computeLooseObjectPath(fakeId)}`,
          compressed,
        );

        // Act
        const result = await readObject(ctx, fakeId);

        // Assert
        expect(result.type).toBe('blob');
      });
    });
  });

  describe('Given verifyHash=true on the same corrupted file', () => {
    describe('When readObject is called', () => {
      it('Then throws OBJECT_HASH_MISMATCH', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const fakeId = 'a'.repeat(40) as ObjectId;
        const { computeLooseObjectPath } = await import(
          '../../../../src/domain/storage/loose-path.js'
        );
        const rawBytes = new TextEncoder().encode('blob 3\0xyz');
        const compressed = await ctx.compressor.deflate(rawBytes);
        await ctx.fs.write(
          `${ctx.layout.gitDir}/objects/${computeLooseObjectPath(fakeId)}`,
          compressed,
        );

        // Act
        try {
          await readObject(ctx, fakeId, { verifyHash: true });
          // Assert
          expect.unreachable();
        } catch (error) {
          expect((error as TsgitError).data.code).toBe('OBJECT_HASH_MISMATCH');
        }
      });
    });
  });

  describe('maxBytes — loose objects', () => {
    describe('Given a loose blob exactly at the cap', () => {
      describe('When readObject is called with maxBytes=size', () => {
        it('Then returns the Blob (inclusive boundary)', async () => {
          // Arrange — 8-byte blob, cap = 8.
          const content = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
          const blob: Blob = { type: 'blob', content, id: '' as ObjectId };
          const ctx = await buildSeededContext({ objects: [blob] });
          const id = (await ctx.hash.hashHex(serializeObject(blob, ctx.hashConfig))) as ObjectId;

          // Act
          const result = await readObject(ctx, id, { maxBytes: 8 });

          // Assert
          expect(result.type).toBe('blob');
          expect((result as Blob).content).toEqual(content);
        });
      });
    });

    describe('Given a loose blob one byte over the cap', () => {
      describe('When readObject is called', () => {
        it('Then throws OBJECT_TOO_LARGE with id, actualSize=9, limit=8', async () => {
          // Arrange
          const content = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]);
          const blob: Blob = { type: 'blob', content, id: '' as ObjectId };
          const ctx = await buildSeededContext({ objects: [blob] });
          const id = (await ctx.hash.hashHex(serializeObject(blob, ctx.hashConfig))) as ObjectId;

          // Act
          try {
            await readObject(ctx, id, { maxBytes: 8 });
            // Assert
            expect.unreachable();
          } catch (error) {
            const data = (error as TsgitError).data;
            expect(data.code).toBe('OBJECT_TOO_LARGE');
            if (data.code === 'OBJECT_TOO_LARGE') {
              expect(data.id).toBe(id);
              expect(data.actualSize).toBe(9);
              expect(data.limit).toBe(8);
            }
          }
        });
      });
    });

    describe('Given maxBytes undefined', () => {
      describe('When readObject is called', () => {
        it('Then no cap applies (regression for default)', async () => {
          // Arrange — large-ish loose blob, no cap.
          const content = new Uint8Array(1024);
          const blob: Blob = { type: 'blob', content, id: '' as ObjectId };
          const ctx = await buildSeededContext({ objects: [blob] });
          const id = (await ctx.hash.hashHex(serializeObject(blob, ctx.hashConfig))) as ObjectId;

          // Act
          const result = await readObject(ctx, id);

          // Assert
          expect((result as Blob).content).toHaveLength(1024);
        });
      });
    });

    describe('Given maxBytes=0 on a non-empty loose blob', () => {
      describe('When readObject is called', () => {
        it('Then throws OBJECT_TOO_LARGE with id, actualSize=1, limit=0', async () => {
          // Arrange
          const blob: Blob = { type: 'blob', content: new Uint8Array([1]), id: '' as ObjectId };
          const ctx = await buildSeededContext({ objects: [blob] });
          const id = (await ctx.hash.hashHex(serializeObject(blob, ctx.hashConfig))) as ObjectId;

          // Act
          try {
            await readObject(ctx, id, { maxBytes: 0 });
            // Assert
            expect.unreachable();
          } catch (error) {
            const data = (error as TsgitError).data;
            expect(data.code).toBe('OBJECT_TOO_LARGE');
            if (data.code !== 'OBJECT_TOO_LARGE') {
              expect.fail(`expected OBJECT_TOO_LARGE, got ${data.code}`);
            }
            expect(data.id).toBe(id);
            expect(data.actualSize).toBe(1);
            expect(data.limit).toBe(0);
          }
        });
      });
    });

    describe('Given a loose blob whose header claims 1 byte and whose body is 8', () => {
      describe('When readObject is called with maxBytes 4', () => {
        it('Then the cap measures the actual 8 bytes and refuses OBJECT_TOO_LARGE', async () => {
          // Arrange — forge a loose blob whose <type> <size>\0 header lies
          // about its payload size. A lying blob is served by its real
          // bytes (git's streaming contract), so a cap that trusted the
          // declared size would wrongly admit it — this pins that the cap
          // measures the ACTUAL 8 bytes instead.
          const ctx = await buildSeededContext();
          const fakeId = 'a'.repeat(40) as ObjectId;
          const { computeLooseObjectPath } = await import(
            '../../../../src/domain/storage/loose-path.js'
          );
          const forged = new TextEncoder().encode('blob 1\0YYYYYYYY'); // declares 1, actual 8 bytes
          const compressed = await ctx.compressor.deflate(forged);
          await ctx.fs.write(
            `${ctx.layout.gitDir}/objects/${computeLooseObjectPath(fakeId)}`,
            compressed,
          );

          // Act
          try {
            await readObject(ctx, fakeId, { maxBytes: 4, verifyHash: false });
            // Assert
            expect.unreachable();
          } catch (error) {
            const data = (error as TsgitError).data;
            expect(data.code).toBe('OBJECT_TOO_LARGE');
            if (data.code !== 'OBJECT_TOO_LARGE') {
              expect.fail(`expected OBJECT_TOO_LARGE, got ${data.code}`);
            }
            expect(data.id).toBe(fakeId);
            expect(data.actualSize).toBe(8);
            expect(data.limit).toBe(4);
          }
        });
      });
    });

    describe('Given a loose commit whose header size claim disagrees with its body length', () => {
      describe('When readObject is called', () => {
        it('Then it still throws INVALID_OBJECT_HEADER (only a blob takes the streaming contract)', async () => {
          // Arrange
          const ctx = await buildSeededContext();
          const fakeId = 'b'.repeat(40) as ObjectId;
          const { computeLooseObjectPath } = await import(
            '../../../../src/domain/storage/loose-path.js'
          );
          const forged = new TextEncoder().encode('commit 400\0short body'); // declares 400, actual 10
          const compressed = await ctx.compressor.deflate(forged);
          await ctx.fs.write(
            `${ctx.layout.gitDir}/objects/${computeLooseObjectPath(fakeId)}`,
            compressed,
          );

          // Act
          try {
            await readObject(ctx, fakeId);
            // Assert
            expect.unreachable();
          } catch (error) {
            const data = (error as TsgitError).data;
            expect(data.code).toBe('INVALID_OBJECT_HEADER');
            if (data.code === 'INVALID_OBJECT_HEADER') {
              expect(data.reason).toBe('size mismatch: header says 400, actual content is 10');
            }
          }
        });
      });
    });
  });

  describe('maxBytes — pack base entries', () => {
    describe('Given a packed blob base entry at the cap', () => {
      describe('When readObject is called with maxBytes=size', () => {
        it('Then returns the Blob', async () => {
          // Arrange — 8-byte pack base entry.
          const content = new TextEncoder().encode('abcdefgh');
          const ctx = await buildSeededContext();
          const [id] = await writeSyntheticPack(ctx, 'cap-boundary', [
            { kind: 'base', type: 'blob', content },
          ]);

          // Act
          const result = await readObject(ctx, id as ObjectId, { maxBytes: 8 });

          // Assert
          expect(result.type).toBe('blob');
          expect((result as Blob).content).toEqual(content);
        });
      });
    });

    describe('Given a packed blob base entry one byte over the cap', () => {
      describe('When readObject is called', () => {
        it('Then throws OBJECT_TOO_LARGE pre-inflate', async () => {
          // Arrange
          const content = new TextEncoder().encode('abcdefghi'); // 9 bytes
          const ctx = await buildSeededContext();
          const [id] = await writeSyntheticPack(ctx, 'cap-over', [
            { kind: 'base', type: 'blob', content },
          ]);

          // Act
          try {
            await readObject(ctx, id as ObjectId, { maxBytes: 8 });
            // Assert
            expect.unreachable();
          } catch (error) {
            const data = (error as TsgitError).data;
            expect(data.code).toBe('OBJECT_TOO_LARGE');
            if (data.code === 'OBJECT_TOO_LARGE') {
              expect(data.actualSize).toBe(9);
              expect(data.limit).toBe(8);
            }
          }
        });
      });
    });
  });

  describe('maxBytes — pack delta-resolved entries', () => {
    describe('Given a delta-resolved blob whose reconstructed size exceeds the cap', () => {
      describe('When readObject is called', () => {
        it('Then throws OBJECT_TOO_LARGE post-apply', async () => {
          // Arrange — base of 4 bytes, delta reconstructs a 9-byte target.
          const baseContent = new TextEncoder().encode('abcd');
          const targetContent = new TextEncoder().encode('abcdefghi');
          const ctx = await buildSeededContext();
          const ids = await writeSyntheticPack(ctx, 'cap-delta', [
            { kind: 'base', type: 'blob', content: baseContent },
            { kind: 'ofs-delta', baseIndex: 0, targetContent },
          ]);
          const deltaId = ids[1] as ObjectId;

          // Act
          try {
            await readObject(ctx, deltaId, { maxBytes: 8 });
            // Assert
            expect.unreachable();
          } catch (error) {
            const data = (error as TsgitError).data;
            expect(data.code).toBe('OBJECT_TOO_LARGE');
            if (data.code === 'OBJECT_TOO_LARGE') {
              expect(data.actualSize).toBe(9);
              expect(data.limit).toBe(8);
            }
          }
        });
      });
    });

    describe('Given a delta-resolved blob whose reconstructed size equals the cap', () => {
      describe('When readObject is called', () => {
        it('Then returns the Blob (boundary)', async () => {
          // Arrange — target is 8 bytes, cap is 8.
          const baseContent = new TextEncoder().encode('abcd');
          const targetContent = new TextEncoder().encode('abcdefgh');
          const ctx = await buildSeededContext();
          const ids = await writeSyntheticPack(ctx, 'cap-delta-eq', [
            { kind: 'base', type: 'blob', content: baseContent },
            { kind: 'ofs-delta', baseIndex: 0, targetContent },
          ]);
          const deltaId = ids[1] as ObjectId;

          // Act
          const result = await readObject(ctx, deltaId, { maxBytes: 8 });

          // Assert
          expect((result as Blob).content).toEqual(targetContent);
        });
      });
    });
  });

  describe('Given two readObject calls on the same context', () => {
    describe('When readObject is called twice', () => {
      it('Then the pack registry is cached (readdir runs at most once)', async () => {
        // Arrange
        // The WeakMap<Context, PackRegistry> cache in read-object.ts avoids
        // re-scanning the pack directory across many lookups during a walk.
        // If the guard is broken, readdir runs once per readObject call.
        const ctx = await buildSeededContext();
        // Seed the pack dir so readdir has something to enumerate.
        await ctx.fs.write('/repo/.git/objects/pack/.gitkeep', new Uint8Array([0]));
        let readdirCount = 0;
        const originalReaddir = ctx.fs.readdir.bind(ctx.fs);
        const wrapped = {
          ...ctx,
          fs: {
            ...ctx.fs,
            readdir: async (path: string) => {
              if (path === '/repo/.git/objects/pack') readdirCount += 1;
              return originalReaddir(path);
            },
          },
        };

        // Act — two readObject calls on the same wrapped context.
        const missingId = 'f'.repeat(40) as ObjectId;
        for (let i = 0; i < 2; i += 1) {
          try {
            await readObject(wrapped, missingId);
          } catch {
            // OBJECT_NOT_FOUND — expected.
          }
        }

        // Assert — at most one readdir on the pack dir (cache is honored).
        expect(readdirCount).toBeLessThanOrEqual(1);
      });
    });
  });

  describe('Given a pack registry populated through the opening Context', () => {
    describe('When read through a Context derived by deriveContext (same session)', () => {
      it('Then the derived Context hits the shared registry (readdir runs at most once)', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await ctx.fs.write('/repo/.git/objects/pack/.gitkeep', new Uint8Array([0]));
        const missingId = 'f'.repeat(40) as ObjectId;
        try {
          await readObject(ctx, missingId);
        } catch {
          // OBJECT_NOT_FOUND — expected; this is only priming the registry.
        }
        // No fields change — a no-op derivation still keeps the session,
        // and (unlike the other tests here) leaves `fs` identical too, so a
        // spy on the SHARED object observes calls made through either.
        const derived = deriveContext(ctx, {});
        const spy = vi.spyOn(ctx.fs, 'readdir');

        // Act
        try {
          await readObject(derived, missingId);
        } catch {
          // OBJECT_NOT_FOUND — expected.
        }

        // Assert — session unchanged ⇒ same registry, no re-scan.
        expect(derived.session).toBe(ctx.session);
        expect(spy).not.toHaveBeenCalledWith('/repo/.git/objects/pack');
        spy.mockRestore();
      });
    });
  });

  describe('Given a pack registry populated through a Context derived by deriveContext (same session)', () => {
    describe('When read through the opening Context', () => {
      it('Then the opening Context hits the shared registry (readdir runs at most once)', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await ctx.fs.write('/repo/.git/objects/pack/.gitkeep', new Uint8Array([0]));
        const derived = deriveContext(ctx, { deltaCache: ctx.deltaCache });
        const missingId = 'f'.repeat(40) as ObjectId;
        try {
          await readObject(derived, missingId);
        } catch {
          // OBJECT_NOT_FOUND — expected; this is only priming the registry.
        }
        let readdirCount = 0;
        const originalReaddir = ctx.fs.readdir.bind(ctx.fs);
        const instrumented: Context = {
          ...ctx,
          fs: {
            ...ctx.fs,
            readdir: async (path: string) => {
              if (path === '/repo/.git/objects/pack') readdirCount += 1;
              return originalReaddir(path);
            },
          },
        };

        // Act
        try {
          await readObject(instrumented, missingId);
        } catch {
          // OBJECT_NOT_FOUND — expected.
        }

        // Assert
        expect(readdirCount).toBe(0);
      });
    });
  });

  describe('Given a Context whose session was minted fresh by a repository-boundary derivation', () => {
    describe('When read through it', () => {
      it('Then the pack registry is NOT shared with the opening Context (readdir runs again)', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await ctx.fs.write('/repo/.git/objects/pack/.gitkeep', new Uint8Array([0]));
        const missingId = 'f'.repeat(40) as ObjectId;
        try {
          await readObject(ctx, missingId);
        } catch {
          // OBJECT_NOT_FOUND — expected; this is only priming the registry.
        }
        let readdirCount = 0;
        const originalReaddir = ctx.fs.readdir.bind(ctx.fs);
        const fresh = deriveContext(ctx, {
          layout: { ...ctx.layout, gitDir: '/elsewhere/.git' },
          fs: {
            ...ctx.fs,
            readdir: async (path: string) => {
              if (path === '/elsewhere/.git/objects/pack') readdirCount += 1;
              return originalReaddir('/repo/.git/objects/pack');
            },
            // `/elsewhere` sits outside the memory adapter's sandboxed root,
            // so it can never resolve — `readConfig` (now read at
            // registry-construction time, for `core.deltaBaseCacheLimit`)
            // must see the same "no config file" absence a real unopened
            // gitDir would produce, not the sandbox's PERMISSION_DENIED.
            stat: async (path: string) => {
              if (path === '/elsewhere/.git/config') throw fileNotFound(path);
              return ctx.fs.stat(path);
            },
            readUtf8: async (path: string) => {
              if (path === '/elsewhere/.git/config') throw fileNotFound(path);
              return ctx.fs.readUtf8(path);
            },
          },
        });

        // Act
        try {
          await readObject(fresh, missingId);
        } catch {
          // OBJECT_NOT_FOUND — expected.
        }

        // Assert — a fresh session starts the registry cache cold.
        expect(fresh.session).not.toBe(ctx.session);
        expect(readdirCount).toBe(1);
      });
    });
  });
});

describe('Given a fresh session and two concurrent first readObject calls', () => {
  describe('When neither call has settled before the other starts', () => {
    it('Then only one pack registry is constructed for the session', async () => {
      // Arrange
      const blob: Blob = { type: 'blob', content: new Uint8Array([7]), id: '' as ObjectId };
      const ctx = await buildSeededContext({ objects: [blob] });
      const id = (await ctx.hash.hashHex(serializeObject(blob, ctx.hashConfig))) as ObjectId;
      const spy = vi.spyOn(packRegistryMod, 'createPackRegistry');

      // Act
      await Promise.all([readObject(ctx, id), readObject(ctx, id)]);

      // Assert
      expect(spy).toHaveBeenCalledTimes(1);
      spy.mockRestore();
    });
  });
});

describe('getPackRegistry — repo-settings class boundary', () => {
  describe('Given core.maxTreeDepth = 2.5 and a loose object fixture', () => {
    describe('When readObject is called', () => {
      it('Then throws CONFIG_BAD_NUMERIC_VALUE before any registry construction', async () => {
        // Arrange
        const blob: Blob = { type: 'blob', content: new Uint8Array([1]), id: '' as ObjectId };
        const ctx = await buildSeededContext({ objects: [blob] });
        const id = (await ctx.hash.hashHex(serializeObject(blob, ctx.hashConfig))) as ObjectId;
        await seedMaxTreeDepth(ctx, '2.5');
        const spy = vi.spyOn(packRegistryMod, 'createPackRegistry');

        // Act
        let caught: unknown;
        try {
          await readObject(ctx, id);
          expect.unreachable();
        } catch (error) {
          caught = error;
        }

        // Assert
        expect((caught as TsgitError).data.code).toBe('CONFIG_BAD_NUMERIC_VALUE');
        expect(spy).not.toHaveBeenCalled();
        spy.mockRestore();
      });
    });
  });

  describe('Given core.maxTreeDepth = 2.5 and a packed object fixture', () => {
    describe('When readObject is called', () => {
      it('Then throws CONFIG_BAD_NUMERIC_VALUE', async () => {
        // Arrange
        const content = new TextEncoder().encode('abcdefgh');
        const ctx = await buildSeededContext();
        const [id] = await writeSyntheticPack(ctx, 'settings-gate', [
          { kind: 'base', type: 'blob', content },
        ]);
        await seedMaxTreeDepth(ctx, '2.5');

        // Act
        let caught: unknown;
        try {
          await readObject(ctx, id as ObjectId);
          expect.unreachable();
        } catch (error) {
          caught = error;
        }

        // Assert
        expect((caught as TsgitError).data.code).toBe('CONFIG_BAD_NUMERIC_VALUE');
      });
    });
  });

  describe('Given a settled session (a prior readObject already resolved the repo-settings class)', () => {
    describe('When readObject is called a second time', () => {
      it('Then no finder re-runs — the settled fast path skips the check', async () => {
        // Arrange
        const blob: Blob = { type: 'blob', content: new Uint8Array([2]), id: '' as ObjectId };
        const ctx = await buildSeededContext({ objects: [blob] });
        const id = (await ctx.hash.hashHex(serializeObject(blob, ctx.hashConfig))) as ObjectId;
        await readObject(ctx, id);
        const spy = vi.spyOn(configReadMod, 'findLastInvalidMaxTreeDepth');

        // Act
        await readObject(ctx, id);

        // Assert
        expect(spy).not.toHaveBeenCalled();
        spy.mockRestore();
      });
    });
  });

  describe('Given a bare Context with cacheBudgets.deltaBaseCacheMaxBytes supplied and no gate opened', () => {
    describe('When readObject runs twice', () => {
      it('Then the first read issues exactly one stat and one readUtf8 of config, and the finder runs once across both reads', async () => {
        // Arrange — the finder spy is installed BEFORE the first read, so its
        // count covers the compute that read triggers.
        const blob: Blob = { type: 'blob', content: new Uint8Array([10]), id: '' as ObjectId };
        const base = await buildSeededContext({ objects: [blob] });
        const id = (await base.hash.hashHex(serializeObject(blob, base.hashConfig))) as ObjectId;
        const withBudget: Context = { ...base, cacheBudgets: { deltaBaseCacheMaxBytes: 2048 } };
        const { ctx, calls } = instrumentedContext(withBudget);
        const spy = vi.spyOn(configReadMod, 'findLastInvalidMaxTreeDepth');
        const configPath = `${ctx.layout.gitDir}/config`;

        // Act
        await readObject(ctx, id);
        const firstReadConfigCalls = calls().filter((c) => c.path === configPath);
        await readObject(ctx, id);

        // Assert
        expect(firstReadConfigCalls).toEqual([
          { method: 'stat', path: configPath },
          { method: 'readUtf8', path: configPath },
        ]);
        expect(spy).toHaveBeenCalledTimes(1);
        spy.mockRestore();
      });
    });
  });

  describe('Given a bare Context with no cacheBudgets override and no gate opened', () => {
    describe('When readObject runs twice', () => {
      it('Then the first read issues stat, readUtf8, stat of config, and the finder runs once across both reads', async () => {
        // Arrange
        const blob: Blob = { type: 'blob', content: new Uint8Array([11]), id: '' as ObjectId };
        const base = await buildSeededContext({ objects: [blob] });
        const id = (await base.hash.hashHex(serializeObject(blob, base.hashConfig))) as ObjectId;
        const { ctx, calls } = instrumentedContext(base);
        const spy = vi.spyOn(configReadMod, 'findLastInvalidMaxTreeDepth');
        const configPath = `${ctx.layout.gitDir}/config`;

        // Act
        await readObject(ctx, id);
        const firstReadConfigCalls = calls().filter((c) => c.path === configPath);
        await readObject(ctx, id);

        // Assert
        expect(firstReadConfigCalls).toEqual([
          { method: 'stat', path: configPath },
          { method: 'readUtf8', path: configPath },
          { method: 'stat', path: configPath },
        ]);
        expect(spy).toHaveBeenCalledTimes(1);
        spy.mockRestore();
      });
    });
  });

  describe('Given readObjectWithSize as the first touch of a fresh session', () => {
    describe('When readObjectWithSize is followed by readObject', () => {
      it('Then the repo-settings finder runs exactly once across both calls', async () => {
        // Arrange
        const blob: Blob = { type: 'blob', content: new Uint8Array([12]), id: '' as ObjectId };
        const ctx = await buildSeededContext({ objects: [blob] });
        const id = (await ctx.hash.hashHex(serializeObject(blob, ctx.hashConfig))) as ObjectId;
        const spy = vi.spyOn(configReadMod, 'findLastInvalidMaxTreeDepth');

        // Act
        await readObjectWithSize(ctx, id);
        await readObject(ctx, id);

        // Assert
        expect(spy).toHaveBeenCalledTimes(1);
        spy.mockRestore();
      });
    });
  });

  describe('Given the operational gate has already opened an epoch for this command', () => {
    describe('When the first readObject follows', () => {
      it('Then it issues zero stat of config — the registry read and the repo-settings check both ride the trusted entry', async () => {
        // Arrange — the gate runs on the UNWRAPPED context; instrumentation
        // starts only after it, so the count reflects readObject alone.
        const blob: Blob = { type: 'blob', content: new Uint8Array([3]), id: '' as ObjectId };
        const base = await buildSeededContext({ objects: [blob] });
        await seedHead(base);
        const id = (await base.hash.hashHex(serializeObject(blob, base.hashConfig))) as ObjectId;
        await assertOperationalRepository(base);
        const { ctx, calls } = instrumentedContext(base);

        // Act
        await readObject(ctx, id);

        // Assert
        const configStats = calls().filter(
          (c) => c.method === 'stat' && c.path === `${ctx.layout.gitDir}/config`,
        );
        expect(configStats).toHaveLength(0);
      });
    });
  });
});

describe('peekPackRegistry', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Given a fresh session that has never constructed a registry', () => {
    describe('When checked', () => {
      it('Then returns undefined — nothing to serve synchronously yet', async () => {
        // Arrange
        const ctx = await buildSeededContext();

        // Act
        const result = peekPackRegistry(ctx);

        // Assert
        expect(result).toBeUndefined();
      });
    });
  });

  describe('Given a session warmed by a prior getPackRegistry call', () => {
    describe('When checked', () => {
      it('Then returns the SAME registry getPackRegistry resolves to, built exactly once', async () => {
        // Arrange — the spy is installed BEFORE the warming call, so its
        // count covers the warm-up too: one construction for the pair pins
        // single-flight, where a spy installed afterwards could only ever
        // observe the zero calls a synchronous peek makes by construction.
        const ctx = await buildSeededContext();
        const spy = vi.spyOn(packRegistryMod, 'createPackRegistry');

        // Act
        const warm = await getPackRegistry(ctx);
        const result = peekPackRegistry(ctx);

        // Assert
        expect(result).toBe(warm);
        expect(spy).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe('Given a warm session whose config is then poisoned (the repo-settings verdict is superseded)', () => {
    describe('When checked', () => {
      it('Then returns undefined instead of serving the stale registry', async () => {
        // Arrange
        const blob: Blob = { type: 'blob', content: new Uint8Array([9]), id: '' as ObjectId };
        const ctx = await buildSeededContext({ objects: [blob] });
        const id = (await ctx.hash.hashHex(serializeObject(blob, ctx.hashConfig))) as ObjectId;
        await readObject(ctx, id);
        expect(peekPackRegistry(ctx)).toBeDefined();

        // Act — poison drops the repo-settings verdict memo (invalidateConfigCache).
        await seedMaxTreeDepth(ctx, '2.5');

        // Assert
        expect(peekPackRegistry(ctx)).toBeUndefined();
      });
    });
  });
});

describe('disposePackRegistry', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Given a construction in flight that then rejects', () => {
    describe('When disposePackRegistry races the rejection', () => {
      it('Then dispose resolves without throwing, and the original caller still observes the rejection', async () => {
        // Arrange — settle the repo-settings verdict WITHOUT ever touching
        // the pack registry, so getPackRegistry's own check below is
        // synchronous (the fast path), and the memo it creates is the first
        // and only one for this session.
        const ctx = await buildSeededContext();
        await seedHead(ctx);
        await assertRepoSettingsValid(ctx);
        const failure = new Error('construction boom');
        vi.spyOn(packRegistryMod, 'createPackRegistry').mockRejectedValue(failure);

        // Act — start the (soon-to-reject) construction, then race dispose
        // against it before the rejection has settled.
        const pending = getPackRegistry(ctx);
        pending.catch(() => {
          // Expected — asserted below via `.rejects`; this only prevents an
          // unhandled-rejection warning from the head start above.
        });
        const disposal = disposePackRegistry(ctx);

        // Assert
        await expect(disposal).resolves.toBeUndefined();
        await expect(pending).rejects.toBe(failure);
      });
    });
  });

  describe('Given no registry was ever constructed for the session', () => {
    describe('When disposePackRegistry is called', () => {
      it('Then resolves without constructing one', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const spy = vi.spyOn(packRegistryMod, 'createPackRegistry');

        // Act + Assert
        await expect(disposePackRegistry(ctx)).resolves.toBeUndefined();
        expect(spy).not.toHaveBeenCalled();
      });
    });
  });
});

describe('readObjectWithSize', () => {
  describe('Given an honest loose blob', () => {
    describe('When readObjectWithSize is called', () => {
      it('Then size equals the content byte length', async () => {
        // Arrange
        const content = new TextEncoder().encode('hello world');
        const ctx = await buildSeededContext();
        const id = await writeRawObjectBytes(ctx, 'blob', content);

        // Act
        const result = await readObjectWithSize(ctx, id);

        // Assert
        expect(result.object.type).toBe('blob');
        expect(result.size).toBe(content.byteLength);
      });
    });
  });

  describe('Given a loose blob whose header size claim disagrees with its body length', () => {
    describe('When readObjectWithSize is called', () => {
      it('Then size equals the stored claim, not the body length', async () => {
        // Arrange
        const content = new TextEncoder().encode('hello world!');
        const ctx = await buildSeededContext();
        const id = await writeRawObjectBytes(ctx, 'blob', content);
        await writeLooseWithDeclaredSize(ctx, id, 'blob', 5, content);

        // Act
        const result = await readObjectWithSize(ctx, id);

        // Assert
        expect(result.object.type).toBe('blob');
        expect(result.size).toBe(5);
      });
    });
  });

  describe('Given a missing id with no promisor attached', () => {
    describe('When readObjectWithSize is called', () => {
      it('Then it throws OBJECT_NOT_FOUND with the requested id', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const missingId = 'f'.repeat(40) as ObjectId;

        // Act
        try {
          await readObjectWithSize(ctx, missingId);
          // Assert
          expect.unreachable();
        } catch (error) {
          const data = (error as TsgitError).data;
          expect(data.code).toBe('OBJECT_NOT_FOUND');
          if (data.code === 'OBJECT_NOT_FOUND') {
            expect(data.id).toBe(missingId);
          }
        }
      });
    });
  });
});

describe('readRawObject', () => {
  describe('Given a seeded blob', () => {
    describe('When readRawObject is called', () => {
      it('Then returns the pre-parse { type, content }', async () => {
        // Arrange
        const blob: Blob = { type: 'blob', content: new Uint8Array([4, 5, 6]), id: '' as ObjectId };
        const ctx = await buildSeededContext({ objects: [blob] });
        const id = (await ctx.hash.hashHex(serializeObject(blob, ctx.hashConfig))) as ObjectId;

        // Act
        const result = await readRawObject(ctx, id);

        // Assert
        expect(result.type).toBe('blob');
        expect(result.content).toEqual(blob.content);
      });
    });
  });

  describe('Given a seeded blob', () => {
    describe('When readRawObject is called', () => {
      it('Then the result carries no bytes key', async () => {
        // Arrange
        const blob: Blob = { type: 'blob', content: new Uint8Array([4, 5, 6]), id: '' as ObjectId };
        const ctx = await buildSeededContext({ objects: [blob] });
        const id = (await ctx.hash.hashHex(serializeObject(blob, ctx.hashConfig))) as ObjectId;

        // Act
        const result = await readRawObject(ctx, id);

        // Assert
        expect('bytes' in result).toBe(false);
      });
    });
  });

  describe('Given the virtual empty-tree oid', () => {
    describe('When readRawObject is called', () => {
      it('Then returns { type: "tree", content } with zero-length content', async () => {
        // Arrange
        const ctx = await buildSeededContext();

        // Act
        const result = await readRawObject(ctx, EMPTY_TREE_OID);

        // Assert
        expect(result.type).toBe('tree');
        expect(result.content).toHaveLength(0);
      });
    });
  });

  describe('Given a packed blob base entry', () => {
    describe('When readRawObject is called', () => {
      it('Then returns content byte-identical to what readObject parsed from', async () => {
        // Arrange
        const content = new TextEncoder().encode('abcdefgh');
        const ctx = await buildSeededContext();
        const [id] = await writeSyntheticPack(ctx, 'raw-packed-base', [
          { kind: 'base', type: 'blob', content },
        ]);

        // Act
        const result = await readRawObject(ctx, id as ObjectId);

        // Assert
        expect(result.type).toBe('blob');
        expect(result.content).toEqual(content);
      });
    });
  });

  describe('Given a packed delta-chain blob', () => {
    describe('When readRawObject is called', () => {
      it('Then returns the fully-resolved delta content', async () => {
        // Arrange
        const baseContent = new TextEncoder().encode('abcd');
        const targetContent = new TextEncoder().encode('abcdefgh');
        const ctx = await buildSeededContext();
        const ids = await writeSyntheticPack(ctx, 'raw-packed-delta', [
          { kind: 'base', type: 'blob', content: baseContent },
          { kind: 'ofs-delta', baseIndex: 0, targetContent },
        ]);
        const deltaId = ids[1] as ObjectId;

        // Act
        const result = await readRawObject(ctx, deltaId);

        // Assert
        expect(result.type).toBe('blob');
        expect(result.content).toEqual(targetContent);
      });
    });
  });

  describe('Given a packed delta-chain blob already resolved by an earlier read', () => {
    describe('When readRawObject reads it again', () => {
      it('Then the second read is served from the delta cache (a cache hit, not a re-resolve)', async () => {
        // Arrange
        const baseContent = new TextEncoder().encode('abcd');
        const targetContent = new TextEncoder().encode('abcdefgh');
        const ctx = await buildSeededContext();
        const ids = await writeSyntheticPack(ctx, 'raw-packed-cache', [
          { kind: 'base', type: 'blob', content: baseContent },
          { kind: 'ofs-delta', baseIndex: 0, targetContent },
        ]);
        const deltaId = ids[1] as ObjectId;
        await readRawObject(ctx, deltaId);
        const cacheGetSpy = vi.spyOn(ctx.deltaCache, 'get');
        const readSliceSpy = vi.spyOn(ctx.fs, 'readSlice');

        // Act
        const result = await readRawObject(ctx, deltaId);

        // Assert — the second read hits the cache directly (a defined value
        // for this exact id), rather than falling through to loose/pack lookup.
        expect(cacheGetSpy).toHaveBeenCalledWith(deltaId);
        expect(cacheGetSpy.mock.results[0]?.value).toBeDefined();
        // Assert — proves "not a re-resolve" structurally: the pack chain
        // walker's own read (readSlice, used to fetch pack entry bytes) is
        // never re-entered on the cached read.
        expect(readSliceSpy).not.toHaveBeenCalled();
        expect(result.type).toBe('blob');
        expect(result.content).toEqual(targetContent);
        cacheGetSpy.mockRestore();
        readSliceSpy.mockRestore();
      });
    });
  });

  describe('Given a loose blob one byte over the cap', () => {
    describe('When readRawObject is called with maxBytes', () => {
      it('Then throws OBJECT_TOO_LARGE with id, actualSize=9, limit=8', async () => {
        // Arrange
        const content = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]);
        const blob: Blob = { type: 'blob', content, id: '' as ObjectId };
        const ctx = await buildSeededContext({ objects: [blob] });
        const id = (await ctx.hash.hashHex(serializeObject(blob, ctx.hashConfig))) as ObjectId;

        // Act
        try {
          await readRawObject(ctx, id, { maxBytes: 8 });
          // Assert
          expect.unreachable();
        } catch (error) {
          const data = (error as TsgitError).data;
          expect(data.code).toBe('OBJECT_TOO_LARGE');
          if (data.code === 'OBJECT_TOO_LARGE') {
            expect(data.actualSize).toBe(9);
            expect(data.limit).toBe(8);
          }
        }
      });
    });
  });

  describe('Given a corrupted loose file and the default', () => {
    describe('When readRawObject is called', () => {
      it('Then it returns the unverified raw content', async () => {
        // Arrange
        // Kills the `options?.verifyHash ?? false` BooleanLiteral mutant to
        // `true`: the default must stay unverified.
        const ctx = await buildSeededContext();
        const fakeId = 'a'.repeat(40) as ObjectId;
        const { computeLooseObjectPath } = await import(
          '../../../../src/domain/storage/loose-path.js'
        );
        const rawBytes = new TextEncoder().encode('blob 3\0xyz');
        const compressed = await ctx.compressor.deflate(rawBytes);
        await ctx.fs.write(
          `${ctx.layout.gitDir}/objects/${computeLooseObjectPath(fakeId)}`,
          compressed,
        );

        // Act
        const result = await readRawObject(ctx, fakeId);

        // Assert
        expect(result.type).toBe('blob');
        expect(new TextDecoder().decode(result.content)).toBe('xyz');
      });
    });
  });

  describe('Given verifyHash=true on the same corrupted file', () => {
    describe('When readRawObject is called', () => {
      it('Then throws OBJECT_HASH_MISMATCH with expected/actual', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const fakeId = 'a'.repeat(40) as ObjectId;
        const { computeLooseObjectPath } = await import(
          '../../../../src/domain/storage/loose-path.js'
        );
        const rawBytes = new TextEncoder().encode('blob 3\0xyz');
        const compressed = await ctx.compressor.deflate(rawBytes);
        await ctx.fs.write(
          `${ctx.layout.gitDir}/objects/${computeLooseObjectPath(fakeId)}`,
          compressed,
        );

        // Act
        try {
          await readRawObject(ctx, fakeId, { verifyHash: true });
          // Assert
          expect.unreachable();
        } catch (error) {
          const data = (error as TsgitError).data;
          expect(data.code).toBe('OBJECT_HASH_MISMATCH');
          if (data.code === 'OBJECT_HASH_MISMATCH') {
            const actualHash = await ctx.hash.hashHex(rawBytes);
            expect(data.expected).toBe(fakeId);
            expect(data.actual).toBe(actualHash);
          }
        }
      });
    });
  });

  describe('Given a missing object and a promisor that supplies it', () => {
    describe('When readRawObject is called', () => {
      it('Then it is lazy-fetched exactly once', async () => {
        // Arrange
        const base = await buildSeededContext();
        const blob: Blob = { type: 'blob', content: new Uint8Array([7, 8, 9]), id: '' as ObjectId };
        const id = (await base.hash.hashHex(serializeObject(blob, base.hashConfig))) as ObjectId;
        const calls = { count: 0 };
        let ctx!: Context;
        ctx = {
          ...base,
          promisor: {
            fetch: async (oids) => {
              calls.count += 1;
              await writeObject(ctx, blob);
              return { attempted: true, requested: oids.length, fetched: oids.length };
            },
          },
        };

        // Act
        const result = await readRawObject(ctx, id);

        // Assert
        expect(result.type).toBe('blob');
        expect(result.content).toEqual(blob.content);
        expect(calls.count).toBe(1);
      });
    });
  });

  describe('Given a promisor reporting attempted=false', () => {
    describe('When readRawObject misses', () => {
      it('Then the original OBJECT_NOT_FOUND is rethrown without a re-resolve', async () => {
        // Arrange
        const base = await buildSeededContext();
        const ctx: Context = {
          ...base,
          promisor: {
            fetch: async (oids) => ({ attempted: false, requested: oids.length, fetched: 0 }),
          },
        };

        // Act
        try {
          await readRawObject(ctx, 'f'.repeat(40) as ObjectId);
          // Assert
          expect.unreachable();
        } catch (error) {
          expect((error as TsgitError).data.code).toBe('OBJECT_NOT_FOUND');
        }
      });
    });
  });
});

describe('readObject — lazy-fetch (partial clone)', () => {
  const computeLooseObjectPathOf = async (id: ObjectId): Promise<string> => {
    const { computeLooseObjectPath } = await import('../../../../src/domain/storage/loose-path.js');
    return computeLooseObjectPath(id);
  };

  /**
   * A promisor whose `fetch` writes `blob` loose via the real `writeObject`
   * primitive (not a raw `ctx.fs.write`) so the loose-oid membership cache is
   * invalidated exactly as it would be for any other loose write. `getCtx` is
   * a deferred-binding thunk — mirroring the trick `openRepository` uses to
   * wire a promisor closing over the very `Context` that carries it — since
   * the final `ctx` (built as `{ ...base, promisor }`) does not exist yet at
   * the point `supplyingPromisor` is called. Writing through `base` directly
   * would invalidate a DIFFERENT cache entry (`base` and `ctx` are distinct
   * objects, even though they share the same underlying `fs`), leaving the
   * retry's cache stale.
   */
  const supplyingPromisor = (
    blob: Blob,
    calls: { count: number },
    getCtx: () => Context,
  ): PromisorRemote => ({
    fetch: async (oids) => {
      calls.count += 1;
      await writeObject(getCtx(), blob);
      return { attempted: true, requested: oids.length, fetched: oids.length };
    },
  });

  describe('Given a missing object and a promisor that supplies it', () => {
    describe('When readObject', () => {
      it('Then it is lazy-fetched', async () => {
        // Arrange
        const base = await buildSeededContext();
        const blob: Blob = { type: 'blob', content: new Uint8Array([7, 8, 9]), id: '' as ObjectId };
        const id = (await base.hash.hashHex(serializeObject(blob, base.hashConfig))) as ObjectId;
        const calls = { count: 0 };
        let ctx!: Context;
        ctx = { ...base, promisor: supplyingPromisor(blob, calls, () => ctx) };

        // Act
        const result = await readObject(ctx, id);

        // Assert
        expect(result.type).toBe('blob');
        expect(calls.count).toBe(1);
      });
    });
  });

  describe('Given a missing object the promisor supplies inside a NEW pack (not loose)', () => {
    describe('When readObject lazy-fetches', () => {
      it('Then the retry finds it — the registry is refreshed before the re-resolve', async () => {
        // Arrange — the fetched object lands in a pack written straight to
        // the filesystem (bypassing writeObject), so the pack registry's
        // cached pack list is stale until `registry.refresh()` runs; a
        // dropped refresh would leave the retry's `registry.lookup(id)`
        // blind to the new pack and rethrow OBJECT_NOT_FOUND.
        const base = await buildSeededContext();
        const blob: Blob = { type: 'blob', content: new Uint8Array([1, 2, 3]), id: '' as ObjectId };
        const id = (await base.hash.hashHex(serializeObject(blob, base.hashConfig))) as ObjectId;
        let ctx!: Context;
        const promisor: PromisorRemote = {
          fetch: async (oids) => {
            await writeSyntheticPack(ctx, 'lazy-fetch-refresh', [
              { kind: 'base', type: 'blob', content: blob.content },
            ]);
            return { attempted: true, requested: oids.length, fetched: oids.length };
          },
        };
        ctx = { ...base, promisor };

        // Act
        const result = await readObject(ctx, id);

        // Assert
        expect(result.type).toBe('blob');
      });
    });
  });

  describe('Given a missing object supplied by a promisor that records its request', () => {
    describe('When readObject lazy-fetches', () => {
      it('Then the promisor is asked for exactly the missing oid', async () => {
        // Arrange — capture the oid batch handed to the promisor so an empty
        // request (fetching nothing) is distinguishable from the real one.
        const base = await buildSeededContext();
        const blob: Blob = { type: 'blob', content: new Uint8Array([4, 5, 6]), id: '' as ObjectId };
        const id = (await base.hash.hashHex(serializeObject(blob, base.hashConfig))) as ObjectId;
        const requested: ReadonlyArray<ObjectId>[] = [];
        let ctx!: Context;
        const promisor: PromisorRemote = {
          fetch: async (oids) => {
            requested.push([...oids]);
            // Writes through `ctx` (not `base`) so the loose-oid cache the
            // retry reads through is the one invalidated — see
            // `supplyingPromisor`'s doc comment above for why.
            await writeObject(ctx, blob);
            return { attempted: true, requested: oids.length, fetched: oids.length };
          },
        };
        ctx = { ...base, promisor };

        // Act
        await readObject(ctx, id);

        // Assert — the exact missing oid was requested, not an empty batch.
        expect(requested).toEqual([[id]]);
      });
    });
  });

  describe('Given a promisor reporting attempted=false', () => {
    describe('When readObject misses', () => {
      it('Then OBJECT_NOT_FOUND is thrown', async () => {
        // Arrange
        const base = await buildSeededContext();
        const ctx: Context = {
          ...base,
          promisor: {
            fetch: async (oids) => ({ attempted: false, requested: oids.length, fetched: 0 }),
          },
        };

        // Act
        try {
          await readObject(ctx, 'f'.repeat(40) as ObjectId);
          // Assert
          expect.unreachable();
        } catch (error) {
          expect((error as TsgitError).data.code).toBe('OBJECT_NOT_FOUND');
        }
      });
    });
  });

  describe('Given a promisor reporting attempted=false and a seeded pack dir', () => {
    describe('When readObject misses', () => {
      it('Then the store is not re-resolved (pack dir scanned exactly once)', async () => {
        // Arrange — a promisor that declines to fetch. The attempted=false guard
        // surfaces the original miss directly; it must NOT fall through to a
        // pointless re-resolve, which would re-scan the pack directory a 2nd time.
        const base = await buildSeededContext();
        const packDir = `${base.layout.gitDir}/objects/pack`;
        await base.fs.write(`${packDir}/.gitkeep`, new Uint8Array([0]));
        let packReaddirCount = 0;
        const originalReaddir = base.fs.readdir.bind(base.fs);
        const ctx: Context = {
          ...base,
          fs: {
            ...base.fs,
            readdir: async (path: string) => {
              if (path === packDir) packReaddirCount += 1;
              return originalReaddir(path);
            },
          },
          promisor: {
            fetch: async (oids) => ({ attempted: false, requested: oids.length, fetched: 0 }),
          },
        };

        // Act
        try {
          await readObject(ctx, 'f'.repeat(40) as ObjectId);
          // Assert
          expect.unreachable();
        } catch (error) {
          expect((error as TsgitError).data.code).toBe('OBJECT_NOT_FOUND');
        }

        // Assert — the guard short-circuited: one scan, no refresh + re-resolve.
        expect(packReaddirCount).toBe(1);
      });
    });
  });

  describe('Given a promisor that attempts but supplies nothing', () => {
    describe('When readObject misses', () => {
      it('Then OBJECT_NOT_FOUND is thrown', async () => {
        // Arrange
        const base = await buildSeededContext();
        const ctx: Context = {
          ...base,
          promisor: {
            fetch: async (oids) => ({ attempted: true, requested: oids.length, fetched: 0 }),
          },
        };

        // Act
        try {
          await readObject(ctx, 'f'.repeat(40) as ObjectId);
          // Assert
          expect.unreachable();
        } catch (error) {
          expect((error as TsgitError).data.code).toBe('OBJECT_NOT_FOUND');
        }
      });
    });
  });

  describe('Given two concurrent reads of the same missing object', () => {
    describe('When readObject', () => {
      it('Then the promisor is invoked once', async () => {
        // Arrange
        const base = await buildSeededContext();
        const blob: Blob = { type: 'blob', content: new Uint8Array([1, 1, 2]), id: '' as ObjectId };
        const id = (await base.hash.hashHex(serializeObject(blob, base.hashConfig))) as ObjectId;
        const calls = { count: 0 };
        let ctx!: Context;
        ctx = { ...base, promisor: supplyingPromisor(blob, calls, () => ctx) };

        // Act
        const [a, b] = await Promise.all([readObject(ctx, id), readObject(ctx, id)]);

        // Assert
        expect(a.type).toBe('blob');
        expect(b.type).toBe('blob');
        expect(calls.count).toBe(1);
      });
    });
  });

  describe('Given an object already present', () => {
    describe('When readObject', () => {
      it('Then the promisor is never consulted', async () => {
        // Arrange
        const blob: Blob = { type: 'blob', content: new Uint8Array([3, 1, 4]), id: '' as ObjectId };
        const base = await buildSeededContext({ objects: [blob] });
        const id = (await base.hash.hashHex(serializeObject(blob, base.hashConfig))) as ObjectId;
        const calls = { count: 0 };
        const ctx: Context = {
          ...base,
          promisor: {
            fetch: async (oids) => {
              calls.count += 1;
              return { attempted: false, requested: oids.length, fetched: 0 };
            },
          },
        };

        // Act
        const result = await readObject(ctx, id);

        // Assert
        expect(result.type).toBe('blob');
        expect(calls.count).toBe(0);
      });
    });
  });

  describe('Given a promisor and a corrupted object', () => {
    describe('When readObject', () => {
      it('Then the hash-mismatch error propagates and the promisor is not consulted', async () => {
        // Arrange — a loose object whose bytes do not hash to its id.
        const base = await buildSeededContext();
        const fakeId = 'a'.repeat(40) as ObjectId;
        const compressed = await base.compressor.deflate(new TextEncoder().encode('blob 3\0xyz'));
        await base.fs.write(
          `${base.layout.gitDir}/objects/${await computeLooseObjectPathOf(fakeId)}`,
          compressed,
        );
        const calls = { count: 0 };
        const ctx: Context = {
          ...base,
          promisor: {
            fetch: async (oids) => {
              calls.count += 1;
              return { attempted: true, requested: oids.length, fetched: 0 };
            },
          },
        };

        // Act — a non-OBJECT_NOT_FOUND error is rethrown untouched.
        try {
          await readObject(ctx, fakeId, { verifyHash: true });
          // Assert
          expect.unreachable();
        } catch (error) {
          expect((error as TsgitError).data.code).toBe('OBJECT_HASH_MISMATCH');
        }

        // Assert
        expect(calls.count).toBe(0);
      });
    });
  });

  describe('Given two sequential reads of an object the promisor cannot supply', () => {
    describe('When readObject', () => {
      it('Then the promisor is invoked for each', async () => {
        // Arrange — the in-flight entry must clear after each fetch resolves.
        const base = await buildSeededContext();
        const id = 'e'.repeat(40) as ObjectId;
        const calls = { count: 0 };
        const ctx: Context = {
          ...base,
          promisor: {
            fetch: async (oids) => {
              calls.count += 1;
              return { attempted: true, requested: oids.length, fetched: 0 };
            },
          },
        };

        // Act — two reads, awaited one after the other.
        for (let i = 0; i < 2; i += 1) {
          try {
            await readObject(ctx, id);
            expect.unreachable();
          } catch (error) {
            expect((error as TsgitError).data.code).toBe('OBJECT_NOT_FOUND');
          }
        }

        // Assert — each sequential miss issued its own fetch.
        expect(calls.count).toBe(2);
      });
    });
  });
});
