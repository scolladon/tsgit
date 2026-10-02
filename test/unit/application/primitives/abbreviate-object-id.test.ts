import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { abbreviateObjectId } from '../../../../src/application/primitives/abbreviate-object-id.js';
import { getObjectStore } from '../../../../src/application/primitives/object-store.js';
import type { TsgitError } from '../../../../src/domain/error.js';
import type { ObjectId } from '../../../../src/domain/objects/index.js';
import type { Context } from '../../../../src/ports/context.js';
import { writeSyntheticPackIn } from './pack-fixture.js';

const ALT_OBJECTS = '/repo/alt/objects';
const FLIPPED_SIGNATURE_MIDX = Uint8Array.from([
  0x00,
  0x49,
  0x44,
  0x58,
  1,
  1,
  1,
  0,
  ...new Array(8).fill(0),
]);

const oidOf = (prefix: string, fill: string): ObjectId =>
  (prefix + fill.repeat(40 - prefix.length)) as ObjectId;

const borrowerContext = async (): Promise<Context> => {
  const ctx = createMemoryContext({
    files: {
      '/repo/.git/objects/info/alternates': new TextEncoder().encode(`${ALT_OBJECTS}\n`),
    },
  });
  await ctx.fs.mkdir(ALT_OBJECTS);
  return ctx;
};

const writeLooseIn = async (ctx: Context, objectsDir: string, oid: string): Promise<void> => {
  await ctx.fs.write(`${objectsDir}/${oid.slice(0, 2)}/${oid.slice(2)}`, new Uint8Array([1]));
};

const writeLoose = (ctx: Context, oid: string): Promise<void> =>
  writeLooseIn(ctx, `${ctx.layout.gitDir}/objects`, oid);

const writeConfig = (ctx: Context, text: string): Promise<void> =>
  ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, text);

/** Makes a source's registry report `count` packed objects through one real, tiny pack. */
const reportPackedObjects = async (
  ctx: Context,
  objectsDir: string,
  source: Awaited<ReturnType<typeof getObjectStore>>['primary'],
  count: number,
): Promise<void> => {
  await writeSyntheticPackIn(ctx, objectsDir, 'p', [
    { kind: 'base', type: 'blob', content: new Uint8Array([1, 2, 3]) },
  ]);
  const [pack] = await source.registry.all();
  if (pack === undefined) throw new Error('expected a registered pack');
  const index = await pack.index();
  vi.spyOn(source.registry, 'all').mockResolvedValue([
    { ...pack, index: async () => ({ ...index, objectCount: count }) },
  ]);
};

const refusalData = async (attempt: Promise<unknown>): Promise<unknown> => {
  try {
    await attempt;
  } catch (error) {
    return (error as TsgitError).data;
  }
  return undefined;
};

/** A primary loose object and an alternate object (loose or packed) sharing seven hex chars. */
const rivalPair = async (
  ctx: Context,
  packed: boolean,
): Promise<{ mine: ObjectId; theirs: ObjectId }> => {
  if (!packed) {
    await writeLoose(ctx, oidOf('abcdef0', '1'));
    await writeLooseIn(ctx, ALT_OBJECTS, oidOf('abcdef0', '2'));
    return { mine: oidOf('abcdef0', '1'), theirs: oidOf('abcdef0', '2') };
  }
  const [id] = await writeSyntheticPackIn(ctx, ALT_OBJECTS, 'r', [
    { kind: 'base', type: 'blob', content: new TextEncoder().encode('rival') },
  ]);
  const theirs = id as ObjectId;
  const mine = oidOf(theirs.slice(0, 7), theirs[7] === '1' ? '2' : '1');
  await writeLoose(ctx, mine);
  return { mine, theirs };
};

describe('abbreviateObjectId', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // git: len = ceil((msb(count) + 1) / 2), floored at 7.
  //   8191  -> msb 12 -> 13 -> 7      8192  -> msb 13 -> 14 -> 7
  //   16384 -> msb 14 -> 15 -> 8      32768 -> msb 15 -> 16 -> 8
  //   65536 -> msb 16 -> 17 -> 9      0     -> floor        -> 7
  describe.each([
    [0, 7],
    [2 ** 13 - 1, 7],
    [2 ** 13, 7],
    [2 ** 14, 8],
    [2 ** 15, 8],
    [2 ** 16, 9],
  ])('Given %i packed objects and core.abbrev unset', (count, expected) => {
    describe('When abbreviating a unique id', () => {
      it(`Then the length is ${expected}`, async () => {
        // Arrange
        const ctx = createMemoryContext();
        const { primary } = await getObjectStore(ctx);
        await reportPackedObjects(ctx, `${ctx.layout.gitDir}/objects`, primary, count);
        const id = oidOf('abcdef0', '1');

        // Act
        const sut = abbreviateObjectId;
        const result = await sut(ctx, id);

        // Assert
        expect(result).toBe(id.slice(0, expected));
      });
    });
  });

  describe('Given 2^13 packed objects in the primary and 2^13 in an alternate', () => {
    describe('When abbreviating a unique id', () => {
      it('Then the count sums every source', async () => {
        // Arrange
        const ctx = await borrowerContext();
        const { primary, sources } = await getObjectStore(ctx);
        const [, alternate = primary] = sources;
        await reportPackedObjects(ctx, `${ctx.layout.gitDir}/objects`, primary, 2 ** 13);
        await reportPackedObjects(ctx, ALT_OBJECTS, alternate, 2 ** 13);
        const id = oidOf('abcdef0', '1');

        // Act
        const sut = abbreviateObjectId;
        const result = await sut(ctx, id);

        // Assert
        expect(result).toBe(id.slice(0, 8));
      });
    });
  });

  describe('Given no packed objects', () => {
    describe('When abbreviating with core.abbrev unset', () => {
      it('Then the length is the floor of 7', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const id = oidOf('abcdef0', '1');

        // Act
        const sut = abbreviateObjectId;
        const result = await sut(ctx, id);

        // Assert
        expect(result).toBe('abcdef0');
      });
    });
  });

  describe.each([
    ['4', 4],
    ['12', 12],
    ['auto', 7],
    ['no', 40],
    ['false', 40],
    ['40', 40],
    ['99', 40],
  ])('Given core.abbrev = %s', (raw, expected) => {
    describe('When abbreviating a unique id', () => {
      it(`Then the length is ${expected}`, async () => {
        // Arrange
        const ctx = createMemoryContext();
        await writeConfig(ctx, `[core]\n\tabbrev = ${raw}\n`);
        const id = oidOf('abcdef0', '1');

        // Act
        const sut = abbreviateObjectId;
        const result = await sut(ctx, id);

        // Assert
        expect(result).toBe(id.slice(0, expected));
      });
    });
  });

  describe('Given core.abbrev = 4 and a rival sharing five hex chars', () => {
    describe('When abbreviating', () => {
      it('Then the length extends past the configured base', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await writeConfig(ctx, '[core]\n\tabbrev = 4\n');
        await writeLoose(ctx, oidOf('abcde1', '1'));
        const id = oidOf('abcde0', '1');

        // Act
        const sut = abbreviateObjectId;
        const result = await sut(ctx, id);

        // Assert
        expect(result).toBe('abcde0');
      });
    });
  });

  describe('Given a core.abbrev key with no value', () => {
    describe('When abbreviating', () => {
      it('Then it refuses with CONFIG_MISSING_VALUE', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await writeConfig(ctx, '[core]\n\tabbrev\n');

        // Act
        const sut = abbreviateObjectId;
        const data = await refusalData(sut(ctx, oidOf('abcdef0', '1')));

        // Assert
        expect(data).toMatchObject({ code: 'CONFIG_MISSING_VALUE', key: 'core.abbrev', line: 2 });
      });
    });
  });

  describe.each([
    ['loose in the alternate', false],
    ['packed in the alternate', true],
  ])('Given a primary object and a rival %s sharing seven hex chars', (_label, packed) => {
    describe('When abbreviating each of them', () => {
      it('Then each is one char longer than the shared prefix', async () => {
        // Arrange
        const ctx = await borrowerContext();
        const { mine, theirs } = await rivalPair(ctx, packed);

        // Act
        const sut = abbreviateObjectId;
        const own = await sut(ctx, mine);
        const other = await sut(ctx, theirs);

        // Assert
        expect(own).toBe(mine.slice(0, 8));
        expect(other).toBe(theirs.slice(0, 8));
      });
    });
  });

  describe('Given an alternate object sharing only six hex chars', () => {
    describe('When abbreviating', () => {
      it('Then the length stays at the base', async () => {
        // Arrange
        const ctx = await borrowerContext();
        await writeLoose(ctx, oidOf('abcdef0', '1'));
        await writeLooseIn(ctx, ALT_OBJECTS, oidOf('abcdef1', '1'));

        // Act
        const sut = abbreviateObjectId;
        const result = await sut(ctx, oidOf('abcdef0', '1'));

        // Assert
        expect(result).toBe('abcdef0');
      });
    });
  });

  describe('Given the id is present in two sources', () => {
    describe('When abbreviating', () => {
      it('Then it is not its own rival', async () => {
        // Arrange
        const ctx = await borrowerContext();
        const id = oidOf('abcdef0', '1');
        await writeLoose(ctx, id);
        await writeLooseIn(ctx, ALT_OBJECTS, id);

        // Act
        const sut = abbreviateObjectId;
        const result = await sut(ctx, id);

        // Assert
        expect(result).toBe('abcdef0');
      });
    });
  });

  describe('Given a rival sharing all but the last hex char', () => {
    describe('When abbreviating', () => {
      it('Then the result is the full id', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await writeLoose(ctx, `${'a'.repeat(39)}1`);
        const id = `${'a'.repeat(39)}0` as ObjectId;

        // Act
        const sut = abbreviateObjectId;
        const result = await sut(ctx, id);

        // Assert
        expect(result).toBe(id);
      });
    });
  });

  describe('Given an alternate whose multi-pack-index is corrupt', () => {
    describe('When abbreviating', () => {
      it('Then it refuses with the alternate error', async () => {
        // Arrange
        const ctx = await borrowerContext();
        await ctx.fs.write(`${ALT_OBJECTS}/pack/multi-pack-index`, FLIPPED_SIGNATURE_MIDX);

        // Act
        const sut = abbreviateObjectId;
        const data = await refusalData(sut(ctx, oidOf('abcdef0', '1')));

        // Assert
        expect(data).toMatchObject({ code: 'INVALID_MULTI_PACK_INDEX' });
      });
    });
  });
});
