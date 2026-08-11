import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../../../src/adapters/memory/memory-adapter.js';
import { runBitmapHealthPass } from '../../../../../../src/application/commands/internal/fsck/bitmap-health.js';
import type {
  FsckFinding,
  FsckOptions,
} from '../../../../../../src/application/commands/internal/fsck/types.js';
import {
  commonGitDir,
  multiPackIndexPath,
  packsDir,
} from '../../../../../../src/application/primitives/path-layout.js';
import { permissionDenied } from '../../../../../../src/domain/error.js';
import { bytesToHex, hexToBytes } from '../../../../../../src/domain/objects/encoding.js';
import type { Context } from '../../../../../../src/ports/context.js';
import {
  type BitmapSpec,
  buildBitmap,
  buildMidx,
  type MidxSpec,
} from '../../../../domain/storage/arbitraries.js';
import {
  buildSyntheticPack,
  writeSyntheticBitmap,
  writeSyntheticPack,
} from '../../../primitives/pack-fixture.js';

const sut = runBitmapHealthPass;

const enc = new TextEncoder();

const packDir = (ctx: Context): string => `${ctx.layout.gitDir}/objects/pack`;
const packBitmapPath = (ctx: Context, name: string): string =>
  `${packDir(ctx)}/pack-${name}.bitmap`;
const packIdxPath = (ctx: Context, name: string): string => `${packDir(ctx)}/pack-${name}.idx`;
const midxBitmapPath = (ctx: Context, hex: string): string =>
  `${packDir(ctx)}/multi-pack-index-${hex}.bitmap`;

const onePackEntry = (content: string) => [
  { kind: 'base' as const, type: 'blob' as const, content: enc.encode(content) },
];

function findingsOfType<T extends FsckFinding['type']>(
  result: { readonly findings: ReadonlyArray<FsckFinding> },
  type: T,
): ReadonlyArray<Extract<FsckFinding, { type: T }>> {
  return result.findings.filter(
    (finding): finding is Extract<FsckFinding, { type: T }> => finding.type === type,
  );
}

// Minimal, structurally healthy bitmap layout: header(12) + checksum(digestLength)
// + four empty EWAH streams (20 bytes each, the empty-stream special case) + zero
// entries. This pass never parses it — the shape only exists so the "restamped
// structural corruption" rows have real header/stream fields to poke.
const EMPTY_STREAM = { bitSize: 0, bits: [] } as const;
const BITMAP_HEADER_SIZE = 12;

function healthyBitmapSpec(digestLength: number): BitmapSpec {
  return {
    optionFlags: 1, // the mandatory full-DAG bit
    digestLength,
    checksum: new Uint8Array(digestLength).fill(0xbb),
    typeStreams: [EMPTY_STREAM, EMPTY_STREAM, EMPTY_STREAM, EMPTY_STREAM],
    entries: [],
    trailingBytes: 0,
  };
}

function pokeUint32(bytes: Uint8Array, offset: number, value: number): Uint8Array {
  const copy = bytes.slice();
  new DataView(copy.buffer).setUint32(offset, value);
  return copy;
}

function pokeUint16(bytes: Uint8Array, offset: number, value: number): Uint8Array {
  const copy = bytes.slice();
  new DataView(copy.buffer).setUint16(offset, value);
  return copy;
}

function flipByte(bytes: Uint8Array, offset: number): Uint8Array {
  const copy = bytes.slice();
  copy[offset] = copy[offset]! ^ 0xff;
  return copy;
}

/** Byte offset of the first (commits) type stream's `wordCount` field, right
 *  after the header and the embedded checksum. */
const firstStreamWordCountOffset = (digestLength: number): number =>
  BITMAP_HEADER_SIZE + digestLength + 4;

async function stampTrailer(ctx: Context, bytes: Uint8Array): Promise<Uint8Array> {
  const digestLength = ctx.hashConfig.digestLength;
  const bodyEnd = bytes.length - digestLength;
  const checksumHex = await ctx.hash.hashHex(bytes.subarray(0, bodyEnd));
  const stamped = bytes.slice();
  stamped.set(hexToBytes(checksumHex), bodyEnd);
  return stamped;
}

function midxBaseSpec(digestLength: number): MidxSpec {
  return {
    version: 2,
    hashVersion: digestLength === 32 ? 2 : 1,
    digestLength,
    numBaseFiles: 0,
    packNames: [],
    entries: [],
  };
}

/** Writes a correctly-stamped, empty flat multi-pack-index and returns its
 *  own bytes — the source of truth for the hex this pass composes the midx
 *  bitmap's name from. */
async function writeHealthyMidx(ctx: Context): Promise<Uint8Array> {
  const digestLength = ctx.hashConfig.digestLength;
  const stamped = await stampTrailer(ctx, buildMidx(midxBaseSpec(digestLength)));
  await ctx.fs.write(multiPackIndexPath(packsDir(commonGitDir(ctx))), stamped);
  return stamped;
}

const storedTrailerHex = (midxBytes: Uint8Array, digestLength: number): string =>
  bytesToHex(midxBytes.subarray(midxBytes.length - digestLength));

// ---------------------------------------------------------------------------
// CLEAN — no finding, exitBit 0
// ---------------------------------------------------------------------------

describe('Given a pack with a healthy bitmap', () => {
  describe('When the bitmap health pass runs', () => {
    it('Then no finding is emitted and exitBit is 0', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await writeSyntheticPack(ctx, 'clean', onePackEntry('clean-content'));
      const body = buildBitmap(healthyBitmapSpec(ctx.hashConfig.digestLength));
      await writeSyntheticBitmap(ctx, packBitmapPath(ctx, 'clean'), body);

      // Act
      const result = await sut(ctx, {});

      // Assert
      expect(result.findings).toHaveLength(0);
      expect(result.exitBit).toBe(0);
    });
  });
});

describe('Given a pack with no bitmap file on disk', () => {
  describe('When the bitmap health pass runs', () => {
    it('Then no finding is emitted and exitBit is 0', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await writeSyntheticPack(ctx, 'no-bitmap', onePackEntry('no-bitmap-content'));

      // Act
      const result = await sut(ctx, {});

      // Assert
      expect(result.findings).toHaveLength(0);
      expect(result.exitBit).toBe(0);
    });
  });
});

describe('Given a pack whose bitmap has a flipped trailer AND is unreadable (permission denied)', () => {
  describe('When the bitmap health pass runs', () => {
    it('Then no finding is emitted and exitBit is 0 — the unreadable classification masks a real fault', async () => {
      // Arrange — the planted bitmap is genuinely corrupt, so a pass that
      // read it would score bit 128; silence is only explainable by the
      // unreadable classification.
      const ctx = createMemoryContext();
      await writeSyntheticPack(ctx, 'unreadable', onePackEntry('unreadable-content'));
      const body = buildBitmap(healthyBitmapSpec(ctx.hashConfig.digestLength));
      const path = packBitmapPath(ctx, 'unreadable');
      await writeSyntheticBitmap(ctx, path, body, { flipTrailer: true });
      const wrapped: Context = {
        ...ctx,
        fs: {
          ...ctx.fs,
          read: async (p: string) => {
            if (p === path) throw permissionDenied(p);
            return ctx.fs.read(p);
          },
        },
      };

      // Act
      const result = await sut(wrapped, {});

      // Assert
      expect(result.findings).toHaveLength(0);
      expect(result.exitBit).toBe(0);
    });
  });
});

describe('Given a corrupt bitmap beside a parseable .idx with no .pack file (never registered)', () => {
  describe('When the bitmap health pass runs', () => {
    it('Then no finding is emitted and exitBit is 0 — the orphan .idx is never a pack', async () => {
      // Arrange — a genuinely parseable `.idx` (only its `.pack` sibling is
      // missing) beside a genuinely corrupt bitmap: nothing but the orphan
      // exclusion can explain the silence.
      const ctx = createMemoryContext();
      const built = await buildSyntheticPack(ctx, onePackEntry('orphan-content'));
      await ctx.fs.write(packIdxPath(ctx, 'orphan'), built.idxBytes);
      const body = buildBitmap(healthyBitmapSpec(ctx.hashConfig.digestLength));
      await writeSyntheticBitmap(ctx, packBitmapPath(ctx, 'orphan'), body, { flipTrailer: true });

      // Act
      const result = await sut(ctx, {});

      // Assert
      expect(result.findings).toHaveLength(0);
      expect(result.exitBit).toBe(0);
    });
  });
});

describe('Given a pack bitmap exactly digestLength bytes long whose body is legitimately empty', () => {
  describe('When the bitmap health pass runs', () => {
    it('Then no finding is emitted — the length guard admits len === digestLength to the hash compare, not just len < digestLength', async () => {
      // Arrange — an empty body's own trailer IS the whole (digestLength-byte)
      // file, so this is the one length at which a genuinely healthy bitmap
      // and a merely-too-short one are the same number of bytes; only the
      // hash comparison (never a guard that treats `===` as too-short) tells
      // them apart.
      const ctx = createMemoryContext();
      await writeSyntheticPack(ctx, 'boundary-exact', onePackEntry('boundary-exact-content'));
      await writeSyntheticBitmap(ctx, packBitmapPath(ctx, 'boundary-exact'), new Uint8Array(0));

      // Act
      const result = await sut(ctx, {});

      // Assert
      expect(result.findings).toHaveLength(0);
      expect(result.exitBit).toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// MISMATCH — one bitmap-checksum-mismatch, exitBit 128
// ---------------------------------------------------------------------------

describe('Given a pack whose bitmap trailer is flipped', () => {
  describe('When the bitmap health pass runs', () => {
    it('Then one bitmap-checksum-mismatch is emitted naming the artefact, exitBit is 128', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await writeSyntheticPack(ctx, 'flipped-trailer', onePackEntry('flipped-trailer-content'));
      const body = buildBitmap(healthyBitmapSpec(ctx.hashConfig.digestLength));
      await writeSyntheticBitmap(ctx, packBitmapPath(ctx, 'flipped-trailer'), body, {
        flipTrailer: true,
      });

      // Act
      const result = await sut(ctx, {});

      // Assert
      const mismatches = findingsOfType(result, 'bitmap-checksum-mismatch');
      expect(mismatches).toHaveLength(1);
      expect(mismatches[0]!.artefact).toBe('pack-flipped-trailer.bitmap');
      expect(result.exitBit).toBe(128);
    });
  });
});

describe('Given a pack whose bitmap magic is flipped but the trailer is left stale', () => {
  describe('When the bitmap health pass runs', () => {
    it('Then one bitmap-checksum-mismatch is emitted, exitBit is 128', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await writeSyntheticPack(ctx, 'stale-magic', onePackEntry('stale-magic-content'));
      const healthy = buildBitmap(healthyBitmapSpec(ctx.hashConfig.digestLength));
      const corrupted = pokeUint32(healthy, 0, 0xdeadbeef);
      await writeSyntheticBitmap(ctx, packBitmapPath(ctx, 'stale-magic'), corrupted, {
        digestOver: healthy,
      });

      // Act
      const result = await sut(ctx, {});

      // Assert
      const mismatches = findingsOfType(result, 'bitmap-checksum-mismatch');
      expect(mismatches).toHaveLength(1);
      expect(mismatches[0]!.artefact).toBe('pack-stale-magic.bitmap');
      expect(result.exitBit).toBe(128);
    });
  });
});

describe('Given a pack whose bitmap version is 2 but the trailer is left stale', () => {
  describe('When the bitmap health pass runs', () => {
    it('Then one bitmap-checksum-mismatch is emitted, exitBit is 128', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await writeSyntheticPack(ctx, 'stale-version', onePackEntry('stale-version-content'));
      const healthy = buildBitmap(healthyBitmapSpec(ctx.hashConfig.digestLength));
      const corrupted = pokeUint16(healthy, 4, 2);
      await writeSyntheticBitmap(ctx, packBitmapPath(ctx, 'stale-version'), corrupted, {
        digestOver: healthy,
      });

      // Act
      const result = await sut(ctx, {});

      // Assert
      const mismatches = findingsOfType(result, 'bitmap-checksum-mismatch');
      expect(mismatches).toHaveLength(1);
      expect(mismatches[0]!.artefact).toBe('pack-stale-version.bitmap');
      expect(result.exitBit).toBe(128);
    });
  });
});

describe('Given a pack whose bitmap entryCount is 99 but the trailer is left stale', () => {
  describe('When the bitmap health pass runs', () => {
    it('Then one bitmap-checksum-mismatch is emitted, exitBit is 128', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await writeSyntheticPack(ctx, 'stale-entry-count', onePackEntry('stale-entry-count-content'));
      const healthy = buildBitmap(healthyBitmapSpec(ctx.hashConfig.digestLength));
      const corrupted = pokeUint32(healthy, 8, 99);
      await writeSyntheticBitmap(ctx, packBitmapPath(ctx, 'stale-entry-count'), corrupted, {
        digestOver: healthy,
      });

      // Act
      const result = await sut(ctx, {});

      // Assert
      const mismatches = findingsOfType(result, 'bitmap-checksum-mismatch');
      expect(mismatches).toHaveLength(1);
      expect(mismatches[0]!.artefact).toBe('pack-stale-entry-count.bitmap');
      expect(result.exitBit).toBe(128);
    });
  });
});

describe('Given a pack bitmap truncated to exactly digestLength bytes', () => {
  describe('When the bitmap health pass runs', () => {
    it('Then one bitmap-checksum-mismatch is emitted, exitBit is 128', async () => {
      // Arrange
      const ctx = createMemoryContext();
      const digestLength = ctx.hashConfig.digestLength;
      await writeSyntheticPack(ctx, 'trunc-exact', onePackEntry('trunc-exact-content'));
      const body = buildBitmap(healthyBitmapSpec(digestLength));
      await writeSyntheticBitmap(ctx, packBitmapPath(ctx, 'trunc-exact'), body, {
        truncateTo: digestLength,
      });

      // Act
      const result = await sut(ctx, {});

      // Assert
      const mismatches = findingsOfType(result, 'bitmap-checksum-mismatch');
      expect(mismatches).toHaveLength(1);
      expect(mismatches[0]!.artefact).toBe('pack-trunc-exact.bitmap');
      expect(result.exitBit).toBe(128);
    });
  });
});

describe('Given a pack bitmap truncated to digestLength − 10 bytes', () => {
  describe('When the bitmap health pass runs', () => {
    it('Then the length guard fires as a mismatch, never a negative subarray bound, exitBit is 128', async () => {
      // Arrange
      const ctx = createMemoryContext();
      const digestLength = ctx.hashConfig.digestLength;
      await writeSyntheticPack(ctx, 'trunc-under', onePackEntry('trunc-under-content'));
      const body = buildBitmap(healthyBitmapSpec(digestLength));
      await writeSyntheticBitmap(ctx, packBitmapPath(ctx, 'trunc-under'), body, {
        truncateTo: digestLength - 10,
      });

      // Act
      const result = await sut(ctx, {});

      // Assert
      const mismatches = findingsOfType(result, 'bitmap-checksum-mismatch');
      expect(mismatches).toHaveLength(1);
      expect(mismatches[0]!.artefact).toBe('pack-trunc-under.bitmap');
      expect(result.exitBit).toBe(128);
    });
  });
});

describe('Given a zero-length pack bitmap', () => {
  describe('When the bitmap health pass runs', () => {
    it('Then one bitmap-checksum-mismatch is emitted, exitBit is 128', async () => {
      // Arrange
      const ctx = createMemoryContext();
      const digestLength = ctx.hashConfig.digestLength;
      await writeSyntheticPack(ctx, 'zero-length', onePackEntry('zero-length-content'));
      const body = buildBitmap(healthyBitmapSpec(digestLength));
      await writeSyntheticBitmap(ctx, packBitmapPath(ctx, 'zero-length'), body, {
        truncateTo: 0,
      });

      // Act
      const result = await sut(ctx, {});

      // Assert
      const mismatches = findingsOfType(result, 'bitmap-checksum-mismatch');
      expect(mismatches).toHaveLength(1);
      expect(mismatches[0]!.artefact).toBe('pack-zero-length.bitmap');
      expect(result.exitBit).toBe(128);
    });
  });
});

describe('Given a pack bitmap whose embedded pack checksum is flipped but the trailer is left stale', () => {
  describe('When the bitmap health pass runs', () => {
    it('Then one bitmap-checksum-mismatch is emitted, exitBit is 128', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await writeSyntheticPack(ctx, 'stale-checksum', onePackEntry('stale-checksum-content'));
      const healthy = buildBitmap(healthyBitmapSpec(ctx.hashConfig.digestLength));
      const corrupted = flipByte(healthy, BITMAP_HEADER_SIZE);
      await writeSyntheticBitmap(ctx, packBitmapPath(ctx, 'stale-checksum'), corrupted, {
        digestOver: healthy,
      });

      // Act
      const result = await sut(ctx, {});

      // Assert
      const mismatches = findingsOfType(result, 'bitmap-checksum-mismatch');
      expect(mismatches).toHaveLength(1);
      expect(mismatches[0]!.artefact).toBe('pack-stale-checksum.bitmap');
      expect(result.exitBit).toBe(128);
    });
  });
});

// ---------------------------------------------------------------------------
// RESTAMPED STRUCTURAL CORRUPTION — the pass hashes and does not parse:
// no finding, exitBit 0, for every one of these
// ---------------------------------------------------------------------------

describe('Given a pack bitmap with flipped magic, restamped', () => {
  describe('When the bitmap health pass runs', () => {
    it('Then no finding is emitted — the pass hashes and does not parse', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await writeSyntheticPack(ctx, 'restamp-magic', onePackEntry('restamp-magic-content'));
      const healthy = buildBitmap(healthyBitmapSpec(ctx.hashConfig.digestLength));
      const corrupted = pokeUint32(healthy, 0, 0xdeadbeef);
      await writeSyntheticBitmap(ctx, packBitmapPath(ctx, 'restamp-magic'), corrupted);

      // Act
      const result = await sut(ctx, {});

      // Assert
      expect(result.findings).toHaveLength(0);
      expect(result.exitBit).toBe(0);
    });
  });
});

describe('Given a pack bitmap with version 2, restamped', () => {
  describe('When the bitmap health pass runs', () => {
    it('Then no finding is emitted — the pass hashes and does not parse', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await writeSyntheticPack(ctx, 'restamp-version', onePackEntry('restamp-version-content'));
      const healthy = buildBitmap(healthyBitmapSpec(ctx.hashConfig.digestLength));
      const corrupted = pokeUint16(healthy, 4, 2);
      await writeSyntheticBitmap(ctx, packBitmapPath(ctx, 'restamp-version'), corrupted);

      // Act
      const result = await sut(ctx, {});

      // Assert
      expect(result.findings).toHaveLength(0);
      expect(result.exitBit).toBe(0);
    });
  });
});

describe('Given a pack bitmap with entryCount 99, restamped', () => {
  describe('When the bitmap health pass runs', () => {
    it('Then no finding is emitted — the pass hashes and does not parse', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await writeSyntheticPack(
        ctx,
        'restamp-entry-count',
        onePackEntry('restamp-entry-count-content'),
      );
      const healthy = buildBitmap(healthyBitmapSpec(ctx.hashConfig.digestLength));
      const corrupted = pokeUint32(healthy, 8, 99);
      await writeSyntheticBitmap(ctx, packBitmapPath(ctx, 'restamp-entry-count'), corrupted);

      // Act
      const result = await sut(ctx, {});

      // Assert
      expect(result.findings).toHaveLength(0);
      expect(result.exitBit).toBe(0);
    });
  });
});

describe('Given a pack bitmap truncated then restamped over the shorter body', () => {
  describe('When the bitmap health pass runs', () => {
    it('Then no finding is emitted — the pass hashes and does not parse', async () => {
      // Arrange
      const ctx = createMemoryContext();
      const digestLength = ctx.hashConfig.digestLength;
      await writeSyntheticPack(ctx, 'restamp-trunc', onePackEntry('restamp-trunc-content'));
      const healthy = buildBitmap(healthyBitmapSpec(digestLength));
      const shorter = healthy.slice(0, BITMAP_HEADER_SIZE + digestLength);
      await writeSyntheticBitmap(ctx, packBitmapPath(ctx, 'restamp-trunc'), shorter);

      // Act
      const result = await sut(ctx, {});

      // Assert
      expect(result.findings).toHaveLength(0);
      expect(result.exitBit).toBe(0);
    });
  });
});

describe('Given a pack bitmap with its option flags zeroed, restamped', () => {
  describe('When the bitmap health pass runs', () => {
    it('Then no finding is emitted — the pass hashes and does not parse', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await writeSyntheticPack(ctx, 'restamp-flags', onePackEntry('restamp-flags-content'));
      const healthy = buildBitmap(healthyBitmapSpec(ctx.hashConfig.digestLength));
      const corrupted = pokeUint16(healthy, 6, 0);
      await writeSyntheticBitmap(ctx, packBitmapPath(ctx, 'restamp-flags'), corrupted);

      // Act
      const result = await sut(ctx, {});

      // Assert
      expect(result.findings).toHaveLength(0);
      expect(result.exitBit).toBe(0);
    });
  });
});

describe('Given a pack bitmap whose first stream declares a wordCount of 0x7fffffff, restamped', () => {
  describe('When the bitmap health pass runs', () => {
    it('Then no finding is emitted — the pass hashes and does not parse', async () => {
      // Arrange
      const ctx = createMemoryContext();
      const digestLength = ctx.hashConfig.digestLength;
      await writeSyntheticPack(
        ctx,
        'restamp-word-count',
        onePackEntry('restamp-word-count-content'),
      );
      const healthy = buildBitmap(healthyBitmapSpec(digestLength));
      const corrupted = pokeUint32(healthy, firstStreamWordCountOffset(digestLength), 0x7fffffff);
      await writeSyntheticBitmap(ctx, packBitmapPath(ctx, 'restamp-word-count'), corrupted);

      // Act
      const result = await sut(ctx, {});

      // Assert
      expect(result.findings).toHaveLength(0);
      expect(result.exitBit).toBe(0);
    });
  });
});

describe('Given a pack bitmap whose embedded pack checksum is flipped, restamped', () => {
  describe('When the bitmap health pass runs', () => {
    it('Then no finding is emitted — the pass hashes and does not parse', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await writeSyntheticPack(
        ctx,
        'restamp-embedded-checksum',
        onePackEntry('restamp-embedded-checksum-content'),
      );
      const healthy = buildBitmap(healthyBitmapSpec(ctx.hashConfig.digestLength));
      const corrupted = flipByte(healthy, BITMAP_HEADER_SIZE);
      await writeSyntheticBitmap(ctx, packBitmapPath(ctx, 'restamp-embedded-checksum'), corrupted);

      // Act
      const result = await sut(ctx, {});

      // Assert
      expect(result.findings).toHaveLength(0);
      expect(result.exitBit).toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// MIDX ARM — the in-use multi-pack-index's bitmap, composed from ITS OWN
// STORED trailer bytes, unconditional in every mode
// ---------------------------------------------------------------------------

describe('Given the in-use midx bitmap trailer is flipped', () => {
  describe('When the bitmap health pass runs', () => {
    it('Then one bitmap-checksum-mismatch is emitted naming the midx artefact, exitBit is 128', async () => {
      // Arrange
      const ctx = createMemoryContext();
      const digestLength = ctx.hashConfig.digestLength;
      const midxBytes = await writeHealthyMidx(ctx);
      const hex = storedTrailerHex(midxBytes, digestLength);
      const body = buildBitmap(healthyBitmapSpec(digestLength));
      await writeSyntheticBitmap(ctx, midxBitmapPath(ctx, hex), body, { flipTrailer: true });

      // Act
      const result = await sut(ctx, {});

      // Assert
      const mismatches = findingsOfType(result, 'bitmap-checksum-mismatch');
      expect(mismatches).toHaveLength(1);
      expect(mismatches[0]!.artefact).toBe(`multi-pack-index-${hex}.bitmap`);
      expect(result.exitBit).toBe(128);
    });
  });
});

describe('Given the in-use midx bitmap magic is flipped, restamped', () => {
  describe('When the bitmap health pass runs', () => {
    it('Then no finding is emitted — the pass hashes and does not parse', async () => {
      // Arrange
      const ctx = createMemoryContext();
      const digestLength = ctx.hashConfig.digestLength;
      const midxBytes = await writeHealthyMidx(ctx);
      const hex = storedTrailerHex(midxBytes, digestLength);
      const healthy = buildBitmap(healthyBitmapSpec(digestLength));
      const corrupted = pokeUint32(healthy, 0, 0xdeadbeef);
      await writeSyntheticBitmap(ctx, midxBitmapPath(ctx, hex), corrupted);

      // Act
      const result = await sut(ctx, {});

      // Assert
      expect(result.findings).toHaveLength(0);
      expect(result.exitBit).toBe(0);
    });
  });
});

describe('Given the in-use midx has no bitmap file at all', () => {
  describe('When the bitmap health pass runs', () => {
    it('Then no finding is emitted and exitBit is 0', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await writeHealthyMidx(ctx);

      // Act
      const result = await sut(ctx, {});

      // Assert
      expect(result.findings).toHaveLength(0);
      expect(result.exitBit).toBe(0);
    });
  });
});

describe('Given a CORRUPT midx bitmap renamed to a different hash than the midx actually stores', () => {
  describe('When the bitmap health pass runs', () => {
    it('Then no finding is emitted — the composed name matches no file on disk', async () => {
      // Arrange — the renamed file's own trailer is flipped, so a pass that
      // composed this name instead would score bit 128.
      const ctx = createMemoryContext();
      const digestLength = ctx.hashConfig.digestLength;
      await writeHealthyMidx(ctx);
      const wrongHex = '00'.repeat(digestLength);
      const body = buildBitmap(healthyBitmapSpec(digestLength));
      await writeSyntheticBitmap(ctx, midxBitmapPath(ctx, wrongHex), body, { flipTrailer: true });

      // Act
      const result = await sut(ctx, {});

      // Assert
      expect(result.findings).toHaveLength(0);
      expect(result.exitBit).toBe(0);
    });
  });
});

describe('Given a midx whose own stored trailer is wrong, with a corrupt bitmap beside the original name', () => {
  describe('When the bitmap health pass runs', () => {
    it('Then this pass emits no finding and exitBit is 0 — the wrong trailer hides the bitmap entirely', async () => {
      // Arrange
      const ctx = createMemoryContext();
      const digestLength = ctx.hashConfig.digestLength;
      const healthyMidx = await stampTrailer(ctx, buildMidx(midxBaseSpec(digestLength)));
      const correctHex = storedTrailerHex(healthyMidx, digestLength);
      const corruptBody = buildBitmap(healthyBitmapSpec(digestLength));
      await writeSyntheticBitmap(ctx, midxBitmapPath(ctx, correctHex), corruptBody, {
        flipTrailer: true,
      });
      // The midx's OWN stored trailer is now wrong — one byte flipped after
      // stamping, never restamped — so the bitmap name this pass composes
      // is neither `correctHex` nor anything else on disk.
      const brokenMidx = flipByte(healthyMidx, healthyMidx.length - 1);
      await ctx.fs.write(multiPackIndexPath(packsDir(commonGitDir(ctx))), brokenMidx);

      // Act
      const result = await sut(ctx, {});

      // Assert
      expect(result.findings).toHaveLength(0);
      expect(result.exitBit).toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// COMPOSITION — the pack-arm loop accumulates across multiple packs
// ---------------------------------------------------------------------------

describe('Given two packs, one with a healthy bitmap and one with a flipped trailer', () => {
  describe('When the bitmap health pass runs', () => {
    it('Then exactly one bitmap-checksum-mismatch is emitted, exitBit is 128', async () => {
      // Arrange
      const ctx = createMemoryContext();
      const digestLength = ctx.hashConfig.digestLength;
      await writeSyntheticPack(ctx, 'two-clean', onePackEntry('two-clean-content'));
      await writeSyntheticBitmap(
        ctx,
        packBitmapPath(ctx, 'two-clean'),
        buildBitmap(healthyBitmapSpec(digestLength)),
      );
      await writeSyntheticPack(ctx, 'two-broken', onePackEntry('two-broken-content'));
      await writeSyntheticBitmap(
        ctx,
        packBitmapPath(ctx, 'two-broken'),
        buildBitmap(healthyBitmapSpec(digestLength)),
        { flipTrailer: true },
      );

      // Act
      const result = await sut(ctx, {});

      // Assert
      const mismatches = findingsOfType(result, 'bitmap-checksum-mismatch');
      expect(mismatches).toHaveLength(1);
      expect(mismatches[0]!.artefact).toBe('pack-two-broken.bitmap');
      expect(result.exitBit).toBe(128);
    });
  });
});

// ---------------------------------------------------------------------------
// MODES — the pass is ungated: identical output in every fsck mode
// ---------------------------------------------------------------------------

const ALL_MODES: ReadonlyArray<{ readonly label: string; readonly opts: FsckOptions }> = [
  { label: 'default', opts: {} },
  { label: 'connectivityOnly', opts: { connectivityOnly: true } },
  { label: 'full: false', opts: { full: false } },
  { label: 'strict', opts: { strict: true } },
];

describe('Given a pack whose bitmap trailer is flipped', () => {
  describe('When the bitmap health pass runs under any fsck mode', () => {
    it.each(ALL_MODES)(
      'Then mode $label produces the same finding and bit as the default',
      async ({ opts }) => {
        // Arrange
        const ctx = createMemoryContext();
        await writeSyntheticPack(ctx, 'modes-mismatch', onePackEntry('modes-mismatch-content'));
        await writeSyntheticBitmap(
          ctx,
          packBitmapPath(ctx, 'modes-mismatch'),
          buildBitmap(healthyBitmapSpec(ctx.hashConfig.digestLength)),
          { flipTrailer: true },
        );

        // Act
        const result = await sut(ctx, opts);

        // Assert
        const mismatches = findingsOfType(result, 'bitmap-checksum-mismatch');
        expect(mismatches).toHaveLength(1);
        expect(mismatches[0]!.artefact).toBe('pack-modes-mismatch.bitmap');
        expect(result.exitBit).toBe(128);
      },
    );
  });
});

describe('Given a pack bitmap with flipped magic, restamped', () => {
  describe('When the bitmap health pass runs under any fsck mode', () => {
    it.each(ALL_MODES)(
      'Then mode $label produces no finding, exitBit 0, as the default',
      async ({ opts }) => {
        // Arrange
        const ctx = createMemoryContext();
        await writeSyntheticPack(ctx, 'modes-restamped', onePackEntry('modes-restamped-content'));
        const healthy = buildBitmap(healthyBitmapSpec(ctx.hashConfig.digestLength));
        const corrupted = pokeUint32(healthy, 0, 0xdeadbeef);
        await writeSyntheticBitmap(ctx, packBitmapPath(ctx, 'modes-restamped'), corrupted);

        // Act
        const result = await sut(ctx, opts);

        // Assert
        expect(result.findings).toHaveLength(0);
        expect(result.exitBit).toBe(0);
      },
    );
  });
});

describe('Given the in-use midx bitmap trailer is flipped', () => {
  describe('When the bitmap health pass runs under any fsck mode', () => {
    it.each(ALL_MODES)(
      'Then mode $label produces the same finding and bit as the default',
      async ({ opts }) => {
        // Arrange
        const ctx = createMemoryContext();
        const digestLength = ctx.hashConfig.digestLength;
        const midxBytes = await writeHealthyMidx(ctx);
        const hex = storedTrailerHex(midxBytes, digestLength);
        await writeSyntheticBitmap(
          ctx,
          midxBitmapPath(ctx, hex),
          buildBitmap(healthyBitmapSpec(digestLength)),
          { flipTrailer: true },
        );

        // Act
        const result = await sut(ctx, opts);

        // Assert
        const mismatches = findingsOfType(result, 'bitmap-checksum-mismatch');
        expect(mismatches).toHaveLength(1);
        expect(mismatches[0]!.artefact).toBe(`multi-pack-index-${hex}.bitmap`);
        expect(result.exitBit).toBe(128);
      },
    );
  });
});
