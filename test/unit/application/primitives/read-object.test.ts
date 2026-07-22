import { describe, expect, it } from 'vitest';
import { readObject } from '../../../../src/application/primitives/read-object.js';
import type { TsgitError } from '../../../../src/domain/error.js';
import type { Blob, ObjectId } from '../../../../src/domain/objects/index.js';
import { serializeObject } from '../../../../src/domain/objects/index.js';
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
        const sut = await readObject(ctx, id);
        // Assert
        expect(sut.type).toBe('blob');
      });
    });
  });

  describe('Given a missing id and default verifyHash', () => {
    describe('When readObject is called', () => {
      it('Then throws OBJECT_NOT_FOUND', async () => {
        // Arrange
        const ctx = await buildSeededContext();
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

  describe('Given a corrupted loose file and verifyHash default true', () => {
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

        try {
          await readObject(ctx, fakeId);
          // Assert
          expect.unreachable();
        } catch (error) {
          expect((error as TsgitError).data.code).toBe('OBJECT_HASH_MISMATCH');
        }
      });
    });
  });

  describe('Given verifyHash=false on the same corrupted file', () => {
    describe('When readObject is called', () => {
      it('Then returns the bytes', async () => {
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

        const sut = await readObject(ctx, fakeId, { verifyHash: false });
        // Assert
        expect(sut.type).toBe('blob');
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
          const sut = await readObject(ctx, id, { maxBytes: 8 });

          // Assert
          expect(sut.type).toBe('blob');
          expect((sut as Blob).content).toEqual(content);
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

          // Act / Assert
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
          const sut = await readObject(ctx, id);

          // Assert
          expect((sut as Blob).content).toHaveLength(1024);
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

          // Act / Assert
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

          // Act / Assert — cap is 4. Declared size (1) ≤ 4 would pass a
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
          const sut = await readObject(ctx, id as ObjectId, { maxBytes: 8 });

          // Assert
          expect(sut.type).toBe('blob');
          expect((sut as Blob).content).toEqual(content);
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

          // Act / Assert
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

          // Act / Assert
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
          const sut = await readObject(ctx, deltaId, { maxBytes: 8 });

          // Assert
          expect((sut as Blob).content).toEqual(targetContent);
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
});

describe('readObject — lazy-fetch (partial clone)', () => {
  const computeLooseObjectPathOf = async (id: ObjectId): Promise<string> => {
    const { computeLooseObjectPath } = await import('../../../../src/domain/storage/loose-path.js');
    return computeLooseObjectPath(id);
  };

  /** A promisor whose `fetch` writes `blob` loose so the retry resolves it. */
  const supplyingPromisor = (
    ctx: Context,
    id: ObjectId,
    blob: Blob,
    calls: { count: number },
  ): PromisorRemote => ({
    fetch: async (oids) => {
      calls.count += 1;
      const bytes = serializeObject(blob, ctx.hashConfig);
      const compressed = await ctx.compressor.deflate(bytes);
      await ctx.fs.write(
        `${ctx.layout.gitDir}/objects/${await computeLooseObjectPathOf(id)}`,
        compressed,
      );
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
        const ctx: Context = { ...base, promisor: supplyingPromisor(base, id, blob, calls) };

        // Act
        const sut = await readObject(ctx, id);

        // Assert
        expect(sut.type).toBe('blob');
        expect(calls.count).toBe(1);
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
        const promisor: PromisorRemote = {
          fetch: async (oids) => {
            requested.push([...oids]);
            const bytes = serializeObject(blob, base.hashConfig);
            const compressed = await base.compressor.deflate(bytes);
            await base.fs.write(
              `${base.layout.gitDir}/objects/${await computeLooseObjectPathOf(id)}`,
              compressed,
            );
            return { attempted: true, requested: oids.length, fetched: oids.length };
          },
        };
        const ctx: Context = { ...base, promisor };

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

        // Act & Assert
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

        // Act & Assert
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
        const ctx: Context = { ...base, promisor: supplyingPromisor(base, id, blob, calls) };

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
        const sut = await readObject(ctx, id);

        // Assert
        expect(sut.type).toBe('blob');
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

        // Act & Assert — a non-OBJECT_NOT_FOUND error is rethrown untouched.
        try {
          await readObject(ctx, fakeId);
          // Assert
          expect.unreachable();
        } catch (error) {
          expect((error as TsgitError).data.code).toBe('OBJECT_HASH_MISMATCH');
        }
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
