import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../../../src/adapters/memory/memory-adapter.js';
import { runContentValidationPass } from '../../../../../../src/application/commands/internal/fsck/content-validation.js';
import type { ObjectId } from '../../../../../../src/domain/objects/index.js';
import { writeSyntheticPack } from '../../../primitives/pack-fixture.js';

const sut = runContentValidationPass;

const BLOB_SHA_A = new Uint8Array(20).fill(1);
const BLOB_SHA_B = new Uint8Array(20).fill(2);
const ENCODER = new TextEncoder();

/** Build one raw tree-entry's bytes: `<mode> <name>\0<20-byte sha>`. */
function buildTreeEntry(mode: string, name: string, sha: Uint8Array): Uint8Array {
  const modeBytes = ENCODER.encode(mode);
  const nameBytes = ENCODER.encode(name);
  const entry = new Uint8Array(modeBytes.length + 1 + nameBytes.length + 1 + sha.length);
  let offset = 0;
  entry.set(modeBytes, offset);
  offset += modeBytes.length;
  entry[offset++] = 0x20;
  entry.set(nameBytes, offset);
  offset += nameBytes.length;
  entry[offset++] = 0x00;
  entry.set(sha, offset);
  return entry;
}

/** Concatenate raw tree-entry bytes into a full tree object body. */
function buildTree(...entries: ReadonlyArray<Uint8Array>): Uint8Array {
  const total = entries.reduce((sum, entry) => sum + entry.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const entry of entries) {
    result.set(entry, offset);
    offset += entry.length;
  }
  return result;
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

describe('Given a universe containing an object that is neither loose nor readable from a pack', () => {
  describe('When runContentValidationPass validates that object', () => {
    it('Then emits a bad-object finding with msgId badType and sets the corrupt exit bit', async () => {
      // Arrange
      const ctx = createMemoryContext();
      const unreadableId = '0000000000000000000000000000000000000001' as ObjectId;

      // Act
      const result = await sut(ctx, new Set([unreadableId]), false, new Map());

      // Assert
      expect(result.findings).toEqual([
        {
          type: 'bad-object',
          id: unreadableId,
          objectType: 'unknown',
          msgId: 'badType',
          severity: 'error',
        },
      ]);
      expect(result.exitBit).toBe(1);
    });
  });
});

describe('Given a packed blob whose bytes do not hash to its indexed id', () => {
  describe('When runContentValidationPass validates that object', () => {
    it('Then emits a hash-mismatch finding, not badType (verifyHash:false on the pack read still surfaces the mismatch)', async () => {
      // Arrange — readRawObject with verifyHash:false (what tryGetRawObjectBody
      // uses for pack reads) succeeds regardless of the hash, so the mismatch
      // must be caught by validateOneObject's own hash check afterward.
      const content = ENCODER.encode('mismatched content');
      const ctx = createMemoryContext();
      const wrongId = '0000000000000000000000000000000000000002' as ObjectId;
      const ids = await writeSyntheticPack(ctx, 'p2', [
        { kind: 'base', type: 'blob', content, idOverride: wrongId },
      ]);
      const blobId = ids[0] as ObjectId;

      // Act
      const result = await sut(ctx, new Set([blobId]), false, new Map());

      // Assert
      const badTypeFindings = result.findings.filter(
        (f) => f.type === 'bad-object' && f.msgId === 'badType',
      );
      expect(badTypeFindings).toHaveLength(0);
      const hashMismatchFindings = result.findings.filter((f) => f.type === 'hash-mismatch');
      expect(hashMismatchFindings).toHaveLength(1);
      expect(hashMismatchFindings[0]).toMatchObject({ id: blobId });
      if (hashMismatchFindings[0]?.type === 'hash-mismatch') {
        expect(hashMismatchFindings[0].actual).not.toBe(blobId);
      }
    });
  });
});

describe('Given a packed tree with a duplicate entry name', () => {
  describe('When runContentValidationPass validates that object', () => {
    it('Then emits a duplicateEntries finding instead of badType', async () => {
      // Arrange
      const treeBody = buildTree(
        buildTreeEntry('100644', 'a.txt', BLOB_SHA_A),
        buildTreeEntry('100644', 'a.txt', BLOB_SHA_B),
      );
      const { ctx, treeId } = await writePackedTree(treeBody);

      // Act
      const result = await sut(ctx, new Set([treeId]), false, new Map());

      // Assert
      const msgIds = result.findings
        .filter((f) => f.type === 'bad-object' && f.id === treeId)
        .map((f) => (f.type === 'bad-object' ? f.msgId : undefined));
      expect(msgIds).toContain('duplicateEntries');
      expect(msgIds).not.toContain('badType');
    });
  });
});

describe('Given a packed tree with an entry named "."', () => {
  describe('When runContentValidationPass validates that object', () => {
    it('Then emits a hasDot finding instead of badType', async () => {
      // Arrange
      const treeBody = buildTree(buildTreeEntry('100644', '.', BLOB_SHA_A));
      const { ctx, treeId } = await writePackedTree(treeBody);

      // Act
      const result = await sut(ctx, new Set([treeId]), false, new Map());

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
  describe('When runContentValidationPass validates that object', () => {
    it('Then emits a hasDotdot finding instead of badType', async () => {
      // Arrange
      const treeBody = buildTree(buildTreeEntry('100644', '..', BLOB_SHA_A));
      const { ctx, treeId } = await writePackedTree(treeBody);

      // Act
      const result = await sut(ctx, new Set([treeId]), false, new Map());

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
  describe('When runContentValidationPass validates that object', () => {
    it('Then emits a fullPathname finding instead of badType', async () => {
      // Arrange
      const treeBody = buildTree(buildTreeEntry('100644', 'a/b', BLOB_SHA_A));
      const { ctx, treeId } = await writePackedTree(treeBody);

      // Act
      const result = await sut(ctx, new Set([treeId]), false, new Map());

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
  describe('When runContentValidationPass validates that object', () => {
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
      const result = await sut(ctx, new Set([treeId]), false, new Map());

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
