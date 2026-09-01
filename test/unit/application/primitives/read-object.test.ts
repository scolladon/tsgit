import { describe, expect, it, vi } from 'vitest';
import { deriveContext } from '../../../../src/application/primitives/derive-context.js';
import { readObject, readRawObject } from '../../../../src/application/primitives/read-object.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import type { TsgitError } from '../../../../src/domain/error.js';
import type { Blob, ObjectId } from '../../../../src/domain/objects/index.js';
import { EMPTY_TREE_OID, serializeObject } from '../../../../src/domain/objects/index.js';
import type { Context } from '../../../../src/ports/context.js';
import type { PromisorRemote } from '../../../../src/ports/promisor.js';
import { buildSeededContext } from './fixtures.js';
import { writeSyntheticPack } from './pack-fixture.js';

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

    describe('Given a loose blob whose declared header size differs from its actual content length', () => {
      describe('When readObject is called with maxBytes', () => {
        it('Then the cap measures ACTUAL content bytes (mutation hardening for)', async () => {
          // Arrange — forge a loose object whose <type> <size>\0 header lies
          // about its payload size. The cap MUST measure the inflated body's
          // actual length, not the declared header value — otherwise an
          // adversary can declare 1 byte and ship 10 GiB without tripping the
          // cap.
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

          // Act + Assert — cap is 4. Declared size (1) ≤ 4 would pass a
          // declared-size cap; actual content is 8 > 4 → must reject.
          try {
            await readObject(ctx, fakeId, { maxBytes: 4, verifyHash: false });
            expect.unreachable();
          } catch (error) {
            const data = (error as TsgitError).data;
            expect(data.code).toBe('OBJECT_TOO_LARGE');
            if (data.code !== 'OBJECT_TOO_LARGE') {
              expect.fail(`expected OBJECT_TOO_LARGE, got ${data.code}`);
            }
            expect(data.actualSize).toBe(8);
            expect(data.limit).toBe(4);
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
