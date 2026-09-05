import { describe, expect, it, vi } from 'vitest';
import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import {
  packPositionMap,
  revIndexPositions,
} from '../../../../../src/application/primitives/internal/pack-positions.js';
import {
  buildIdx,
  buildRev,
  writePackArtifacts,
  writePackArtifactsViaQuarantine,
  writePackSiblingArtifacts,
} from '../../../../../src/application/primitives/internal/write-pack-artifacts.js';
import { TsgitError } from '../../../../../src/domain/index.js';
import type { PackIndexEntries } from '../../../../../src/domain/storage/index.js';
import {
  parsePackIndex,
  parsePackRevIndex,
  sortPackIndexEntries,
} from '../../../../../src/domain/storage/index.js';
import type { Context } from '../../../../../src/ports/context.js';
import { packIndexEntriesOf } from '../../../../fixtures/storage/pack-index-entries.js';

const PACK_SHA = 'f'.repeat(40);
const PACK_BYTES = new TextEncoder().encode('fake-pack-bytes');

const buildEntries = (count: number): PackIndexEntries =>
  packIndexEntriesOf(
    Array.from({ length: count }, (_, i) => ({
      id: (i + 1).toString(16).padStart(40, '0'),
      crc32: i + 1,
      offset: 12 + i * 20,
    })),
    20,
  );

/** Returns a `PackIndexEntries` whose backing arrays are deliberately longer
 *  than `count` — the over-allocated-producer shape `count`, not `.length`,
 *  must be read against. */
const overAllocated = (base: PackIndexEntries, extraCapacity: number): PackIndexEntries => {
  const oids = new Uint8Array(base.oids.length + extraCapacity * base.digestLength);
  const crcValues = new Uint32Array(base.crcValues.length + extraCapacity);
  const offsets = new Float64Array(base.offsets.length + extraCapacity);
  oids.set(base.oids);
  crcValues.set(base.crcValues);
  offsets.set(base.offsets);
  return { count: base.count, digestLength: base.digestLength, oids, crcValues, offsets };
};

const packDirOf = (ctx: Context): string => `${ctx.layout.gitDir}/objects/pack`;

const seedConfig = async (ctx: Context, content: string): Promise<void> => {
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, content);
};

interface BadBooleanData {
  readonly code: string;
  readonly key: string;
  readonly value: string;
}

describe('buildIdx', () => {
  describe('Given a set of writer entries and a verified pack checksum', () => {
    describe('When buildIdx computes the file bytes', () => {
      it('Then the second trailer holds the digest of everything before it, and the bytes reparse cleanly', async () => {
        // Arrange — serializePackIndex leaves this trailer ZEROED; only
        // buildIdx's in-place fill makes it the real digest, so a zeroed
        // trailer surviving here (rather than only failing against real
        // git in the interop suite) is what pins the fill inside this
        // unit's own scope.
        const ctx = createMemoryContext();
        const entries = buildEntries(4);
        const sorted = sortPackIndexEntries(entries);
        const sut = buildIdx;

        // Act
        const idxBytes = await sut(ctx, sorted, PACK_SHA);

        // Assert
        const digestStart = idxBytes.length - ctx.hash.digestLength;
        const expectedDigest = await ctx.hash.hash(idxBytes.subarray(0, digestStart));
        expect(idxBytes.subarray(digestStart)).toEqual(expectedDigest);
        expect(() => parsePackIndex(idxBytes, ctx.hash.digestLength)).not.toThrow();
      });
    });
  });
});

describe('buildRev', () => {
  describe('Given a set of writer entries and a verified pack checksum', () => {
    describe('When buildRev computes the file bytes', () => {
      it('Then the trailer holds the digest of everything before it, and the bytes reparse cleanly', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const entries = buildEntries(4);
        const sorted = sortPackIndexEntries(entries);
        const sut = buildRev;

        // Act
        const revBytes = await sut(ctx, sorted, PACK_SHA);

        // Assert
        const trailerStart = revBytes.length - ctx.hash.digestLength;
        const expectedDigest = await ctx.hash.hash(revBytes.subarray(0, trailerStart));
        expect(revBytes.subarray(trailerStart)).toEqual(expectedDigest);
        expect(() =>
          parsePackRevIndex(revBytes, ctx.hash.digestLength, entries.count),
        ).not.toThrow();
      });

      it('Then its body matches the independent packPositionMap/parsePackIndex oracle', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const entries = buildEntries(4);
        const sorted = sortPackIndexEntries(entries);
        const sut = buildRev;

        // Act
        const revBytes = await sut(ctx, sorted, PACK_SHA);

        // Assert
        const idxBytes = await buildIdx(ctx, sorted, PACK_SHA);
        const expected = packPositionMap(parsePackIndex(idxBytes, 20));
        const parsedRev = parsePackRevIndex(revBytes, ctx.hash.digestLength, entries.count);
        const actual = revIndexPositions(parsedRev, entries.count);
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
          await buildIdx(ctx, sortPackIndexEntries(entries), PACK_SHA),
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
          entries: buildEntries(0),
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

describe('writePackArtifactsViaQuarantine', () => {
  describe('Given promisor: true rewriting the SAME sha a prior call already wrote', () => {
    describe('When writePackArtifactsViaQuarantine runs a second time', () => {
      it('Then it succeeds rather than refusing FILE_EXISTS, and .promisor is still present', async () => {
        // Arrange — the no-op boundary (Pin W): a repeat build over an
        // unchanged oid set reproduces the identical sha, so the second
        // call's `.promisor` write finds its own sentinel from the FIRST
        // call already sitting at that exact path.
        const ctx = createMemoryContext();
        const entries = buildEntries(2);
        const dir = packDirOf(ctx);
        const sut = writePackArtifactsViaQuarantine;
        await sut(ctx, {
          packDir: dir,
          packBytes: PACK_BYTES,
          entries,
          packSha: PACK_SHA,
          promisor: true,
        });

        // Act
        await sut(ctx, {
          packDir: dir,
          packBytes: PACK_BYTES,
          entries,
          packSha: PACK_SHA,
          promisor: true,
        });

        // Assert
        expect(await ctx.fs.exists(`${dir}/pack-${PACK_SHA}.promisor`)).toBe(true);
      });
    });
  });

  describe('Given a normal (non-colliding) quarantine write', () => {
    describe('When writePackArtifactsViaQuarantine claims its tmp names', () => {
      it('Then both claimed names match the tmp_pack_/tmp_idx_ + 6-char alphabet shape exactly', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const entries = buildEntries(2);
        const dir = packDirOf(ctx);
        const sut = writePackArtifactsViaQuarantine;
        const claimedPaths: string[] = [];
        const originalWriteExclusive = ctx.fs.writeExclusive.bind(ctx.fs);
        const spy = vi
          .spyOn(ctx.fs, 'writeExclusive')
          .mockImplementation(async (path: string, data: Uint8Array) => {
            claimedPaths.push(path);
            return originalWriteExclusive(path, data);
          });

        // Act
        await sut(ctx, {
          packDir: dir,
          packBytes: PACK_BYTES,
          entries,
          packSha: PACK_SHA,
          promisor: false,
        });
        spy.mockRestore();

        // Assert — exactly `tmp_pack_`/`tmp_idx_` + 6 alphabet characters,
        // no more, no fewer: a mutant that drops the suffix loop or
        // off-by-ones it breaks this exact shape. (Index-corruption mutants
        // keep the shape — the pinned-random test below owns those.)
        const tmpPaths = claimedPaths.filter((p) => p.includes('/tmp_'));
        expect(tmpPaths).toHaveLength(2);
        expect(tmpPaths.some((p) => /\/tmp_pack_[A-Za-z0-9]{6}$/.test(p))).toBe(true);
        expect(tmpPaths.some((p) => /\/tmp_idx_[A-Za-z0-9]{6}$/.test(p))).toBe(true);
      });
    });
  });

  describe('Given Math.random pinned to just under 1', () => {
    describe('When writePackArtifactsViaQuarantine claims its tmp names', () => {
      it('Then every suffix character is the LAST alphabet entry — the random index scales across the whole alphabet', async () => {
        // Arrange — with random() = 0.999…, `floor(random * len)` picks the
        // final alphabet character ('9') in every position; an index that is
        // divided instead of multiplied (or floored away) collapses to the
        // first character regardless of the draw. Shape checks cannot see
        // that — only pinning the draw makes the index arithmetic
        // observable.
        const ctx = createMemoryContext();
        const entries = buildEntries(2);
        const dir = packDirOf(ctx);
        const sut = writePackArtifactsViaQuarantine;
        const claimedPaths: string[] = [];
        const originalWriteExclusive = ctx.fs.writeExclusive.bind(ctx.fs);
        const writeSpy = vi
          .spyOn(ctx.fs, 'writeExclusive')
          .mockImplementation(async (path: string, data: Uint8Array) => {
            claimedPaths.push(path);
            return originalWriteExclusive(path, data);
          });
        const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.9999);

        // Act
        try {
          await sut(ctx, {
            packDir: dir,
            packBytes: PACK_BYTES,
            entries,
            packSha: PACK_SHA,
            promisor: false,
          });
        } finally {
          randomSpy.mockRestore();
          writeSpy.mockRestore();
        }

        // Assert — '9' is the 62nd (last) alphabet character.
        const tmpPaths = claimedPaths.filter((p) => p.includes('/tmp_'));
        expect(tmpPaths.some((p) => p.endsWith('/tmp_pack_999999'))).toBe(true);
        expect(tmpPaths.some((p) => p.endsWith('/tmp_idx_999999'))).toBe(true);
      });
    });
  });

  describe('Given the stale .rev removal fails with something other than FILE_NOT_FOUND', () => {
    describe('When writePackArtifactsViaQuarantine runs', () => {
      it('Then the PERMISSION_DENIED failure propagates rather than being swallowed as tolerable absence', async () => {
        // Arrange — `rmTolerant` must rethrow every code except
        // FILE_NOT_FOUND; a mutant that always treats the removal as
        // tolerable would swallow this and proceed to write `.rev` as if
        // nothing were wrong.
        const ctx = createMemoryContext();
        const entries = buildEntries(2);
        const dir = packDirOf(ctx);
        const sut = writePackArtifactsViaQuarantine;
        const revPath = `${dir}/pack-${PACK_SHA}.rev`;
        const originalRm = ctx.fs.rm.bind(ctx.fs);
        const spy = vi.spyOn(ctx.fs, 'rm').mockImplementation(async (path: string) => {
          if (path === revPath) throw new TsgitError({ code: 'PERMISSION_DENIED', path });
          return originalRm(path);
        });

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
        } catch (error) {
          caught = error;
        }
        spy.mockRestore();

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as TsgitError).data.code).toBe('PERMISSION_DENIED');
      });
    });
  });

  describe('Given the tmp .idx write fails after the tmp .pack already landed', () => {
    describe('When writePackArtifactsViaQuarantine runs', () => {
      it('Then no tmp_pack_*/tmp_idx_* debris is left behind', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const entries = buildEntries(2);
        const dir = packDirOf(ctx);
        const sut = writePackArtifactsViaQuarantine;
        const originalWriteExclusive = ctx.fs.writeExclusive.bind(ctx.fs);
        const spy = vi
          .spyOn(ctx.fs, 'writeExclusive')
          .mockImplementation(async (path: string, data: Uint8Array) => {
            if (path.includes('tmp_idx_')) throw new Error('injected-fault');
            return originalWriteExclusive(path, data);
          });

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
          expect.unreachable();
        } catch (error) {
          caught = error;
        }
        spy.mockRestore();

        // Assert
        expect(caught).toBeDefined();
        const remaining = (await ctx.fs.exists(dir))
          ? (await ctx.fs.readdir(dir)).map((e) => e.name)
          : [];
        expect(remaining.some((name) => name.startsWith('tmp_pack_'))).toBe(false);
        expect(remaining.some((name) => name.startsWith('tmp_idx_'))).toBe(false);
      });
    });
  });

  describe('Given the .idx rename fails after the .pack was already renamed into place', () => {
    describe('When writePackArtifactsViaQuarantine runs', () => {
      it('Then the tmp .idx is cleaned up rather than left as debris', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const entries = buildEntries(2);
        const dir = packDirOf(ctx);
        const sut = writePackArtifactsViaQuarantine;
        const originalRename = (ctx.fs.atomicRename ?? ctx.fs.rename).bind(ctx.fs);
        let renameCalls = 0;
        const renameKey = ctx.fs.atomicRename !== undefined ? 'atomicRename' : 'rename';
        const spy = vi
          .spyOn(ctx.fs, renameKey)
          .mockImplementation(async (from: string, to: string) => {
            renameCalls += 1;
            if (renameCalls === 2) throw new Error('injected-fault');
            return originalRename(from, to);
          });

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
          expect.unreachable();
        } catch (error) {
          caught = error;
        }
        spy.mockRestore();

        // Assert — the .pack landed at its final name (its own rename
        // already succeeded); only the tmp .idx debris is gone.
        expect(caught).toBeDefined();
        expect(await ctx.fs.exists(`${dir}/pack-${PACK_SHA}.pack`)).toBe(true);
        const remaining = (await ctx.fs.readdir(dir)).map((e) => e.name);
        expect(remaining.some((name) => name.startsWith('tmp_idx_'))).toBe(false);
      });
    });
  });

  describe('Given both renames succeed', () => {
    describe('When writePackArtifactsViaQuarantine finishes', () => {
      it('Then the cleanup finally block never re-attempts an rm on either already-renamed tmp path', async () => {
        // Arrange — `renamed.pack`/`renamed.idx` must actually record the
        // successful rename; a mutant that leaves either flag false (or
        // ignores it entirely) makes the `finally` block redundantly call
        // `rm` on a path that no longer exists.
        const ctx = createMemoryContext();
        const entries = buildEntries(2);
        const dir = packDirOf(ctx);
        const sut = writePackArtifactsViaQuarantine;
        const rmCalls: string[] = [];
        const originalRm = ctx.fs.rm.bind(ctx.fs);
        const rmSpy = vi.spyOn(ctx.fs, 'rm').mockImplementation(async (path: string) => {
          rmCalls.push(path);
          return originalRm(path);
        });

        // Act
        await sut(ctx, {
          packDir: dir,
          packBytes: PACK_BYTES,
          entries,
          packSha: PACK_SHA,
          promisor: false,
        });
        rmSpy.mockRestore();

        // Assert — no rm call ever targets a `tmp_pack_*`/`tmp_idx_*` path;
        // both were already renamed away.
        expect(rmCalls.some((p) => p.includes('/tmp_pack_'))).toBe(false);
        expect(rmCalls.some((p) => p.includes('/tmp_idx_'))).toBe(false);
      });
    });
  });

  describe('Given no [pack] section in config', () => {
    describe('When writePackArtifactsViaQuarantine runs', () => {
      it('Then .rev is written alongside .pack/.idx (the default gate)', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const entries = buildEntries(2);
        const dir = packDirOf(ctx);
        const sut = writePackArtifactsViaQuarantine;

        // Act
        await sut(ctx, {
          packDir: dir,
          packBytes: PACK_BYTES,
          entries,
          packSha: PACK_SHA,
          promisor: false,
        });

        // Assert
        expect(await ctx.fs.exists(`${dir}/pack-${PACK_SHA}.rev`)).toBe(true);
      });
    });
  });

  describe('Given pack.writeReverseIndex = false', () => {
    describe('When writePackArtifactsViaQuarantine runs', () => {
      it('Then .rev is suppressed', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seedConfig(ctx, '[pack]\n\twriteReverseIndex = false\n');
        const entries = buildEntries(2);
        const dir = packDirOf(ctx);
        const sut = writePackArtifactsViaQuarantine;

        // Act
        await sut(ctx, {
          packDir: dir,
          packBytes: PACK_BYTES,
          entries,
          packSha: PACK_SHA,
          promisor: false,
        });

        // Assert
        expect(await ctx.fs.exists(`${dir}/pack-${PACK_SHA}.rev`)).toBe(false);
      });
    });
  });

  describe('Given entries whose backing arrays are longer than count', () => {
    describe('When writePackArtifactsViaQuarantine runs', () => {
      it('Then objectCount reflects count, not the over-allocated array length', async () => {
        // Arrange — on a `buildPack`-produced slab, count and the arrays'
        // `.length` are equal, so nothing catches a `.length` regression
        // without an over-allocated fixture like this one.
        const ctx = createMemoryContext();
        const entries = overAllocated(buildEntries(2), 5);
        const dir = packDirOf(ctx);
        const sut = writePackArtifactsViaQuarantine;

        // Act
        const written = await sut(ctx, {
          packDir: dir,
          packBytes: PACK_BYTES,
          entries,
          packSha: PACK_SHA,
          promisor: false,
        });

        // Assert
        expect(written.objectCount).toBe(2);
      });
    });
  });
});

describe('writePackSiblingArtifacts', () => {
  describe('Given entries whose backing arrays are longer than count', () => {
    describe('When writePackSiblingArtifacts runs', () => {
      it('Then objectCount reflects count, not the over-allocated array length', async () => {
        // Arrange — same over-allocation hazard as writePackArtifactsViaQuarantine,
        // at writeSiblingsGiven's own `objectCount:` line.
        const ctx = createMemoryContext();
        const entries = overAllocated(buildEntries(3), 4);
        const dir = packDirOf(ctx);
        const sut = writePackSiblingArtifacts;

        // Act
        const written = await sut(ctx, {
          packDir: dir,
          entries,
          packSha: PACK_SHA,
          promisor: false,
        });

        // Assert
        expect(written.objectCount).toBe(3);
      });
    });
  });
});

describe('writePackSiblingArtifacts — artefacts already present', () => {
  const siblingInput = (packDir: string, entries: PackIndexEntries) => ({
    packDir,
    entries,
    packSha: PACK_SHA,
    promisor: false,
  });

  const expectMismatch = (caught: unknown, path: string): void => {
    expect(caught).toBeInstanceOf(TsgitError);
    if (!(caught instanceof TsgitError)) expect.unreachable();
    expect(caught.data.code).toBe('PACK_ARTIFACT_MISMATCH');
    if (caught.data.code !== 'PACK_ARTIFACT_MISMATCH') expect.unreachable();
    expect(caught.data.path).toBe(path);
  };

  describe('Given an identical .idx already occupying its sibling name', () => {
    describe('When writePackSiblingArtifacts runs', () => {
      it('Then it keeps the existing index untouched and still writes the .rev', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const entries = buildEntries(3);
        const dir = packDirOf(ctx);
        const idxPath = `${dir}/pack-${PACK_SHA}.idx`;
        const idxBytes = await buildIdx(ctx, sortPackIndexEntries(entries), PACK_SHA);
        await ctx.fs.writeExclusive(idxPath, idxBytes);
        const before = await ctx.fs.stat(idxPath);
        const sut = writePackSiblingArtifacts;

        // Act
        const result = await sut(ctx, siblingInput(dir, entries));

        // Assert
        expect(result.idxPath).toBe(idxPath);
        expect(await ctx.fs.read(idxPath)).toEqual(idxBytes);
        expect((await ctx.fs.stat(idxPath)).mtimeMs).toBe(before.mtimeMs);
        expect(await ctx.fs.exists(`${dir}/pack-${PACK_SHA}.rev`)).toBe(true);
      });
    });
  });

  describe('Given a .idx with different bytes already occupying its sibling name', () => {
    describe('When writePackSiblingArtifacts runs', () => {
      it('Then it refuses naming the index, leaves the existing bytes untouched and writes no .rev', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const entries = buildEntries(3);
        const dir = packDirOf(ctx);
        const idxPath = `${dir}/pack-${PACK_SHA}.idx`;
        const foreign = new TextEncoder().encode('not an index');
        await ctx.fs.writeExclusive(idxPath, foreign);
        const sut = writePackSiblingArtifacts;

        // Act
        let caught: unknown;
        try {
          await sut(ctx, siblingInput(dir, entries));
        } catch (err) {
          caught = err;
        }

        // Assert
        expectMismatch(caught, idxPath);
        expect(await ctx.fs.read(idxPath)).toEqual(foreign);
        expect(await ctx.fs.exists(`${dir}/pack-${PACK_SHA}.rev`)).toBe(false);
      });
    });
  });

  describe('Given an identical .rev already present and no .idx', () => {
    describe('When writePackSiblingArtifacts runs', () => {
      it('Then it writes the index and keeps the existing reverse index untouched', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const entries = buildEntries(3);
        const dir = packDirOf(ctx);
        const revPath = `${dir}/pack-${PACK_SHA}.rev`;
        const revBytes = await buildRev(ctx, sortPackIndexEntries(entries), PACK_SHA);
        await ctx.fs.writeExclusive(revPath, revBytes);
        const before = await ctx.fs.stat(revPath);
        const sut = writePackSiblingArtifacts;

        // Act
        await sut(ctx, siblingInput(dir, entries));

        // Assert
        expect(await ctx.fs.exists(`${dir}/pack-${PACK_SHA}.idx`)).toBe(true);
        expect(await ctx.fs.read(revPath)).toEqual(revBytes);
        expect((await ctx.fs.stat(revPath)).mtimeMs).toBe(before.mtimeMs);
      });
    });
  });

  describe('Given a .rev with different bytes already present', () => {
    describe('When writePackSiblingArtifacts runs', () => {
      it('Then it refuses naming the reverse index after the index was written', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const entries = buildEntries(3);
        const dir = packDirOf(ctx);
        const revPath = `${dir}/pack-${PACK_SHA}.rev`;
        const foreign = new TextEncoder().encode('not a reverse index');
        await ctx.fs.writeExclusive(revPath, foreign);
        const sut = writePackSiblingArtifacts;

        // Act
        let caught: unknown;
        try {
          await sut(ctx, siblingInput(dir, entries));
        } catch (err) {
          caught = err;
        }

        // Assert
        expectMismatch(caught, revPath);
        expect(await ctx.fs.exists(`${dir}/pack-${PACK_SHA}.idx`)).toBe(true);
        expect(await ctx.fs.read(revPath)).toEqual(foreign);
      });
    });
  });

  describe('Given promisor: true and a .promisor sentinel already present', () => {
    describe('When writePackSiblingArtifacts runs', () => {
      it('Then the existing sentinel is kept as it is and the write succeeds', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const entries = buildEntries(2);
        const dir = packDirOf(ctx);
        const sentinelPath = `${dir}/pack-${PACK_SHA}.promisor`;
        const existing = new TextEncoder().encode('from origin\n');
        await ctx.fs.writeExclusive(sentinelPath, existing);
        const sut = writePackSiblingArtifacts;

        // Act
        const result = await sut(ctx, { ...siblingInput(dir, entries), promisor: true });

        // Assert
        expect(result.packSha).toBe(PACK_SHA);
        expect(await ctx.fs.read(sentinelPath)).toEqual(existing);
        expect(await ctx.fs.exists(`${dir}/pack-${PACK_SHA}.idx`)).toBe(true);
      });
    });
  });
});
