import { describe, expect, it, vi } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import {
  forgetLooseOidPrefix,
  invalidateLooseOid,
  probeLooseOid,
} from '../../../../src/application/primitives/internal/loose-oid-cache.js';
import type { SourceLocation } from '../../../../src/application/primitives/internal/source-location.js';
import { fileNotFound, permissionDenied, TsgitError } from '../../../../src/domain/error.js';
import type { ObjectId } from '../../../../src/domain/objects/index.js';

const looseFilePath = (ctx: { layout: { gitDir: string } }, id: ObjectId): string =>
  `${ctx.layout.gitDir}/objects/${id.slice(0, 2)}/${id.slice(2)}`;

describe('loose-oid-cache', () => {
  describe('Given a fanout dir that has never been written', () => {
    describe('When probeLooseOid is called', () => {
      it('Then returns false without throwing (ENOENT treated as an empty set)', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const id = 'a'.repeat(40) as ObjectId;

        // Act
        const result = await probeLooseOid(ctx, id);

        // Assert
        expect(result).toBe(false);
      });
    });
  });

  describe('Given a loose object file present in its fanout dir', () => {
    describe('When probeLooseOid is called for that id', () => {
      it('Then returns true', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const id = 'b'.repeat(40) as ObjectId;
        await ctx.fs.write(looseFilePath(ctx, id), new Uint8Array([1]));

        // Act
        const result = await probeLooseOid(ctx, id);

        // Assert
        expect(result).toBe(true);
      });
    });
  });

  describe('Given two ids sharing the same fanout prefix, one present one absent', () => {
    describe('When probeLooseOid is called for both', () => {
      it('Then the dir is read exactly once and each id gets its own correct verdict', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const prefix = 'cc';
        const present = `${prefix}${'1'.repeat(38)}` as ObjectId;
        const absent = `${prefix}${'2'.repeat(38)}` as ObjectId;
        await ctx.fs.write(looseFilePath(ctx, present), new Uint8Array([1]));
        const readdirSpy = vi.spyOn(ctx.fs, 'readdir');

        // Act
        const presentHit = await probeLooseOid(ctx, present);
        const absentMiss = await probeLooseOid(ctx, absent);

        // Assert
        expect(presentHit).toBe(true);
        expect(absentMiss).toBe(false);
        expect(readdirSpy.mock.calls.length).toBe(1);
      });
    });
  });

  describe('Given a fanout dir already probed as empty', () => {
    describe('When invalidateLooseOid is called and the dir gains an entry, then probeLooseOid runs again', () => {
      it('Then the new entry is visible (invalidation drops the stale cache)', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const id = 'd'.repeat(40) as ObjectId;
        expect(await probeLooseOid(ctx, id)).toBe(false);
        await ctx.fs.write(looseFilePath(ctx, id), new Uint8Array([1]));

        // Act
        invalidateLooseOid(ctx, id);
        const result = await probeLooseOid(ctx, id);

        // Assert
        expect(result).toBe(true);
      });
    });
  });

  describe('Given a fanout dir already probed as empty, WITHOUT invalidation', () => {
    describe('When the dir gains an entry and probeLooseOid runs again', () => {
      it('Then the stale cached empty set still misses (proves invalidation is load-bearing)', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const id = 'e'.repeat(40) as ObjectId;
        expect(await probeLooseOid(ctx, id)).toBe(false);
        await ctx.fs.write(looseFilePath(ctx, id), new Uint8Array([1]));

        // Act
        const result = await probeLooseOid(ctx, id);

        // Assert
        expect(result).toBe(false);
      });
    });
  });

  describe('Given two distinct Context instances', () => {
    describe('When one has the object loose and the other is probed for the same id', () => {
      it('Then each Context owns an independent cache (no cross-context leak)', async () => {
        // Arrange
        const ctxA = createMemoryContext();
        const ctxB = createMemoryContext();
        const id = 'f'.repeat(40) as ObjectId;
        await ctxA.fs.write(looseFilePath(ctxA, id), new Uint8Array([1]));

        // Act
        const hitOnA = await probeLooseOid(ctxA, id);
        const missOnB = await probeLooseOid(ctxB, id);

        // Assert
        expect(hitOnA).toBe(true);
        expect(missOnB).toBe(false);
      });
    });
  });

  describe('Given a fanout readdir that throws a non-missing error (permission denied)', () => {
    describe('When probeLooseOid is called', () => {
      it('Then the error propagates instead of being swallowed as an empty set', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const wrapped = {
          ...ctx,
          fs: {
            ...ctx.fs,
            readdir: async (path: string) => {
              throw permissionDenied(path);
            },
          },
        };
        const id = 'aa'.repeat(20) as ObjectId;

        // Act
        let caught: unknown;
        try {
          await probeLooseOid(wrapped, id);
          expect.unreachable();
        } catch (error) {
          caught = error;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as TsgitError).data.code).toBe('PERMISSION_DENIED');
      });
    });
  });

  describe('Given a fanout readdir that throws FILE_NOT_FOUND specifically (not NOT_A_DIRECTORY)', () => {
    describe('When probeLooseOid is called', () => {
      it('Then it resolves false without throwing (treated the same as a missing dir)', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const wrapped = {
          ...ctx,
          fs: {
            ...ctx.fs,
            readdir: async (path: string) => {
              throw fileNotFound(path);
            },
          },
        };
        const id = 'bb'.repeat(20) as ObjectId;

        // Act
        const result = await probeLooseOid(wrapped, id);

        // Assert
        expect(result).toBe(false);
      });
    });
  });

  describe('Given a fanout readdir that throws an error shaped like TsgitError but from a foreign module graph', () => {
    describe('When probeLooseOid is called', () => {
      it('Then it resolves false without throwing (classification is structural, not instanceof)', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const foreignError = { data: { code: 'FILE_NOT_FOUND' } };
        const wrapped = {
          ...ctx,
          fs: {
            ...ctx.fs,
            readdir: async () => {
              throw foreignError;
            },
          },
        };
        const id = 'ff'.repeat(20) as ObjectId;
        const sut = probeLooseOid;

        // Act
        const result = await sut(wrapped, id);

        // Assert
        expect(result).toBe(false);
      });
    });
  });

  describe('Given invalidateLooseOid called for a prefix that was never probed', () => {
    describe('When probeLooseOid runs afterwards', () => {
      it('Then it still resolves correctly (invalidation of an unknown prefix is a no-op)', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const id = '9'.repeat(40) as ObjectId;
        await ctx.fs.write(looseFilePath(ctx, id), new Uint8Array([1]));

        // Act
        invalidateLooseOid(ctx, id);
        const result = await probeLooseOid(ctx, id);

        // Assert
        expect(result).toBe(true);
      });
    });
  });
  describe('Given a location whose fs holds a loose object', () => {
    describe('When probeLooseOid is called with the location', () => {
      it('Then returns true and the primary listing is not consulted', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const altCtx = createMemoryContext();
        const id = 'ab'.repeat(20) as ObjectId;
        await altCtx.fs.write(
          `${altCtx.layout.gitDir}/objects/ab/${id.slice(2)}`,
          new Uint8Array([1]),
        );
        const location: SourceLocation = {
          objectsDir: `${altCtx.layout.gitDir}/objects`,
          fs: altCtx.fs,
        };
        const primaryReaddir = vi.spyOn(ctx.fs, 'readdir');

        // Act
        const result = await probeLooseOid(ctx, id, location);

        // Assert
        expect(result).toBe(true);
        expect(primaryReaddir).not.toHaveBeenCalled();
      });
    });

    describe('When probed without a location', () => {
      it('Then the primary listing is consulted and the location is not', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const altCtx = createMemoryContext();
        const id = 'ac'.repeat(20) as ObjectId;
        const locationReaddir = vi.spyOn(altCtx.fs, 'readdir');
        const primaryReaddir = vi.spyOn(ctx.fs, 'readdir');

        // Act
        await probeLooseOid(ctx, id);

        // Assert
        expect(primaryReaddir).toHaveBeenCalledTimes(1);
        expect(locationReaddir).not.toHaveBeenCalled();
      });
    });
  });

  describe('Given the same location object probed twice', () => {
    describe('When both probes share a prefix', () => {
      it('Then the location is listed once', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const altCtx = createMemoryContext();
        const id = 'ad'.repeat(20) as ObjectId;
        const location: SourceLocation = {
          objectsDir: `${altCtx.layout.gitDir}/objects`,
          fs: altCtx.fs,
        };
        const readdir = vi.spyOn(altCtx.fs, 'readdir');

        // Act
        await probeLooseOid(ctx, id, location);
        await probeLooseOid(ctx, id, location);

        // Assert
        expect(readdir).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe('Given two equal location literals', () => {
    describe('When each is probed for the same prefix', () => {
      it('Then each is listed (cache is keyed by object identity)', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const altCtx = createMemoryContext();
        const id = 'ae'.repeat(20) as ObjectId;
        const readdir = vi.spyOn(altCtx.fs, 'readdir');

        // Act
        await probeLooseOid(ctx, id, {
          objectsDir: `${altCtx.layout.gitDir}/objects`,
          fs: altCtx.fs,
        });
        await probeLooseOid(ctx, id, {
          objectsDir: `${altCtx.layout.gitDir}/objects`,
          fs: altCtx.fs,
        });

        // Assert
        expect(readdir).toHaveBeenCalledTimes(2);
      });
    });
  });

  describe('Given a probed location and a probed primary', () => {
    describe('When invalidateLooseOid is called with the location', () => {
      it('Then only the location entry gains the member', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const altCtx = createMemoryContext();
        const id = 'af'.repeat(20) as ObjectId;
        const location: SourceLocation = {
          objectsDir: `${altCtx.layout.gitDir}/objects`,
          fs: altCtx.fs,
        };
        await probeLooseOid(ctx, id, location);
        await probeLooseOid(ctx, id);

        // Act
        invalidateLooseOid(ctx, id, location);

        // Assert
        expect(await probeLooseOid(ctx, id, location)).toBe(true);
        expect(await probeLooseOid(ctx, id)).toBe(false);
      });
    });

    describe('When forgetLooseOidPrefix is called with the location', () => {
      it('Then only the location is re-listed', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const altCtx = createMemoryContext();
        const id = 'b0'.repeat(20) as ObjectId;
        const location: SourceLocation = {
          objectsDir: `${altCtx.layout.gitDir}/objects`,
          fs: altCtx.fs,
        };
        await probeLooseOid(ctx, id, location);
        await probeLooseOid(ctx, id);
        const locationReaddir = vi.spyOn(altCtx.fs, 'readdir');
        const primaryReaddir = vi.spyOn(ctx.fs, 'readdir');

        // Act
        forgetLooseOidPrefix(ctx, id, location);
        await probeLooseOid(ctx, id, location);
        await probeLooseOid(ctx, id);

        // Assert
        expect(locationReaddir).toHaveBeenCalledTimes(1);
        expect(primaryReaddir).not.toHaveBeenCalled();
      });
    });
  });
});
