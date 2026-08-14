import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import {
  packPositionMap,
  revIndexPositions,
} from '../../../../../src/application/primitives/internal/pack-positions.js';
import {
  buildIdx,
  buildRev,
  writePackArtifacts,
} from '../../../../../src/application/primitives/internal/write-pack-artifacts.js';
import { TsgitError } from '../../../../../src/domain/index.js';
import type { PackIndexWriterEntry } from '../../../../../src/domain/storage/index.js';
import { parsePackIndex, parsePackRevIndex } from '../../../../../src/domain/storage/index.js';
import type { Context } from '../../../../../src/ports/context.js';

const PACK_SHA = 'f'.repeat(40);
const PACK_BYTES = new TextEncoder().encode('fake-pack-bytes');

const buildEntries = (count: number): PackIndexWriterEntry[] =>
  Array.from({ length: count }, (_, i) => ({
    id: (i + 1).toString(16).padStart(40, '0'),
    crc32: i + 1,
    offset: 12 + i * 20,
  }));

const packDirOf = (ctx: Context): string => `${ctx.layout.gitDir}/objects/pack`;

const seedConfig = async (ctx: Context, content: string): Promise<void> => {
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, content);
};

interface BadBooleanData {
  readonly code: string;
  readonly key: string;
  readonly value: string;
}

describe('buildRev', () => {
  describe('Given a set of writer entries and a verified pack checksum', () => {
    describe('When buildRev computes the file bytes', () => {
      it('Then the trailer holds the digest of everything before it, and the bytes reparse cleanly', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const entries = buildEntries(4);
        const sut = buildRev;

        // Act
        const revBytes = await sut(ctx, entries, PACK_SHA);

        // Assert
        const trailerStart = revBytes.length - ctx.hash.digestLength;
        const expectedDigest = await ctx.hash.hash(revBytes.subarray(0, trailerStart));
        expect(revBytes.subarray(trailerStart)).toEqual(expectedDigest);
        expect(() =>
          parsePackRevIndex(revBytes, ctx.hash.digestLength, entries.length),
        ).not.toThrow();
      });

      it('Then its body matches the independent packPositionMap/parsePackIndex oracle', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const entries = buildEntries(4);
        const sut = buildRev;

        // Act
        const revBytes = await sut(ctx, entries, PACK_SHA);

        // Assert
        const idxBytes = await buildIdx(ctx, entries, PACK_SHA);
        const expected = packPositionMap(parsePackIndex(idxBytes));
        const parsedRev = parsePackRevIndex(revBytes, ctx.hash.digestLength, entries.length);
        const actual = revIndexPositions(parsedRev, entries.length);
        expect(actual).toEqual(expected);
      });
    });
  });
});

describe('writePackArtifacts', () => {
  describe('Given no [pack] section in config', () => {
    describe('When writePackArtifacts runs', () => {
      it('Then it writes .pack, .idx and .rev', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const entries = buildEntries(3);
        const dir = packDirOf(ctx);
        const sut = writePackArtifacts;

        // Act
        await sut(ctx, {
          packDir: dir,
          packBytes: PACK_BYTES,
          entries,
          packSha: PACK_SHA,
          promisor: false,
        });

        // Assert
        const names = (await ctx.fs.readdir(dir)).map((e) => e.name).sort();
        expect(names).toEqual(
          [`pack-${PACK_SHA}.idx`, `pack-${PACK_SHA}.pack`, `pack-${PACK_SHA}.rev`].sort(),
        );
      });
    });
  });

  describe('Given pack.writeReverseIndex = false', () => {
    describe('When writePackArtifacts runs', () => {
      it('Then only .pack and .idx are written, with unchanged bytes', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seedConfig(ctx, '[pack]\n\twriteReverseIndex = false\n');
        const entries = buildEntries(3);
        const dir = packDirOf(ctx);
        const sut = writePackArtifacts;

        // Act
        await sut(ctx, {
          packDir: dir,
          packBytes: PACK_BYTES,
          entries,
          packSha: PACK_SHA,
          promisor: false,
        });

        // Assert
        const entryNames = (await ctx.fs.readdir(dir)).map((e) => e.name);
        expect(entryNames).toHaveLength(2);
        expect(entryNames.some((name) => name.endsWith('.rev'))).toBe(false);
        expect(await ctx.fs.read(`${dir}/pack-${PACK_SHA}.pack`)).toEqual(PACK_BYTES);
        expect(await ctx.fs.read(`${dir}/pack-${PACK_SHA}.idx`)).toEqual(
          await buildIdx(ctx, entries, PACK_SHA),
        );
      });
    });
  });

  describe.each([
    { value: '0', label: '= 0', expectRev: false },
    { value: '2', label: '= 2', expectRev: true },
  ])('Given pack.writeReverseIndex $label', ({ value, expectRev }) => {
    describe('When writePackArtifacts runs', () => {
      it(`Then .rev is ${expectRev ? 'written' : 'suppressed'}`, async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seedConfig(ctx, `[pack]\n\twriteReverseIndex = ${value}\n`);
        const entries = buildEntries(2);
        const dir = packDirOf(ctx);
        const sut = writePackArtifacts;

        // Act
        await sut(ctx, {
          packDir: dir,
          packBytes: PACK_BYTES,
          entries,
          packSha: PACK_SHA,
          promisor: false,
        });

        // Assert
        const names = (await ctx.fs.readdir(dir)).map((e) => e.name);
        expect(names.some((name) => name.endsWith('.rev'))).toBe(expectRev);
      });
    });
  });

  describe('Given a valueless pack.writeReverseIndex', () => {
    describe('When writePackArtifacts runs', () => {
      it('Then .rev is written', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seedConfig(ctx, '[pack]\n\twriteReverseIndex\n');
        const entries = buildEntries(2);
        const dir = packDirOf(ctx);
        const sut = writePackArtifacts;

        // Act
        await sut(ctx, {
          packDir: dir,
          packBytes: PACK_BYTES,
          entries,
          packSha: PACK_SHA,
          promisor: false,
        });

        // Assert
        const names = (await ctx.fs.readdir(dir)).map((e) => e.name);
        expect(names.some((name) => name.endsWith('.rev'))).toBe(true);
      });
    });
  });

  describe('Given pack.writeReverseIndex holds a value git refuses', () => {
    describe('When writePackArtifacts runs', () => {
      it('Then it throws CONFIG_BAD_BOOLEAN_VALUE before the pack directory exists', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seedConfig(ctx, '[pack]\n\twriteReverseIndex = maybe\n');
        const entries = buildEntries(2);
        const dir = packDirOf(ctx);
        const sut = writePackArtifacts;

        // Act
        let caught: unknown;
        try {
          await sut(ctx, {
            packDir: dir,
            packBytes: PACK_BYTES,
            entries,
            packSha: PACK_SHA,
            promisor: false,
          });
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        const data = (caught as TsgitError).data as BadBooleanData;
        expect(data.code).toBe('CONFIG_BAD_BOOLEAN_VALUE');
        expect(data.key).toBe('pack.writereverseindex');
        expect(data.value).toBe('maybe');
        expect(await ctx.fs.exists(dir)).toBe(false);
      });
    });
  });

  describe('Given promisor: true', () => {
    describe('When the gate defaults to writing the .rev', () => {
      it('Then all four artefacts are written', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const entries = buildEntries(2);
        const dir = packDirOf(ctx);
        const sut = writePackArtifacts;

        // Act
        await sut(ctx, {
          packDir: dir,
          packBytes: PACK_BYTES,
          entries,
          packSha: PACK_SHA,
          promisor: true,
        });

        // Assert
        const names = (await ctx.fs.readdir(dir)).map((e) => e.name);
        expect(names).toHaveLength(4);
        expect(names.some((name) => name.endsWith('.promisor'))).toBe(true);
        expect(names.some((name) => name.endsWith('.rev'))).toBe(true);
      });
    });

    describe('When the gate suppresses the .rev', () => {
      it('Then three artefacts are written, the sentinel among them', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seedConfig(ctx, '[pack]\n\twriteReverseIndex = false\n');
        const entries = buildEntries(2);
        const dir = packDirOf(ctx);
        const sut = writePackArtifacts;

        // Act
        await sut(ctx, {
          packDir: dir,
          packBytes: PACK_BYTES,
          entries,
          packSha: PACK_SHA,
          promisor: true,
        });

        // Assert
        const names = (await ctx.fs.readdir(dir)).map((e) => e.name);
        expect(names).toHaveLength(3);
        expect(names.some((name) => name.endsWith('.promisor'))).toBe(true);
        expect(names.some((name) => name.endsWith('.rev'))).toBe(false);
      });
    });
  });

  describe('Given writeExclusive rejects for the .rev path', () => {
    describe('When writePackArtifacts runs', () => {
      it('Then the rejection propagates and .pack/.idx remain on disk', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const entries = buildEntries(2);
        const dir = packDirOf(ctx);
        const failingFs: Context['fs'] = {
          ...ctx.fs,
          writeExclusive: async (path: string, data: Uint8Array) => {
            if (path.endsWith('.rev')) {
              throw new TsgitError({ code: 'PERMISSION_DENIED', path });
            }
            return ctx.fs.writeExclusive(path, data);
          },
        };
        const failingCtx: Context = { ...ctx, fs: failingFs };
        const sut = writePackArtifacts;

        // Act
        let caught: unknown;
        try {
          await sut(failingCtx, {
            packDir: dir,
            packBytes: PACK_BYTES,
            entries,
            packSha: PACK_SHA,
            promisor: false,
          });
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as TsgitError).data.code).toBe('PERMISSION_DENIED');
        expect(await ctx.fs.exists(`${dir}/pack-${PACK_SHA}.pack`)).toBe(true);
        expect(await ctx.fs.exists(`${dir}/pack-${PACK_SHA}.idx`)).toBe(true);
      });
    });
  });

  describe('Given zero entries', () => {
    describe('When writePackArtifacts runs', () => {
      it('Then a header-only 52-byte .rev is still written beside .pack/.idx', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const dir = packDirOf(ctx);
        const sut = writePackArtifacts;

        // Act
        await sut(ctx, {
          packDir: dir,
          packBytes: PACK_BYTES,
          entries: [],
          packSha: PACK_SHA,
          promisor: false,
        });

        // Assert
        const revBytes = await ctx.fs.read(`${dir}/pack-${PACK_SHA}.rev`);
        expect(revBytes.length).toBe(52);
      });
    });
  });
});
