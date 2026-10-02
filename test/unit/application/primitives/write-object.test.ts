import { describe, expect, it, vi } from 'vitest';
import { __resetConfigCacheForTests } from '../../../../src/application/primitives/config-read.js';
import { freshenObject } from '../../../../src/application/primitives/internal/freshen-object.js';
import { readObject } from '../../../../src/application/primitives/read-object.js';
import {
  writeLooseObject,
  writeObject,
} from '../../../../src/application/primitives/write-object.js';
import { TsgitError } from '../../../../src/domain/error.js';
import type { Blob, ObjectId } from '../../../../src/domain/objects/index.js';
import { buildSeededContext, seedMaxTreeDepth } from './fixtures.js';
import { writeSyntheticPack } from './pack-fixture.js';

describe('writeObject', () => {
  describe('Given a fresh blob', () => {
    describe('When writeObject is called', () => {
      it('Then returns the computed id and file exists', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const blob: Blob = { type: 'blob', content: new Uint8Array([1]), id: '' as ObjectId };
        // Act
        const id = await writeObject(ctx, blob);
        // Assert
        expect(id).toMatch(/^[0-9a-f]{40}$/);
        const roundtripped = await readObject(ctx, id);
        expect(roundtripped.type).toBe('blob');
      });
    });
  });

  describe('Given two identical writes', () => {
    describe('When writeObject is called twice', () => {
      it('Then second call is idempotent (same id, no error)', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const blob: Blob = { type: 'blob', content: new Uint8Array([2, 3]), id: '' as ObjectId };
        // Act
        const id1 = await writeObject(ctx, blob);
        const id2 = await writeObject(ctx, blob);
        // Assert
        expect(id1).toBe(id2);
      });
    });
  });

  describe('Given an object whose id mismatches the computed hash', () => {
    describe('When writeObject is called', () => {
      it('Then throws OBJECT_HASH_MISMATCH', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const blob: Blob = {
          type: 'blob',
          content: new Uint8Array([0]),
          id: 'f'.repeat(40) as ObjectId,
        };
        // Act + Assert
        try {
          await writeObject(ctx, blob);
          expect.unreachable();
        } catch (error) {
          expect(error).toBeInstanceOf(TsgitError);
          expect((error as TsgitError).data.code).toBe('OBJECT_HASH_MISMATCH');
        }
      });
    });
  });

  describe('Given an aborted signal', () => {
    describe('When writeObject is called', () => {
      it('Then the entry guard throws before hashHex runs', async () => {
        // Arrange — the second abort guard (line 19) would also throw, so to pin
        // the FIRST guard (line 9) we assert it short-circuits before any hashing.
        // A `false` mutant of line 9 lets execution reach `hashHex`.
        const controller = new AbortController();
        controller.abort();
        const base = await buildSeededContext({ signal: controller.signal });
        let hashHexCalls = 0;
        const ctx = {
          ...base,
          hash: {
            ...base.hash,
            hashHex: async (data: Uint8Array): Promise<string> => {
              hashHexCalls += 1;
              return base.hash.hashHex(data);
            },
          },
        };
        const blob: Blob = { type: 'blob', content: new Uint8Array([0]), id: '' as ObjectId };

        // Act
        let caught: unknown;
        try {
          await writeObject(ctx, blob);
          expect.unreachable();
        } catch (error) {
          caught = error;
        }

        // Assert — guard fired first: no hashing happened, abort code reported.
        expect(hashHexCalls).toBe(0);
        expect((caught as TsgitError).data.code).toBe('OPERATION_ABORTED');
      });
    });
  });

  describe('Given a blob', () => {
    describe('When writeObject is followed by readObject', () => {
      it('Then round-trips correctly', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const content = new Uint8Array([10, 20, 30, 40]);
        const blob: Blob = { type: 'blob', content, id: '' as ObjectId };
        // Act
        const id = await writeObject(ctx, blob);
        const read = await readObject(ctx, id);
        // Assert
        expect((read as Blob).content).toEqual(content);
      });
    });
  });

  describe('Given a pre-declared id that matches the computed hash', () => {
    describe('When writeObject is called', () => {
      it('Then succeeds and returns the same id', async () => {
        // Arrange
        // Kills the ConditionalExpression mutant on `hasDeclaredId(declaredId) && declaredId !== computed`:
        // under `true`, this would incorrectly reject a correctly-declared id.
        const ctx = await buildSeededContext();
        const blob: Blob = {
          type: 'blob',
          content: new Uint8Array([42]),
          id: '' as ObjectId,
        };
        // Act
        // First, compute the id by writing with no declared id.
        const computedId = await writeObject(ctx, blob);
        // Now re-write with the id pre-declared.
        const declared: Blob = { ...blob, id: computedId };
        const id2 = await writeObject(ctx, declared);
        // Assert
        expect(id2).toBe(computedId);
      });
    });
  });

  describe('Given writeExclusive throws a non-FILE_EXISTS TsgitError', () => {
    describe('When writeObject is called', () => {
      it('Then propagates the original error', async () => {
        // Arrange
        // Kills both `isFileExists` mutants and the conditional `true`/`false` at the
        // try/catch: under `true` the error would be swallowed and return a wrong id.
        const ctx = await buildSeededContext();
        const wrapped = {
          ...ctx,
          fs: {
            ...ctx.fs,
            writeExclusive: async () => {
              throw new TsgitError({ code: 'PERMISSION_DENIED', path: '/x' });
            },
          },
        };
        const blob: Blob = { type: 'blob', content: new Uint8Array([9]), id: '' as ObjectId };
        // Act + Assert
        try {
          await writeObject(wrapped, blob);
          expect.unreachable();
        } catch (error) {
          expect((error as TsgitError).data.code).toBe('PERMISSION_DENIED');
        }
      });
    });
  });

  describe('Given writeExclusive throws a plain Error (not TsgitError)', () => {
    describe('When writeObject is called', () => {
      it('Then propagates the plain Error', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const wrapped = {
          ...ctx,
          fs: {
            ...ctx.fs,
            writeExclusive: async () => {
              throw new Error('io boom');
            },
          },
        };
        const blob: Blob = { type: 'blob', content: new Uint8Array([10]), id: '' as ObjectId };
        // Act + Assert
        try {
          await writeObject(wrapped, blob);
          expect.unreachable();
        } catch (error) {
          expect(error).not.toBeInstanceOf(TsgitError);
          expect((error as Error).message).toBe('io boom');
        }
      });
    });
  });

  describe('Given a blob', () => {
    describe('When writeObject is called', () => {
      it('Then the objects sub-directory is the 2-char id prefix (not the full id)', async () => {
        // Kills the MethodExpression mutant on `computed.slice(0, 2)`: dropping the
        // slice makes `prefix` the full 40-char id, so mkdir creates
        // `objects/<40-char-id>` instead of `objects/<2-char-prefix>`.
        // Arrange
        const ctx = await buildSeededContext();
        const blob: Blob = { type: 'blob', content: new Uint8Array([77]), id: '' as ObjectId };

        // Act
        const id = await writeObject(ctx, blob);

        // Assert — the 2-char prefix directory exists; the full-id directory does not.
        expect(await ctx.fs.exists(`/repo/.git/objects/${id.slice(0, 2)}`)).toBe(true);
        expect(await ctx.fs.exists(`/repo/.git/objects/${id}`)).toBe(false);
      });
    });
  });

  describe('Given a core.loosecompression value in the repo config', () => {
    describe('When writeObject is called', () => {
      it.each([
        { configValue: '9', expected: 9, label: 'deflate is called with level=9' },
        {
          configValue: undefined,
          expected: undefined,
          label: 'deflate is called with no level argument (undefined, the default path)',
        },
        {
          configValue: '99',
          expected: undefined,
          label:
            'deflate is called with no level argument (out of zlib domain, safety guard falls back to default)',
        },
        {
          configValue: '-1',
          expected: -1,
          label: 'deflate is called with level=-1 (the inclusive lower bound is honoured)',
        },
        {
          configValue: '-2',
          expected: undefined,
          label:
            'deflate is called with no level argument (below zlib domain, lower-bound guard falls back to default)',
        },
      ])('Then $label', async ({ configValue, expected }) => {
        // Arrange
        const ctx = await buildSeededContext();
        if (configValue !== undefined) {
          await ctx.fs.writeUtf8(
            `${ctx.layout.gitDir}/config`,
            `[core]\n\tloosecompression = ${configValue}\n`,
          );
        }
        __resetConfigCacheForTests();
        const deflateCapture: Array<number | undefined> = [];
        const wrappedCtx = {
          ...ctx,
          compressor: {
            ...ctx.compressor,
            deflate: async (data: Uint8Array, level?: number): Promise<Uint8Array> => {
              deflateCapture.push(level);
              return ctx.compressor.deflate(data, level);
            },
          },
        };
        const blob: Blob = { type: 'blob', content: new Uint8Array([55]), id: '' as ObjectId };

        // Act
        await writeObject(wrappedCtx, blob);

        // Assert
        expect(deflateCapture[0]).toBe(expected);
      });
    });
  });

  describe('Given a malformed core.maxTreeDepth and NO gate has run on this Context', () => {
    describe('When writeObject is called directly', () => {
      it('Then throws CONFIG_BAD_NUMERIC_VALUE and writes no loose file — a Tier-2 write now validates the class on its own', async () => {
        // Arrange — a bare Tier-2 call, no Tier-1 gate ever ran on this ctx.
        const ctx = await buildSeededContext();
        await seedMaxTreeDepth(ctx, '2.5');
        const blob: Blob = { type: 'blob', content: new Uint8Array([99]), id: '' as ObjectId };
        const writeExclusiveSpy = { called: false };
        const wrapped = {
          ...ctx,
          fs: {
            ...ctx.fs,
            writeExclusive: async (path: string, data: Uint8Array): Promise<void> => {
              writeExclusiveSpy.called = true;
              return ctx.fs.writeExclusive(path, data);
            },
          },
        };

        // Act
        let caught: unknown;
        try {
          await writeObject(wrapped, blob);
          expect.unreachable();
        } catch (error) {
          caught = error;
        }

        // Assert
        expect((caught as TsgitError).data.code).toBe('CONFIG_BAD_NUMERIC_VALUE');
        expect(writeExclusiveSpy.called).toBe(false);
      });
    });
  });

  describe('Given the signal aborts between serialize and writeExclusive', () => {
    describe('When writeObject is called', () => {
      it('Then throws OPERATION_ABORTED (not silently writes)', async () => {
        // Arrange
        // Kills the second `ctx.signal?.aborted` check at line 19.
        const ctx = await buildSeededContext();
        const controller = new AbortController();
        // Abort after hashing finishes but before the second check. We use a
        // hash wrapper that triggers the abort as a side effect.
        const wrapped = {
          ...ctx,
          signal: controller.signal,
          hash: {
            ...ctx.hash,
            hashHex: async (bytes: Uint8Array) => {
              const out = await ctx.hash.hashHex(bytes);
              controller.abort();
              return out;
            },
          },
        };
        const blob: Blob = { type: 'blob', content: new Uint8Array([50]), id: '' as ObjectId };
        // Act + Assert
        try {
          await writeObject(wrapped, blob);
          expect.unreachable();
        } catch (error) {
          expect((error as TsgitError).data.code).toBe('OPERATION_ABORTED');
        }
      });
    });
  });

  describe('Given the object is already packed', () => {
    describe('When writeObject is called', () => {
      it('Then the id is returned without deflating or writing a loose file', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const content = new TextEncoder().encode('packed already\n');
        const [packedId] = await writeSyntheticPack(ctx, 'freshen-hit', [
          { kind: 'base', type: 'blob', content },
        ]);
        const deflate = vi.spyOn(ctx.compressor, 'deflate');
        const writeExclusive = vi.spyOn(ctx.fs, 'writeExclusive');
        const blob: Blob = { type: 'blob', content, id: '' as ObjectId };

        // Act
        const sut = writeObject;
        const result = await sut(ctx, blob);

        // Assert
        expect(result).toBe(packedId);
        expect(deflate).not.toHaveBeenCalled();
        expect(writeExclusive).not.toHaveBeenCalled();
      });
    });
  });

  describe('Given the filesystem has no utimeNow and the object is already loose', () => {
    describe('When writeObject is called', () => {
      it('Then the id is returned and the file is not rewritten', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        Object.defineProperty(ctx.fs, 'utimeNow', { value: undefined });
        const blob: Blob = { type: 'blob', content: new Uint8Array([9, 9]), id: '' as ObjectId };
        const first = await writeObject(ctx, blob);
        const writeExclusive = vi.spyOn(ctx.fs, 'writeExclusive');
        const write = vi.spyOn(ctx.fs, 'write');

        // Act
        const sut = writeObject;
        const result = await sut(ctx, blob);

        // Assert
        expect(result).toBe(first);
        expect(writeExclusive).toHaveBeenCalledTimes(1);
        expect(write).not.toHaveBeenCalled();
      });
    });
  });

  describe('Given a loose copy another writer created after the listing was cached', () => {
    describe('When writeObject hits FILE_EXISTS', () => {
      it('Then the existing file is touched and the id returned', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const blob: Blob = { type: 'blob', content: new Uint8Array([7, 7, 7]), id: '' as ObjectId };
        const sut = writeObject;
        const donor = await buildSeededContext();
        const id = await writeObject(donor, { ...blob });
        const path = `${ctx.layout.gitDir}/objects/${id.slice(0, 2)}/${id.slice(2)}`;
        const donorPath = `${donor.layout.gitDir}/objects/${id.slice(0, 2)}/${id.slice(2)}`;
        await freshenObject(ctx, id);
        await ctx.fs.write(path, await donor.fs.read(donorPath));
        const utimeNow = vi.spyOn(ctx.fs, 'utimeNow');

        // Act
        const result = await sut(ctx, { ...blob });

        // Assert
        expect(result).toBe(id);
        expect(utimeNow).toHaveBeenCalledWith(path);
      });
    });
  });

  describe('Given a loose copy removed by another process after the listing was cached', () => {
    describe('When writeObject is called again', () => {
      it('Then the loose file is written back rather than the write skipped', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const blob: Blob = { type: 'blob', content: new Uint8Array([5, 5]), id: '' as ObjectId };
        const id = await writeObject(ctx, { ...blob });
        const path = `${ctx.layout.gitDir}/objects/${id.slice(0, 2)}/${id.slice(2)}`;
        await ctx.fs.rm(path);
        const sut = writeObject;

        // Act
        const result = await sut(ctx, { ...blob });

        // Assert
        expect(result).toBe(id);
        expect(await ctx.fs.exists(path)).toBe(true);
      });
    });
  });

  describe('Given the pack holding the object removed by another process after the registry was loaded', () => {
    describe('When writeObject is called', () => {
      it('Then a loose copy is written rather than the write skipped', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const content = new TextEncoder().encode('pack vanished\n');
        const [packedId] = await writeSyntheticPack(ctx, 'vanished', [
          { kind: 'base', type: 'blob', content },
        ]);
        await readObject(ctx, packedId as ObjectId);
        const packBase = `${ctx.layout.gitDir}/objects/pack/pack-vanished`;
        await ctx.fs.rm(`${packBase}.pack`);
        await ctx.fs.rm(`${packBase}.idx`);
        const sut = writeObject;

        // Act
        const result = await sut(ctx, { type: 'blob', content, id: '' as ObjectId });

        // Assert
        expect(result).toBe(packedId);
        const id = result as string;
        expect(
          await ctx.fs.exists(`${ctx.layout.gitDir}/objects/${id.slice(0, 2)}/${id.slice(2)}`),
        ).toBe(true);
      });
    });
  });

  describe('Given the object is already packed', () => {
    describe('When writeLooseObject is called', () => {
      it('Then a loose copy is written regardless', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const content = new TextEncoder().encode('forced loose\n');
        const [packedId] = await writeSyntheticPack(ctx, 'force-loose', [
          { kind: 'base', type: 'blob', content },
        ]);
        const blob: Blob = { type: 'blob', content, id: '' as ObjectId };

        // Act
        const sut = writeLooseObject;
        const result = await sut(ctx, blob);

        // Assert
        expect(result).toBe(packedId);
        const id = result as string;
        expect(
          await ctx.fs.exists(`${ctx.layout.gitDir}/objects/${id.slice(0, 2)}/${id.slice(2)}`),
        ).toBe(true);
      });
    });
  });
});
