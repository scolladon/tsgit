import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import { freshenObject } from '../../../../../src/application/primitives/internal/freshen-object.js';
import type { TsgitError } from '../../../../../src/domain/error.js';
import { fileNotFound, permissionDenied } from '../../../../../src/domain/error.js';
import type { ObjectId } from '../../../../../src/domain/objects/index.js';
import { serializeHeader } from '../../../../../src/domain/objects/index.js';
import { computeLooseObjectPath } from '../../../../../src/domain/storage/loose-path.js';
import type { Context } from '../../../../../src/ports/context.js';
import { writeSyntheticPackIn } from '../pack-fixture.js';

const ENC = new TextEncoder();
const PRIMARY = '/repo/.git/objects';
const ALTERNATE = '/repo/alt/objects';
const THEN = 1_000_000_000_000;
const NOW = 1_800_000_000_000;
const FLIPPED_SIGNATURE_MIDX = Uint8Array.from([
  0x00, 0x49, 0x44, 0x58, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0,
]);

const contextWithAlternate = async (): Promise<Context> => {
  const ctx = createMemoryContext({
    files: { [`${PRIMARY}/info/alternates`]: ENC.encode(`${ALTERNATE}\n`) },
  });
  await ctx.fs.mkdir(ALTERNATE);
  return ctx;
};

const blobBytes = (text: string): Uint8Array => {
  const content = ENC.encode(text);
  return new Uint8Array([...serializeHeader('blob', content.length), ...content]);
};

const looseBlobIn = async (ctx: Context, objectsDir: string, text: string): Promise<ObjectId> => {
  const bytes = blobBytes(text);
  const id = (await ctx.hash.hashHex(bytes)) as ObjectId;
  await ctx.fs.write(
    `${objectsDir}/${computeLooseObjectPath(id)}`,
    await ctx.compressor.deflate(bytes),
  );
  return id;
};

const packedBlobIn = async (ctx: Context, objectsDir: string, text: string): Promise<ObjectId> => {
  const [id] = await writeSyntheticPackIn(ctx, objectsDir, text, [
    { kind: 'base', type: 'blob', content: ENC.encode(text) },
  ]);
  return id as ObjectId;
};

const packPath = (objectsDir: string, name: string): string => `${objectsDir}/pack/pack-${name}`;
const mtimeOf = async (ctx: Context, path: string): Promise<number> =>
  (await ctx.fs.stat(path)).mtimeMs;
const looseMissing = async (ctx: Context, id: ObjectId): Promise<boolean> =>
  !(await ctx.fs.exists(`${PRIMARY}/${computeLooseObjectPath(id)}`));

const rejectionData = async (attempt: Promise<unknown>): Promise<unknown> => {
  try {
    await attempt;
  } catch (error) {
    return (error as TsgitError).data;
  }
  return undefined;
};

describe('freshenObject', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(THEN);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('Given the primary holds the object loose', () => {
    describe('When freshenObject', () => {
      it('Then the loose file is touched and true is returned', async () => {
        // Arrange
        const ctx = await contextWithAlternate();
        const id = await looseBlobIn(ctx, PRIMARY, 'loose');
        vi.setSystemTime(NOW);

        // Act
        const sut = freshenObject;
        const result = await sut(ctx, id);

        // Assert
        expect(result).toBe(true);
        expect(await mtimeOf(ctx, `${PRIMARY}/${computeLooseObjectPath(id)}`)).toBe(NOW);
      });
    });
  });

  describe('Given the primary holds the object packed', () => {
    describe('When freshenObject', () => {
      it('Then only the .pack is touched and no loose file appears', async () => {
        // Arrange
        const ctx = await contextWithAlternate();
        const id = await packedBlobIn(ctx, PRIMARY, 'packed');
        const base = packPath(PRIMARY, 'packed');
        vi.setSystemTime(NOW);

        // Act
        const sut = freshenObject;
        const result = await sut(ctx, id);

        // Assert
        expect(result).toBe(true);
        expect(await mtimeOf(ctx, `${base}.pack`)).toBe(NOW);
        expect(await mtimeOf(ctx, `${base}.idx`)).toBe(THEN);
        expect(await looseMissing(ctx, id)).toBe(true);
      });
    });
  });

  describe('Given no source holds the object', () => {
    describe('When freshenObject', () => {
      it('Then false is returned', async () => {
        // Arrange
        const ctx = await contextWithAlternate();

        // Act
        const sut = freshenObject;
        const result = await sut(ctx, 'a'.repeat(40) as ObjectId);

        // Assert
        expect(result).toBe(false);
      });
    });
  });

  describe('Given the object is held only by a cruft pack', () => {
    describe('When freshenObject', () => {
      it('Then false is returned and no cruft file is touched', async () => {
        // Arrange
        const ctx = await contextWithAlternate();
        const id = await packedBlobIn(ctx, PRIMARY, 'cruft');
        const base = packPath(PRIMARY, 'cruft');
        await ctx.fs.write(`${base}.mtimes`, new Uint8Array([0]));
        const utimeNow = vi.spyOn(ctx.fs, 'utimeNow');
        vi.setSystemTime(NOW);

        // Act
        const sut = freshenObject;
        const result = await sut(ctx, id);

        // Assert
        expect(result).toBe(false);
        expect(utimeNow).not.toHaveBeenCalled();
        expect(await mtimeOf(ctx, `${base}.pack`)).toBe(THEN);
      });
    });
  });

  describe('Given the object is held by a cruft pack and loose', () => {
    describe('When freshenObject', () => {
      it('Then the loose arm answers', async () => {
        // Arrange
        const ctx = await contextWithAlternate();
        const id = await packedBlobIn(ctx, PRIMARY, 'cruft2');
        await ctx.fs.write(`${packPath(PRIMARY, 'cruft2')}.mtimes`, new Uint8Array([0]));
        const looseId = await looseBlobIn(ctx, PRIMARY, 'cruft2');
        vi.setSystemTime(NOW);

        // Act
        const sut = freshenObject;
        const result = await sut(ctx, looseId);

        // Assert
        expect(looseId).toBe(id);
        expect(result).toBe(true);
        expect(await mtimeOf(ctx, `${PRIMARY}/${computeLooseObjectPath(id)}`)).toBe(NOW);
      });
    });
  });

  describe('Given the same pack is freshened twice in a session', () => {
    describe('When freshenObject runs for two objects of that pack', () => {
      it('Then utimeNow is called once', async () => {
        // Arrange
        const ctx = await contextWithAlternate();
        const [first, second] = await writeSyntheticPackIn(ctx, PRIMARY, 'twice', [
          { kind: 'base', type: 'blob', content: ENC.encode('one') },
          { kind: 'base', type: 'blob', content: ENC.encode('two') },
        ]);
        const utimeNow = vi.spyOn(ctx.fs, 'utimeNow');

        // Act
        const sut = freshenObject;
        const results = [await sut(ctx, first as ObjectId), await sut(ctx, second as ObjectId)];

        // Assert
        expect(results).toEqual([true, true]);
        expect(utimeNow).toHaveBeenCalledTimes(1);
        expect(utimeNow).toHaveBeenCalledWith(`${packPath(PRIMARY, 'twice')}.pack`);
      });
    });
  });

  describe('Given utimeNow is refused with an adapter code', () => {
    describe('When freshenObject', () => {
      it('Then false is returned and the refusal is logged with its path and code', async () => {
        // Arrange
        const ctx = await contextWithAlternate();
        const debug = vi.fn();
        const logged = { ...ctx, logger: { debug } } as Context;
        const id = await looseBlobIn(ctx, PRIMARY, 'refused');
        const path = `${PRIMARY}/${computeLooseObjectPath(id)}`;
        vi.spyOn(ctx.fs, 'utimeNow').mockRejectedValue(permissionDenied(path));

        // Act
        const sut = freshenObject;
        const result = await sut(logged, id);

        // Assert
        expect(result).toBe(false);
        expect(debug).toHaveBeenCalledWith('objectStore: freshen refused', {
          path,
          code: 'PERMISSION_DENIED',
        });
      });
    });
  });

  describe('Given a pack whose first freshen is refused and whose second is allowed', () => {
    describe('When freshenObject runs twice for an object of that pack', () => {
      it('Then the refusal is not remembered and the second call touches the pack', async () => {
        // Arrange
        const ctx = await contextWithAlternate();
        const id = await packedBlobIn(ctx, PRIMARY, 'refused-once');
        const path = `${packPath(PRIMARY, 'refused-once')}.pack`;
        const utimeNow = vi
          .spyOn(ctx.fs, 'utimeNow')
          .mockRejectedValueOnce(permissionDenied(path))
          .mockResolvedValue(undefined);

        // Act
        const sut = freshenObject;
        const results = [await sut(ctx, id), await sut(ctx, id)];

        // Assert
        expect(results).toEqual([false, true]);
        expect(utimeNow).toHaveBeenCalledTimes(2);
      });
    });
  });

  describe('Given the filesystem has no utimeNow', () => {
    describe('When freshenObject for a loose and a packed object', () => {
      it('Then false is returned for both', async () => {
        // Arrange
        const ctx = await contextWithAlternate();
        Object.defineProperty(ctx.fs, 'utimeNow', { value: undefined });
        const loose = await looseBlobIn(ctx, PRIMARY, 'l');
        const packed = await packedBlobIn(ctx, PRIMARY, 'p');

        // Act
        const sut = freshenObject;
        const results = [await sut(ctx, loose), await sut(ctx, packed)];

        // Assert
        expect(results).toEqual([false, false]);
      });
    });
  });

  describe('Given an alternate holds the object', () => {
    describe('When it is loose there', () => {
      it('Then the alternate file is touched', async () => {
        // Arrange
        const ctx = await contextWithAlternate();
        const id = await looseBlobIn(ctx, ALTERNATE, 'alt loose');
        vi.setSystemTime(NOW);

        // Act
        const sut = freshenObject;
        const result = await sut(ctx, id);

        // Assert
        expect(result).toBe(true);
        expect(await mtimeOf(ctx, `${ALTERNATE}/${computeLooseObjectPath(id)}`)).toBe(NOW);
      });
    });

    describe('When it is packed there', () => {
      it('Then the alternate .pack is touched', async () => {
        // Arrange
        const ctx = await contextWithAlternate();
        const id = await packedBlobIn(ctx, ALTERNATE, 'alt packed');
        vi.setSystemTime(NOW);

        // Act
        const sut = freshenObject;
        const result = await sut(ctx, id);

        // Assert
        expect(result).toBe(true);
        expect(await mtimeOf(ctx, `${packPath(ALTERNATE, 'alt packed')}.pack`)).toBe(NOW);
      });
    });
  });

  describe('Given the primary refuses the touch and an alternate holds the object', () => {
    describe('When freshenObject', () => {
      it('Then the next source is tried and answers', async () => {
        // Arrange
        const ctx = await contextWithAlternate();
        const id = await looseBlobIn(ctx, PRIMARY, 'both');
        await looseBlobIn(ctx, ALTERNATE, 'both');
        const primaryPath = `${PRIMARY}/${computeLooseObjectPath(id)}`;
        const real = ctx.fs.utimeNow?.bind(ctx.fs);
        vi.spyOn(ctx.fs, 'utimeNow').mockImplementation(async (path) => {
          if (path === primaryPath) throw permissionDenied(path);
          await real?.(path);
        });
        vi.setSystemTime(NOW);

        // Act
        const sut = freshenObject;
        const result = await sut(ctx, id);

        // Assert
        expect(result).toBe(true);
        expect(await mtimeOf(ctx, primaryPath)).toBe(THEN);
        expect(await mtimeOf(ctx, `${ALTERNATE}/${computeLooseObjectPath(id)}`)).toBe(NOW);
      });
    });
  });

  describe('Given utimeNow throws something that is not an adapter error', () => {
    describe('When freshenObject', () => {
      it('Then it propagates', async () => {
        // Arrange
        const ctx = await contextWithAlternate();
        const id = await looseBlobIn(ctx, PRIMARY, 'boom');
        const failure = new Error('boom');
        vi.spyOn(ctx.fs, 'utimeNow').mockRejectedValue(failure);

        // Act
        const sut = freshenObject;
        const attempt = sut(ctx, id);

        // Assert
        await expect(attempt).rejects.toBe(failure);
      });
    });
  });

  describe('Given an adapter refusal that is a plain coded error', () => {
    describe('When freshenObject', () => {
      it('Then a FILE_NOT_FOUND race also yields false', async () => {
        // Arrange
        const ctx = await contextWithAlternate();
        const id = await looseBlobIn(ctx, PRIMARY, 'race');
        vi.spyOn(ctx.fs, 'utimeNow').mockRejectedValue(fileNotFound('x'));

        // Act
        const sut = freshenObject;
        const result = await sut(ctx, id);

        // Assert
        expect(result).toBe(false);
      });
    });
  });

  describe('Given an alternate with a corrupt multi-pack-index', () => {
    describe('When freshenObject for an unknown object', () => {
      it('Then it rejects with INVALID_MULTI_PACK_INDEX', async () => {
        // Arrange
        const ctx = await contextWithAlternate();
        await ctx.fs.write(`${ALTERNATE}/pack/multi-pack-index`, FLIPPED_SIGNATURE_MIDX);

        // Act
        const sut = freshenObject;
        const data = await rejectionData(sut(ctx, 'b'.repeat(40) as ObjectId));

        // Assert
        expect(data).toMatchObject({ code: 'INVALID_MULTI_PACK_INDEX' });
      });
    });
  });

  describe('Given a loose copy added to an alternate after its fanout listing was cached', () => {
    describe('When freshenObject again', () => {
      it('Then the cached listing is trusted and false is returned', async () => {
        // Arrange
        const ctx = await contextWithAlternate();
        const id = (await ctx.hash.hashHex(blobBytes('late'))) as ObjectId;
        const sut = freshenObject;
        await sut(ctx, id);
        await looseBlobIn(ctx, ALTERNATE, 'late');

        // Act
        const result = await sut(ctx, id);

        // Assert
        expect(result).toBe(false);
      });
    });
  });
});
