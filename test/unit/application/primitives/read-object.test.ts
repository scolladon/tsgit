import { describe, expect, it } from 'vitest';
import { readObject } from '../../../../src/application/primitives/read-object.js';
import type { TsgitError } from '../../../../src/domain/error.js';
import type { Blob, ObjectId } from '../../../../src/domain/objects/index.js';
import { serializeObject } from '../../../../src/domain/objects/index.js';
import { buildSeededContext } from './fixtures.js';
import { writeSyntheticPack } from './pack-fixture.js';

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

  describe('maxBytes — loose objects', () => {
    it('Given a loose blob exactly at the cap, When readObject is called with maxBytes=size, Then returns the Blob (inclusive boundary)', async () => {
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

    it('Given a loose blob one byte over the cap, When readObject is called, Then throws OBJECT_TOO_LARGE with id, actualSize=9, limit=8', async () => {
      // Arrange
      const content = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]);
      const blob: Blob = { type: 'blob', content, id: '' as ObjectId };
      const ctx = await buildSeededContext({ objects: [blob] });
      const id = (await ctx.hash.hashHex(serializeObject(blob, ctx.hashConfig))) as ObjectId;

      // Act / Assert
      try {
        await readObject(ctx, id, { maxBytes: 8 });
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

    it('Given maxBytes undefined, When readObject is called, Then no cap applies (regression for default)', async () => {
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

    it('Given maxBytes=0 on a non-empty loose blob, When readObject is called, Then throws OBJECT_TOO_LARGE with id, actualSize=1, limit=0', async () => {
      // Arrange
      const blob: Blob = { type: 'blob', content: new Uint8Array([1]), id: '' as ObjectId };
      const ctx = await buildSeededContext({ objects: [blob] });
      const id = (await ctx.hash.hashHex(serializeObject(blob, ctx.hashConfig))) as ObjectId;

      // Act / Assert
      try {
        await readObject(ctx, id, { maxBytes: 0 });
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

    it('Given a loose blob whose declared header size differs from its actual content length, When readObject is called with maxBytes, Then the cap measures ACTUAL content bytes (mutation hardening for)', async () => {
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

  describe('maxBytes — pack base entries', () => {
    it('Given a packed blob base entry at the cap, When readObject is called with maxBytes=size, Then returns the Blob', async () => {
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

    it('Given a packed blob base entry one byte over the cap, When readObject is called, Then throws OBJECT_TOO_LARGE pre-inflate', async () => {
      // Arrange
      const content = new TextEncoder().encode('abcdefghi'); // 9 bytes
      const ctx = await buildSeededContext();
      const [id] = await writeSyntheticPack(ctx, 'cap-over', [
        { kind: 'base', type: 'blob', content },
      ]);

      // Act / Assert
      try {
        await readObject(ctx, id as ObjectId, { maxBytes: 8 });
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

  describe('maxBytes — pack delta-resolved entries', () => {
    it('Given a delta-resolved blob whose reconstructed size exceeds the cap, When readObject is called, Then throws OBJECT_TOO_LARGE post-apply', async () => {
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

    it('Given a delta-resolved blob whose reconstructed size equals the cap, When readObject is called, Then returns the Blob (boundary)', async () => {
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
