import { describe, expect, it, vi } from 'vitest';
import { createMemoryContext } from '../../../../../../src/adapters/memory/memory-adapter.js';
import type { CatalogueOptions } from '../../../../../../src/application/commands/internal/fsck/content-validation.js';
import { createSpecialBlobLedger } from '../../../../../../src/application/commands/internal/fsck/special-blobs.js';
import type { FsckOptions } from '../../../../../../src/application/commands/internal/fsck/types.js';
import {
  positionsByOffset,
  rankOfStart,
  runVerifyPackPass,
  unservedBases,
} from '../../../../../../src/application/commands/internal/fsck/verify-pack.js';
import { DEFAULT_BIG_FILE_THRESHOLD_BYTES } from '../../../../../../src/application/primitives/internal/big-file-threshold.js';
import { SHA1_CONFIG } from '../../../../../../src/domain/objects/hash-config.js';
import type { ObjectId } from '../../../../../../src/domain/objects/index.js';
import { hexToBytes } from '../../../../../../src/domain/objects/index.js';
import { crc32 } from '../../../../../../src/domain/storage/crc32.js';
import type { Context } from '../../../../../../src/ports/context.js';
import {
  buildSyntheticPack,
  syntheticBlobId,
  writeSyntheticPack,
  writeSyntheticPackIn,
} from '../../../primitives/pack-fixture.js';

const CATALOGUE: CatalogueOptions = {
  strict: false,
  specialBlobs: createSpecialBlobLedger(SHA1_CONFIG),
  severities: new Map(),
  skipped: new Set(),
  bigFileThreshold: DEFAULT_BIG_FILE_THRESHOLD_BYTES,
};

const sut = (ctx: Context, opts: FsckOptions) => runVerifyPackPass(ctx, opts, CATALOGUE);

const enc = new TextEncoder();
const DIGEST = 20;
const IDX_CRC_TABLE = 8 + 1024;
const PACK_HEADER = 12;
const DONOR_OBJECTS = '/repo/donor/objects';

const blobEntries = (...contents: ReadonlyArray<string>) =>
  contents.map((content) => ({
    kind: 'base' as const,
    type: 'blob' as const,
    content: enc.encode(content),
  }));

const packPathIn = (objectsDir: string, name: string): string =>
  `${objectsDir}/pack/pack-${name}.pack`;
const idxPathIn = (objectsDir: string, name: string): string =>
  `${objectsDir}/pack/pack-${name}.idx`;
const primaryObjects = (ctx: Context): string => `${ctx.layout.gitDir}/objects`;

const flipByte = async (ctx: Context, path: string, at: (length: number) => number) => {
  const bytes = await ctx.fs.read(path);
  const offset = at(bytes.length);
  bytes[offset] = bytes[offset]! ^ 0xff;
  await ctx.fs.write(path, bytes);
};

/** Rewrite one `.idx`, then restamp its own trailer so only `mutate` disagrees. */
const rewriteIdx = async (ctx: Context, path: string, mutate: (idx: Uint8Array) => void) => {
  const idx = await ctx.fs.read(path);
  mutate(idx);
  const checksum = await ctx.hash.hashHex(idx.subarray(0, idx.length - DIGEST));
  idx.set(hexToBytes(checksum), idx.length - DIGEST);
  await ctx.fs.write(path, idx);
};

const setCrc = (idx: Uint8Array, objectCount: number, position: number, crc: number): void => {
  const view = new DataView(idx.buffer, idx.byteOffset, idx.byteLength);
  view.setUint32(IDX_CRC_TABLE + objectCount * DIGEST + 4 * position, crc);
};

const borrowerContext = async (): Promise<Context> => {
  const ctx = createMemoryContext({
    files: { '/repo/.git/objects/info/alternates': enc.encode(`${DONOR_OBJECTS}\n`) },
  });
  await ctx.fs.mkdir(DONOR_OBJECTS);
  return ctx;
};

const FULL: FsckOptions = {};

describe('Given a healthy pack', () => {
  describe('When the verify-pack pass runs', () => {
    it('Then it reports nothing and sets no bit', async () => {
      // Arrange
      const ctx = createMemoryContext();
      const [a, b] = await writeSyntheticPack(ctx, 'healthy', blobEntries('a', 'b'));

      // Act
      const result = await sut(ctx, FULL);

      // Assert
      expect(result).toEqual({
        findings: [],
        exitBit: 0,
        copies: [
          { id: a, pack: 'pack-healthy' },
          { id: b, pack: 'pack-healthy' },
        ],
        badBases: new Set(),
      });
    });
  });

  describe('When its entries sit in another order than their ids', () => {
    it('Then it hands the entries on in pack offset order', async () => {
      // Arrange
      const ctx = createMemoryContext();
      const [b, a] = await writeSyntheticPack(ctx, 'offsets', blobEntries('b', 'a'));

      // Act
      const result = await sut(ctx, FULL);

      // Assert
      expect(result.copies).toEqual([
        { id: b, pack: 'pack-offsets' },
        { id: a, pack: 'pack-offsets' },
      ]);
    });
  });
});

describe('Given a pack whose .idx trailer is corrupt', () => {
  describe('When the verify-pack pass runs', () => {
    it('Then it reports the index checksum mismatch with bit 1', async () => {
      // Arrange
      const ctx = createMemoryContext();
      const [id] = await writeSyntheticPack(ctx, 'idx-trailer', blobEntries('a'));
      await flipByte(ctx, idxPathIn(primaryObjects(ctx), 'idx-trailer'), (n) => n - 1);

      // Act
      const result = await sut(ctx, FULL);

      // Assert
      expect(result).toEqual({
        findings: [{ type: 'pack-index-checksum-mismatch', pack: 'pack-idx-trailer' }],
        exitBit: 1,
        copies: [{ id, pack: 'pack-idx-trailer' }],
        badBases: new Set(),
      });
    });
  });
});

describe('Given a pack whose .idx records a wrong CRC for one entry', () => {
  describe('When the verify-pack pass runs', () => {
    it('Then it reports that entry by id and pack offset with bit 1', async () => {
      // Arrange
      const ctx = createMemoryContext();
      const [id] = await writeSyntheticPack(ctx, 'crc', blobEntries('a'));
      await rewriteIdx(ctx, idxPathIn(primaryObjects(ctx), 'crc'), (idx) =>
        setCrc(idx, 1, 0, 0xdeadbeef),
      );

      // Act
      const result = await sut(ctx, FULL);

      // Assert
      expect(result).toEqual({
        findings: [{ type: 'pack-crc-mismatch', pack: 'pack-crc', id, offset: PACK_HEADER }],
        exitBit: 1,
        copies: [{ id, pack: 'pack-crc' }],
        badBases: new Set(),
      });
    });
  });
});

describe('Given a pack whose entry body is corrupt but whose .idx CRC was recomputed', () => {
  describe('When the verify-pack pass runs', () => {
    it('Then it reports the pack checksum mismatch and the entry it cannot unpack', async () => {
      // Arrange
      const ctx = createMemoryContext();
      const ids = await writeSyntheticPack(ctx, 'body', blobEntries('a'));
      const packPath = packPathIn(primaryObjects(ctx), 'body');
      await flipByte(ctx, packPath, () => PACK_HEADER + 3);
      const pack = await ctx.fs.read(packPath);
      const entryCrc = crc32(pack.subarray(PACK_HEADER, pack.length - DIGEST));
      await rewriteIdx(ctx, idxPathIn(primaryObjects(ctx), 'body'), (idx) =>
        setCrc(idx, 1, 0, entryCrc),
      );

      // Act
      const result = await sut(ctx, FULL);

      // Assert
      expect(result).toEqual({
        findings: [
          { type: 'pack-checksum-mismatch', pack: 'pack-body' },
          { type: 'pack-entry-unpackable', pack: 'pack-body', id: ids[0], offset: PACK_HEADER },
        ],
        exitBit: 1,
        copies: [{ id: ids[0], pack: 'pack-body' }],
        badBases: new Set(),
      });
    });
  });
});

describe('Given a pack whose second entry body is corrupt', () => {
  describe('When the verify-pack pass runs', () => {
    it('Then it reports the pack checksum, then the CRC of that entry only', async () => {
      // Arrange
      const ctx = createMemoryContext();
      const ids = await writeSyntheticPack(ctx, 'second', blobEntries('first', 'second'));
      const packPath = packPathIn(primaryObjects(ctx), 'second');
      await flipByte(ctx, packPath, (n) => n - DIGEST - 2);

      // Act
      const result = await sut(ctx, FULL);

      // Assert
      const crc = result.findings.filter((f) => f.type === 'pack-crc-mismatch');
      expect(result.findings[0]).toEqual({ type: 'pack-checksum-mismatch', pack: 'pack-second' });
      expect(crc).toHaveLength(1);
      expect(crc[0]).toMatchObject({ id: ids[1] });
      expect((crc[0] as { offset: number }).offset).toBeGreaterThan(PACK_HEADER);
    });
  });
});

const BASE_TEXT = Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n');
const baseBytes = enc.encode(BASE_TEXT);
const childBytes = (tag: string) => enc.encode(BASE_TEXT.replace('line 7\n', `${tag}\n`));

const deltaFamily = (children: ReadonlyArray<'ofs' | 'ref'>, baseId?: string) => [
  { kind: 'base' as const, type: 'blob' as const, content: baseBytes },
  ...children.map((kind, i) =>
    kind === 'ofs'
      ? {
          kind: 'ofs-delta' as const,
          baseIndex: 0,
          targetContent: childBytes(`child ${i}`),
        }
      : {
          kind: 'ref-delta' as const,
          baseId: baseId!,
          baseUncompressed: baseBytes,
          targetContent: childBytes(`child ${i}`),
        },
  ),
];

describe('Given a corrupt delta base with two OFS_DELTA children', () => {
  describe('When the verify-pack pass runs', () => {
    it('Then it names the base as a bad base', async () => {
      // Arrange
      const ctx = createMemoryContext();
      const [baseId] = await writeSyntheticPack(ctx, 'bad-base', deltaFamily(['ofs', 'ofs']));
      await flipByte(ctx, packPathIn(primaryObjects(ctx), 'bad-base'), () => PACK_HEADER + 3);

      // Act
      const result = await sut(ctx, FULL);

      // Assert
      expect(result.badBases).toEqual(new Set([baseId]));
    });
  });
});

describe('Given a corrupt OFS_DELTA child over a healthy base', () => {
  describe('When the verify-pack pass runs', () => {
    it('Then no base is named bad', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await writeSyntheticPack(ctx, 'bad-child', deltaFamily(['ofs']));
      await flipByte(ctx, packPathIn(primaryObjects(ctx), 'bad-child'), (n) => n - DIGEST - 2);

      // Act
      const result = await sut(ctx, FULL);

      // Assert
      expect(result.findings.some((f) => f.type === 'pack-entry-unpackable')).toBe(true);
      expect(result.badBases).toEqual(new Set());
    });
  });
});

describe('Given a corrupt delta base with a REF_DELTA child placed before it', () => {
  describe('When the verify-pack pass runs', () => {
    it('Then it names the base by the id the child records', async () => {
      // Arrange
      const ctx = createMemoryContext();
      const baseId = await syntheticBlobId(ctx, baseBytes);
      const [, packedBaseId] = await writeSyntheticPack(ctx, 'ref-child', [
        {
          kind: 'ref-delta',
          baseId,
          baseUncompressed: baseBytes,
          targetContent: childBytes('child'),
        },
        { kind: 'base', type: 'blob', content: baseBytes },
      ]);
      await flipByte(ctx, packPathIn(primaryObjects(ctx), 'ref-child'), (n) => n - DIGEST - 2);

      // Act
      const result = await sut(ctx, FULL);

      // Assert
      expect(packedBaseId).toBe(baseId);
      expect(result.badBases).toEqual(new Set([baseId]));
    });
  });
});

describe('Given a corrupt delta base that a second pack holds intact', () => {
  describe('When the verify-pack pass runs', () => {
    it('Then no base is named bad, as another pack still serves it', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await writeSyntheticPack(ctx, 'damaged', deltaFamily(['ofs', 'ofs']));
      await writeSyntheticPack(ctx, 'intact', blobEntries(BASE_TEXT));
      await flipByte(ctx, packPathIn(primaryObjects(ctx), 'damaged'), () => PACK_HEADER + 3);

      // Act
      const result = await sut(ctx, FULL);

      // Assert
      expect(result.findings.some((f) => f.type === 'pack-entry-unpackable')).toBe(true);
      expect(result.badBases).toEqual(new Set());
    });
  });
});

describe('Given a corrupt delta base whose child has an unreadable header', () => {
  describe('When the verify-pack pass runs', () => {
    it('Then no base is named bad', async () => {
      // Arrange
      const ctx = createMemoryContext();
      const entries = deltaFamily(['ofs']);
      const { offsets } = await buildSyntheticPack(ctx, entries);
      await writeSyntheticPack(ctx, 'bad-header', entries);
      const path = packPathIn(primaryObjects(ctx), 'bad-header');
      await flipByte(ctx, path, () => PACK_HEADER + 3);
      const reservedType = await ctx.fs.read(path);
      reservedType[offsets[1]!] = 0x50;
      await ctx.fs.write(path, reservedType);

      // Act
      const result = await sut(ctx, FULL);

      // Assert
      expect(result.badBases).toEqual(new Set());
    });
  });
});

describe('Given a corrupt delta base whose child records a distance landing on no entry', () => {
  describe('When the verify-pack pass runs', () => {
    it('Then no base is named bad', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await writeSyntheticPack(ctx, 'lost-base', [
        { kind: 'base', type: 'blob', content: baseBytes },
        { kind: 'ofs-delta', baseIndex: 0, targetContent: childBytes('c'), distanceOverride: 3 },
      ]);
      await flipByte(ctx, packPathIn(primaryObjects(ctx), 'lost-base'), () => PACK_HEADER + 3);

      // Act
      const result = await sut(ctx, FULL);

      // Assert
      expect(result.findings.some((f) => f.type === 'pack-entry-unpackable')).toBe(true);
      expect(result.badBases).toEqual(new Set());
    });
  });
});

describe('Given a corrupt pack', () => {
  describe.each([
    { label: 'full: false', opts: { full: false } },
    { label: 'connectivityOnly', opts: { connectivityOnly: true } },
  ])('When the verify-pack pass runs with $label', ({ opts }) => {
    it('Then it verifies nothing, as git skips verify_pack', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await writeSyntheticPack(ctx, 'gated', blobEntries('a'));
      await flipByte(ctx, idxPathIn(primaryObjects(ctx), 'gated'), (n) => n - 1);

      // Act
      const result = await sut(ctx, opts);

      // Assert
      expect(result).toEqual({ findings: [], exitBit: 0, copies: [], badBases: new Set() });
    });
  });
});

describe('Given a donor pack whose .idx trailer is corrupt', () => {
  describe('When the borrower verify-pack pass runs', () => {
    it('Then the finding carries the donor objects dir', async () => {
      // Arrange
      const ctx = await borrowerContext();
      await writeSyntheticPackIn(ctx, DONOR_OBJECTS, 'donor', blobEntries('d'));
      await flipByte(ctx, idxPathIn(DONOR_OBJECTS, 'donor'), (n) => n - 1);

      // Act
      const result = await sut(ctx, FULL);

      // Assert
      expect(result.findings).toEqual([
        { type: 'pack-index-checksum-mismatch', pack: 'pack-donor', objectsDir: DONOR_OBJECTS },
      ]);
    });
  });
});

describe('Given the same blob in two packs, one copy with a damaged body', () => {
  describe.each([
    { damaged: 'first', healthy: 'second' },
    { damaged: 'second', healthy: 'first' },
  ])('When the verify-pack pass runs with the $damaged pack damaged', ({ damaged, healthy }) => {
    it('Then it reports the damaged copy unpackable by pack and offset, whichever copy reads', async () => {
      // Arrange
      const ctx = createMemoryContext();
      const [blobId] = await writeSyntheticPack(ctx, damaged, blobEntries('shared'));
      await writeSyntheticPack(ctx, healthy, blobEntries('shared'));
      await flipByte(ctx, packPathIn(primaryObjects(ctx), damaged), (n) => n - DIGEST - 2);

      // Act
      const result = await sut(ctx, FULL);

      // Assert
      expect(result.findings).toContainEqual({
        type: 'pack-entry-unpackable',
        pack: `pack-${damaged}`,
        id: blobId,
        offset: PACK_HEADER,
      });
      expect(result.findings.every((f) => 'pack' in f && f.pack === `pack-${damaged}`)).toBe(true);
      expect(result.exitBit).toBe(1);
    });
  });
});

describe('Given a packed blob whose bytes do not hash to its indexed id', () => {
  describe('When the verify-pack pass runs', () => {
    it('Then it reports the packed entry corrupt with bit 1 and runs no catalogue', async () => {
      // Arrange
      const ctx = createMemoryContext();
      const wrongId = '0000000000000000000000000000000000000002' as ObjectId;
      await writeSyntheticPack(ctx, 'lying', [
        { kind: 'base', type: 'blob', content: enc.encode('lying'), idOverride: wrongId },
      ]);

      // Act
      const result = await sut(ctx, FULL);

      // Assert
      expect(result).toEqual({
        findings: [{ type: 'pack-entry-corrupt', pack: 'pack-lying', id: wrongId }],
        exitBit: 1,
        copies: [{ id: wrongId, pack: 'pack-lying' }],
        badBases: new Set(),
      });
    });
  });
});

describe('Given a tree with duplicate entries stored in two intact packs', () => {
  describe('When the verify-pack pass runs', () => {
    it('Then it reports the catalogue error once per copy with bit 1, as verify_pack does', async () => {
      // Arrange
      const ctx = createMemoryContext();
      const entry = new Uint8Array([...enc.encode('100644 a\0'), ...new Uint8Array(DIGEST)]);
      const content = new Uint8Array([...entry, ...entry]);
      const [treeId] = await writeSyntheticPack(ctx, 'one', [
        { kind: 'base', type: 'tree', content },
      ]);
      await writeSyntheticPack(ctx, 'two', [{ kind: 'base', type: 'tree', content }]);

      // Act
      const result = await sut(ctx, FULL);

      // Assert
      const duplicate = {
        type: 'bad-object',
        id: treeId,
        objectType: 'tree',
        msgId: 'duplicateEntries',
        severity: 'error',
      };
      expect(
        result.findings.filter((f) => f.type === 'bad-object' && f.msgId === 'duplicateEntries'),
      ).toEqual([duplicate, duplicate]);
      expect(result.exitBit).toBe(1);
    });
  });
});

describe('positionsByOffset', () => {
  describe('Given offsets whose keys fit a double exactly', () => {
    describe('When ordered by offset', () => {
      it('Then each position comes back in the order its offset sits in the pack', () => {
        // Arrange
        const offsets = Float64Array.of(300, 12, 4_000_000_000, 150);
        const sut = positionsByOffset;

        // Act
        const result = sut(offsets, 4_000_000_001);

        // Assert
        expect(result).toEqual([1, 3, 0, 2]);
      });
    });
  });

  describe('Given offsets well inside the exact range of a double', () => {
    describe('When ordered by offset', () => {
      it('Then no per-pair comparator sort runs', () => {
        // Arrange
        const offsets = Float64Array.of(300, 12, 150);
        const comparatorSort = vi.spyOn(Array.prototype, 'sort');
        const sut = positionsByOffset;

        // Act
        sut(offsets, 301);

        // Assert
        const result = comparatorSort.mock.calls.length;
        expect(result).toBe(0);
      });
    });
  });

  describe('Given offsets whose keys would exceed the exact range of a double', () => {
    describe('When ordered by offset', () => {
      it('Then the comparator sort still orders every position by its offset', () => {
        // Arrange
        const large = 2 ** 51;
        const offsets = Float64Array.of(large + 3, large + 1, 12, large + 2);
        const sut = positionsByOffset;

        // Act
        const result = sut(offsets, large + 4);

        // Assert
        expect(result).toEqual([2, 1, 3, 0]);
      });
    });
  });

  describe('Given a bound whose keys land exactly on the largest exact double', () => {
    describe('When ordered by offset', () => {
      it('Then the key sort still answers exactly', () => {
        // Arrange
        const count = 2;
        const bound = Math.floor(Number.MAX_SAFE_INTEGER / count);
        const offsets = Float64Array.of(bound - 1, bound - 2);
        const sut = positionsByOffset;

        // Act
        const result = sut(offsets, bound);

        // Assert
        expect(result).toEqual([1, 0]);
      });
    });
  });
});

describe('Given ascending entry start offsets', () => {
  const starts = [12, 40, 97, 130, 512];

  describe.each([
    ['first', 12, 0],
    ['middle', 97, 2],
    ['last', 512, 4],
  ])('When the offset sits at the %s position', (_label, offset, expected) => {
    it('Then its rank is that position', () => {
      // Arrange
      const sut = rankOfStart;

      // Act
      const result = sut(starts, offset);

      // Assert
      expect(result).toBe(expected);
    });
  });

  describe.each([
    ['before every start', 5],
    ['between two starts', 98],
    ['after every start', 900],
  ])('When the offset is %s', (_label, offset) => {
    it('Then it has no rank', () => {
      // Arrange
      const sut = rankOfStart;

      // Act
      const result = sut(starts, offset);

      // Assert
      expect(result).toBe(-1);
    });
  });

  describe('When there is no start at all', () => {
    it('Then it has no rank', () => {
      // Arrange
      const sut = rankOfStart;

      // Act
      const result = sut([], 12);

      // Assert
      expect(result).toBe(-1);
    });
  });
});

describe('Given no base that failed to unpack', () => {
  describe('When the unserved bases are judged over many packed copies', () => {
    it('Then none is unserved and the copies are not walked', () => {
      // Arrange
      const walked = vi.fn();
      const copies = new Proxy([] as ReadonlyArray<{ readonly id: ObjectId }>, {
        get: (target, key, receiver) => {
          walked(key);
          return Reflect.get(target, key, receiver);
        },
      });
      const sut = unservedBases;

      // Act
      const result = sut(new Set(), new Map(), copies);

      // Assert
      expect(result.size).toBe(0);
      expect(walked).not.toHaveBeenCalled();
    });
  });
});

describe('Given a failed base that one pack still serves and another does not', () => {
  const base = 'ab'.repeat(20) as ObjectId;

  describe.each([
    ['every packed copy failed', 2, [{ id: base }, { id: base }], [base]],
    ['one packed copy is served', 1, [{ id: base }, { id: base }], []],
  ])('When %s', (_label, failed, copies, expected) => {
    it('Then the base is unserved only when no copy is left', () => {
      // Arrange
      const sut = unservedBases;

      // Act
      const result = sut(new Set([base]), new Map([[base, failed]]), copies);

      // Assert
      expect([...result]).toEqual(expected);
    });
  });
});
