import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../../../src/adapters/memory/memory-adapter.js';
import type { CatalogueOptions } from '../../../../../../src/application/commands/internal/fsck/content-validation.js';
import { createSpecialBlobLedger } from '../../../../../../src/application/commands/internal/fsck/special-blobs.js';
import type { FsckOptions } from '../../../../../../src/application/commands/internal/fsck/types.js';
import { runVerifyPackPass } from '../../../../../../src/application/commands/internal/fsck/verify-pack.js';
import { DEFAULT_BIG_FILE_THRESHOLD_BYTES } from '../../../../../../src/application/primitives/internal/big-file-threshold.js';
import { SHA1_CONFIG } from '../../../../../../src/domain/objects/hash-config.js';
import type { ObjectId } from '../../../../../../src/domain/objects/index.js';
import { hexToBytes } from '../../../../../../src/domain/objects/index.js';
import { crc32 } from '../../../../../../src/domain/storage/crc32.js';
import type { Context } from '../../../../../../src/ports/context.js';
import { writeSyntheticPack, writeSyntheticPackIn } from '../../../primitives/pack-fixture.js';

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
      await writeSyntheticPack(ctx, 'healthy', blobEntries('a', 'b'));

      // Act
      const result = await sut(ctx, FULL);

      // Assert
      expect(result).toEqual({ findings: [], exitBit: 0 });
    });
  });
});

describe('Given a pack whose .idx trailer is corrupt', () => {
  describe('When the verify-pack pass runs', () => {
    it('Then it reports the index checksum mismatch with bit 4', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await writeSyntheticPack(ctx, 'idx-trailer', blobEntries('a'));
      await flipByte(ctx, idxPathIn(primaryObjects(ctx), 'idx-trailer'), (n) => n - 1);

      // Act
      const result = await sut(ctx, FULL);

      // Assert
      expect(result).toEqual({
        findings: [{ type: 'pack-index-checksum-mismatch', pack: 'pack-idx-trailer' }],
        exitBit: 4,
      });
    });
  });
});

describe('Given a pack whose .idx records a wrong CRC for one entry', () => {
  describe('When the verify-pack pass runs', () => {
    it('Then it reports that entry by id and pack offset with bit 4', async () => {
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
        exitBit: 4,
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
        exitBit: 4,
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
      expect(result).toEqual({ findings: [], exitBit: 0 });
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
      expect(result.exitBit).toBe(4);
    });
  });
});

describe('Given a packed blob whose bytes do not hash to its indexed id', () => {
  describe('When the verify-pack pass runs', () => {
    it('Then it reports the packed entry corrupt with bit 4 and runs no catalogue', async () => {
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
        exitBit: 4,
      });
    });
  });
});

describe('Given a tree with duplicate entries stored in two intact packs', () => {
  describe('When the verify-pack pass runs', () => {
    it('Then it reports the catalogue error once per copy with bit 4, as verify_pack does', async () => {
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
      expect(result.exitBit).toBe(4);
    });
  });
});
