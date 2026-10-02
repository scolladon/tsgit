import { describe, expect, it, vi } from 'vitest';
import { createMemoryContext } from '../../../../../../src/adapters/memory/memory-adapter.js';
import {
  type CatalogueOptions,
  type PackedEntry,
  validatePackedEntry,
} from '../../../../../../src/application/commands/internal/fsck/content-validation.js';
import { packedLocationOf } from '../../../../../../src/application/commands/internal/fsck/object-cache.js';
import { createSpecialBlobLedger } from '../../../../../../src/application/commands/internal/fsck/special-blobs.js';
import { DEFAULT_BIG_FILE_THRESHOLD_BYTES } from '../../../../../../src/application/primitives/internal/big-file-threshold.js';
import { readRawObject } from '../../../../../../src/application/primitives/read-object.js';
import type { ObjectId } from '../../../../../../src/domain/objects/index.js';
import { serializeHeader } from '../../../../../../src/domain/objects/index.js';
import type { Context } from '../../../../../../src/ports/context.js';
import { writeSyntheticPack, writeSyntheticPackIn } from '../../../primitives/pack-fixture.js';

const sut = validatePackedEntry;

/** No strict mode, no special names, no re-typing, no skip list, git's default threshold. */
const CATALOGUE: CatalogueOptions = {
  strict: false,
  specialBlobs: createSpecialBlobLedger(new Map()),
  severities: new Map(),
  skipped: new Set(),
  bigFileThreshold: DEFAULT_BIG_FILE_THRESHOLD_BYTES,
};

const BLOB_SHA_A = new Uint8Array(20).fill(1);
const BLOB_SHA_B = new Uint8Array(20).fill(2);
const ENCODER = new TextEncoder();

/** The entry the store reads `id` from, unpacked through the store. */
async function packedEntryOf(ctx: Context, id: ObjectId): Promise<PackedEntry> {
  const location = await packedLocationOf(ctx, id);
  if (location === undefined) throw new Error(`no pack holds ${id}`);
  return { id, location, unpack: () => readRawObject(ctx, id, { verifyHash: false }) };
}

/** Build one raw tree-entry's bytes: `<mode> <name>\0<20-byte sha>`. */
function buildTreeEntry(mode: string, name: string, sha: Uint8Array): Uint8Array {
  return new Uint8Array([...ENCODER.encode(`${mode} ${name}\0`), ...sha]);
}

/** Concatenate raw tree-entry bytes into a full tree object body. */
function buildTree(...entries: ReadonlyArray<Uint8Array>): Uint8Array {
  return new Uint8Array(entries.flatMap((entry) => [...entry]));
}

/** Plant a raw tree body as a packed (not loose) object; returns its id. */
async function writePackedTree(content: Uint8Array): Promise<{
  readonly ctx: ReturnType<typeof createMemoryContext>;
  readonly treeId: ObjectId;
}> {
  const ctx = createMemoryContext();
  const ids = await writeSyntheticPack(ctx, 'p1', [{ kind: 'base', type: 'tree', content }]);
  return { ctx, treeId: ids[0] as ObjectId };
}

describe('Given a packed blob whose bytes do not hash to its indexed id', () => {
  describe('When validatePackedEntry validates that entry', () => {
    it('Then reports the packed entry corrupt with bit 4, as verify_pack does, and runs no catalogue', async () => {
      // Arrange — readRawObject with verifyHash:false succeeds regardless of
      // the hash, so the mismatch is caught by the pass's own hash check.
      const content = ENCODER.encode('mismatched content');
      const ctx = createMemoryContext();
      const wrongId = '0000000000000000000000000000000000000002' as ObjectId;
      const ids = await writeSyntheticPack(ctx, 'p2', [
        { kind: 'base', type: 'blob', content, idOverride: wrongId },
      ]);
      const blobId = ids[0] as ObjectId;

      // Act
      const result = await sut(ctx, await packedEntryOf(ctx, blobId), CATALOGUE);

      // Assert
      expect(result.findings).toEqual([
        { type: 'pack-entry-corrupt', pack: 'pack-p2', id: blobId },
      ]);
      expect(result.exitBit).toBe(4);
    });
  });
});

describe('Given a packed tree with a hash disagreement and a duplicate entry name', () => {
  describe('When validatePackedEntry validates that entry', () => {
    it('Then the corrupt entry suppresses the catalogue', async () => {
      // Arrange
      const treeBody = buildTree(
        buildTreeEntry('100644', 'a.txt', BLOB_SHA_A),
        buildTreeEntry('100644', 'a.txt', BLOB_SHA_B),
      );
      const ctx = createMemoryContext();
      const wrongId = '0000000000000000000000000000000000000003' as ObjectId;
      const [treeId] = await writeSyntheticPack(ctx, 'p3', [
        { kind: 'base', type: 'tree', content: treeBody, idOverride: wrongId },
      ]);

      // Act
      const result = await sut(ctx, await packedEntryOf(ctx, treeId as ObjectId), CATALOGUE);

      // Assert
      expect(result.findings.map((f) => f.type)).toEqual(['pack-entry-corrupt']);
    });
  });
});

describe('Given a packed blob whose compressed body is damaged', () => {
  describe('When validatePackedEntry validates that entry', () => {
    it('Then reports the entry unpackable by pack and offset with bit 4, as verify_pack does', async () => {
      // Arrange
      const ctx = createMemoryContext();
      const [blobId] = await writeSyntheticPack(ctx, 'p4', [
        { kind: 'base', type: 'blob', content: ENCODER.encode('damaged packed body') },
      ]);
      const packPath = `${ctx.layout.gitDir}/objects/pack/pack-p4.pack`;
      const pack = await ctx.fs.read(packPath);
      pack[pack.length - 24] = pack[pack.length - 24]! ^ 0xff;
      await ctx.fs.write(packPath, pack);

      // Act
      const result = await sut(ctx, await packedEntryOf(ctx, blobId as ObjectId), CATALOGUE);

      // Assert
      expect(result.findings).toEqual([
        { type: 'pack-entry-unpackable', pack: 'pack-p4', id: blobId, offset: 12 },
      ]);
      expect(result.exitBit).toBe(4);
    });
  });
});

describe('Given a donor packed blob whose compressed body is damaged', () => {
  describe('When the borrower validatePackedEntry validates that entry', () => {
    it('Then the unpackable finding carries the donor objects dir', async () => {
      // Arrange
      const donorObjects = '/repo/donor/objects';
      const ctx = createMemoryContext({
        files: { '/repo/.git/objects/info/alternates': ENCODER.encode(`${donorObjects}\n`) },
      });
      const [blobId] = await writeSyntheticPackIn(ctx, donorObjects, 'd1', [
        { kind: 'base', type: 'blob', content: ENCODER.encode('damaged donor body') },
      ]);
      const packPath = `${donorObjects}/pack/pack-d1.pack`;
      const pack = await ctx.fs.read(packPath);
      pack[pack.length - 24] = pack[pack.length - 24]! ^ 0xff;
      await ctx.fs.write(packPath, pack);

      // Act
      const result = await sut(ctx, await packedEntryOf(ctx, blobId as ObjectId), CATALOGUE);

      // Assert
      expect(result.findings).toEqual([
        {
          type: 'pack-entry-unpackable',
          pack: 'pack-d1',
          id: blobId,
          offset: 12,
          objectsDir: donorObjects,
        },
      ]);
    });
  });
});

describe('Given a packed blob validated for content', () => {
  describe('When validatePackedEntry computes its hash', () => {
    it('Then the hasher receives the canonical header then the body, in that order', async () => {
      // Arrange — the order is the mutant kill: a swapped or dropped update
      // call would still hash *something*, but not the canonical
      // `<type> <size>\0<content>` scheme, and no header+body buffer is ever
      // concatenated to build it.
      const content = ENCODER.encode('order-sensitive content');
      const ctx = createMemoryContext();
      const ids = await writeSyntheticPack(ctx, 'order', [{ kind: 'base', type: 'blob', content }]);
      const blobId = ids[0] as ObjectId;
      const updateSpy = vi.fn();
      vi.spyOn(ctx.hash, 'createHasher').mockReturnValue({
        update: updateSpy,
        digest: vi.fn(),
        digestHex: vi.fn().mockResolvedValue(blobId),
      });

      // Act
      await sut(ctx, await packedEntryOf(ctx, blobId), CATALOGUE);

      // Assert
      expect(updateSpy.mock.calls).toHaveLength(2);
      expect(updateSpy.mock.calls[0]?.[0]).toEqual(serializeHeader('blob', content.length));
      expect(updateSpy.mock.calls[1]?.[0]).toEqual(content);
    });
  });
});

describe('Given a packed tree with a duplicate entry name', () => {
  describe('When validatePackedEntry validates that entry', () => {
    it('Then emits a duplicateEntries finding instead of badType', async () => {
      // Arrange
      const treeBody = buildTree(
        buildTreeEntry('100644', 'a.txt', BLOB_SHA_A),
        buildTreeEntry('100644', 'a.txt', BLOB_SHA_B),
      );
      const { ctx, treeId } = await writePackedTree(treeBody);

      // Act
      const result = await sut(ctx, await packedEntryOf(ctx, treeId), CATALOGUE);

      // Assert
      const msgIds = result.findings
        .filter((f) => f.type === 'bad-object' && f.id === treeId)
        .map((f) => (f.type === 'bad-object' ? f.msgId : undefined));
      expect(msgIds).toContain('duplicateEntries');
      expect(msgIds).not.toContain('badType');
    });

    it('Then its error carries bit 4 alone, as verify_pack reports it', async () => {
      // Arrange
      const treeBody = buildTree(
        buildTreeEntry('100644', 'a.txt', BLOB_SHA_A),
        buildTreeEntry('100644', 'a.txt', BLOB_SHA_B),
      );
      const { ctx, treeId } = await writePackedTree(treeBody);

      // Act
      const result = await sut(ctx, await packedEntryOf(ctx, treeId), CATALOGUE);

      // Assert
      expect(result.exitBit).toBe(4);
    });
  });
});

describe('Given a packed tree with a non-octal byte in the mode', () => {
  describe('When validatePackedEntry validates that entry', () => {
    it('Then emits a badTree finding instead of badType', async () => {
      // Arrange
      const treeBody = buildTree(buildTreeEntry('10064a', 'a.txt', BLOB_SHA_A));
      const { ctx, treeId } = await writePackedTree(treeBody);

      // Act
      const result = await sut(ctx, await packedEntryOf(ctx, treeId), CATALOGUE);

      // Assert
      const msgIds = result.findings
        .filter((f) => f.type === 'bad-object' && f.id === treeId)
        .map((f) => (f.type === 'bad-object' ? f.msgId : undefined));
      expect(msgIds).toContain('badTree');
      expect(msgIds).not.toContain('badType');
    });
  });
});

describe('Given a packed tree with an entry named "."', () => {
  describe('When validatePackedEntry validates that entry', () => {
    it('Then emits a hasDot finding instead of badType', async () => {
      // Arrange
      const treeBody = buildTree(buildTreeEntry('100644', '.', BLOB_SHA_A));
      const { ctx, treeId } = await writePackedTree(treeBody);

      // Act
      const result = await sut(ctx, await packedEntryOf(ctx, treeId), CATALOGUE);

      // Assert
      const msgIds = result.findings
        .filter((f) => f.type === 'bad-object' && f.id === treeId)
        .map((f) => (f.type === 'bad-object' ? f.msgId : undefined));
      expect(msgIds).toContain('hasDot');
      expect(msgIds).not.toContain('badType');
    });
  });
});

describe('Given a packed tree with an entry named ".."', () => {
  describe('When validatePackedEntry validates that entry', () => {
    it('Then emits a hasDotdot finding instead of badType', async () => {
      // Arrange
      const treeBody = buildTree(buildTreeEntry('100644', '..', BLOB_SHA_A));
      const { ctx, treeId } = await writePackedTree(treeBody);

      // Act
      const result = await sut(ctx, await packedEntryOf(ctx, treeId), CATALOGUE);

      // Assert
      const msgIds = result.findings
        .filter((f) => f.type === 'bad-object' && f.id === treeId)
        .map((f) => (f.type === 'bad-object' ? f.msgId : undefined));
      expect(msgIds).toContain('hasDotdot');
      expect(msgIds).not.toContain('badType');
    });
  });
});

describe('Given a packed tree with an entry name containing "/"', () => {
  describe('When validatePackedEntry validates that entry', () => {
    it('Then emits a fullPathname finding instead of badType', async () => {
      // Arrange
      const treeBody = buildTree(buildTreeEntry('100644', 'a/b', BLOB_SHA_A));
      const { ctx, treeId } = await writePackedTree(treeBody);

      // Act
      const result = await sut(ctx, await packedEntryOf(ctx, treeId), CATALOGUE);

      // Assert
      const msgIds = result.findings
        .filter((f) => f.type === 'bad-object' && f.id === treeId)
        .map((f) => (f.type === 'bad-object' ? f.msgId : undefined));
      expect(msgIds).toContain('fullPathname');
      expect(msgIds).not.toContain('badType');
    });
  });
});

describe('Given a packed tree whose entries are not sorted', () => {
  describe('When validatePackedEntry validates that entry', () => {
    it('Then emits a treeNotSorted finding and no spurious hash-mismatch', async () => {
      // Arrange — 'z.txt' before 'a.txt', unsorted, planted with its ORIGINAL
      // (unsorted) bytes as the id-hashed content — re-serializing (which
      // canonicalises order) would compute a different hash than this id.
      const treeBody = buildTree(
        buildTreeEntry('100644', 'z.txt', BLOB_SHA_A),
        buildTreeEntry('100644', 'a.txt', BLOB_SHA_B),
      );
      const { ctx, treeId } = await writePackedTree(treeBody);

      // Act
      const result = await sut(ctx, await packedEntryOf(ctx, treeId), CATALOGUE);

      // Assert
      const msgIds = result.findings
        .filter((f) => f.type === 'bad-object' && f.id === treeId)
        .map((f) => (f.type === 'bad-object' ? f.msgId : undefined));
      expect(msgIds).toContain('treeNotSorted');
      expect(result.findings.some((f) => f.type === 'hash-mismatch' && f.id === treeId)).toBe(
        false,
      );
    });
  });
});

describe('Given a packed blob whose hash cannot be computed', () => {
  describe('When validatePackedEntry verifies its hash', () => {
    it('Then the hashing fault propagates rather than passing the object as verified', async () => {
      // Arrange
      const content = ENCODER.encode('content the hasher refuses');
      const ctx = createMemoryContext();
      const ids = await writeSyntheticPack(ctx, 'hasher-fault', [
        { kind: 'base', type: 'blob', content },
      ]);
      const blobId = ids[0] as ObjectId;
      const fault = new Error('hasher unavailable');
      vi.spyOn(ctx.hash, 'createHasher').mockReturnValue({
        update: vi.fn(),
        digest: vi.fn(),
        digestHex: vi.fn().mockRejectedValue(fault),
      });
      const entry = await packedEntryOf(ctx, blobId);

      // Act
      let caught: unknown;
      try {
        await sut(ctx, entry, CATALOGUE);
        expect.unreachable();
      } catch (error) {
        caught = error;
      }

      // Assert
      expect(caught).toBe(fault);
    });
  });
});
