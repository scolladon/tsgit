import { describe, expect, it } from 'vitest';
import { readObject } from '../../../../src/application/primitives/read-object.js';
import type { TsgitError } from '../../../../src/domain/error.js';
import type { Blob, ObjectId } from '../../../../src/domain/objects/index.js';
import { serializeObject } from '../../../../src/domain/objects/index.js';
import { buildSeededContext } from './fixtures.js';

describe('readObject', () => {
  it('Given a seeded blob, When readObject is called, Then returns the Blob', async () => {
    const blob: Blob = { type: 'blob', content: new Uint8Array([4, 5, 6]), id: '' as ObjectId };
    const ctx = await buildSeededContext({ objects: [blob] });
    const id = (await ctx.hash.hashHex(serializeObject(blob, ctx.hashConfig))) as ObjectId;
    const sut = await readObject(ctx, id);
    expect(sut.type).toBe('blob');
  });

  it('Given a missing id and default verifyHash, When readObject is called, Then throws OBJECT_NOT_FOUND', async () => {
    const ctx = await buildSeededContext();
    try {
      await readObject(ctx, 'f'.repeat(40) as ObjectId);
      expect.unreachable();
    } catch (error) {
      expect((error as TsgitError).data.code).toBe('OBJECT_NOT_FOUND');
    }
  });

  it('Given a corrupted loose file and verifyHash default true, When readObject is called, Then throws OBJECT_HASH_MISMATCH', async () => {
    const ctx = await buildSeededContext();
    const fakeId = 'a'.repeat(40) as ObjectId;
    const { computeLooseObjectPath } = await import('../../../../src/domain/storage/loose-path.js');
    const rawBytes = new TextEncoder().encode('blob 3\0xyz');
    const compressed = await ctx.compressor.deflate(rawBytes);
    await ctx.fs.write(
      `${ctx.layout.gitDir}/objects/${computeLooseObjectPath(fakeId)}`,
      compressed,
    );

    try {
      await readObject(ctx, fakeId);
      expect.unreachable();
    } catch (error) {
      expect((error as TsgitError).data.code).toBe('OBJECT_HASH_MISMATCH');
    }
  });

  it('Given verifyHash=false on the same corrupted file, When readObject is called, Then returns the bytes', async () => {
    const ctx = await buildSeededContext();
    const fakeId = 'a'.repeat(40) as ObjectId;
    const { computeLooseObjectPath } = await import('../../../../src/domain/storage/loose-path.js');
    const rawBytes = new TextEncoder().encode('blob 3\0xyz');
    const compressed = await ctx.compressor.deflate(rawBytes);
    await ctx.fs.write(
      `${ctx.layout.gitDir}/objects/${computeLooseObjectPath(fakeId)}`,
      compressed,
    );

    const sut = await readObject(ctx, fakeId, { verifyHash: false });
    expect(sut.type).toBe('blob');
  });

  it('Given two readObject calls on the same context, When readObject is called twice, Then the pack registry is cached (readdir runs at most once)', async () => {
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
