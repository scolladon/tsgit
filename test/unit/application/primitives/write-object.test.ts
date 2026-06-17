import { describe, expect, it } from 'vitest';
import { __resetConfigCacheForTests } from '../../../../src/application/primitives/config-read.js';
import { readObject } from '../../../../src/application/primitives/read-object.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import { TsgitError } from '../../../../src/domain/error.js';
import type { Blob, ObjectId } from '../../../../src/domain/objects/index.js';
import { buildSeededContext } from './fixtures.js';

describe('writeObject', () => {
  describe('Given a fresh blob', () => {
    describe('When writeObject is called', () => {
      it('Then returns the computed id and file exists', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const blob: Blob = { type: 'blob', content: new Uint8Array([1]), id: '' as ObjectId };
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
        try {
          await writeObject(ctx, blob);
          // Assert
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
      it('Then throws OPERATION_ABORTED', async () => {
        // Arrange
        const controller = new AbortController();
        controller.abort();
        const ctx = await buildSeededContext({ signal: controller.signal });
        const blob: Blob = { type: 'blob', content: new Uint8Array([0]), id: '' as ObjectId };
        try {
          await writeObject(ctx, blob);
          // Assert
          expect.unreachable();
        } catch (error) {
          expect((error as TsgitError).data.code).toBe('OPERATION_ABORTED');
        }
      });
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
        try {
          await writeObject(wrapped, blob);
          // Assert
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
        try {
          await writeObject(wrapped, blob);
          // Assert
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

  describe('Given core.loosecompression=9 in the repo config', () => {
    describe('When writeObject is called', () => {
      it('Then deflate is called with level=9', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        // Write a config file with loosecompression=9 into the memory FS
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, '[core]\n\tloosecompression = 9\n');
        __resetConfigCacheForTests();
        const deflateCapture: number[] = [];
        const wrappedCtx = {
          ...ctx,
          compressor: {
            ...ctx.compressor,
            deflate: async (data: Uint8Array, level?: number): Promise<Uint8Array> => {
              deflateCapture.push(level as number);
              return ctx.compressor.deflate(data, level);
            },
          },
        };
        const blob: Blob = { type: 'blob', content: new Uint8Array([55]), id: '' as ObjectId };

        // Act
        await writeObject(wrappedCtx, blob);

        // Assert — deflate received the level from config
        expect(deflateCapture[0]).toBe(9);
      });
    });
  });

  describe('Given no core.loosecompression in the repo config', () => {
    describe('When writeObject is called', () => {
      it('Then deflate is called with no level argument (undefined)', async () => {
        // Arrange
        const ctx = await buildSeededContext();
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
        const blob: Blob = { type: 'blob', content: new Uint8Array([56]), id: '' as ObjectId };

        // Act
        await writeObject(wrappedCtx, blob);

        // Assert — no level was passed (the default path)
        expect(deflateCapture[0]).toBeUndefined();
      });
    });
  });

  describe('Given core.loosecompression=99 (out of zlib domain) in the repo config', () => {
    describe('When writeObject is called', () => {
      it('Then deflate is called with no level argument (safety guard falls back to default)', async () => {
        // Arrange — 99 is a valid 32-bit int but outside zlib's -1..9 domain;
        // the guard must NOT pass it to deflateSync which would throw ERR_OUT_OF_RANGE.
        const ctx = await buildSeededContext();
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, '[core]\n\tloosecompression = 99\n');
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
        const blob: Blob = { type: 'blob', content: new Uint8Array([57]), id: '' as ObjectId };

        // Act — must not crash
        await writeObject(wrappedCtx, blob);

        // Assert — out-of-range level not forwarded; deflate called without level
        expect(deflateCapture[0]).toBeUndefined();
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
        try {
          await writeObject(wrapped, blob);
          // Assert
          expect.unreachable();
        } catch (error) {
          expect((error as TsgitError).data.code).toBe('OPERATION_ABORTED');
        }
      });
    });
  });
});
