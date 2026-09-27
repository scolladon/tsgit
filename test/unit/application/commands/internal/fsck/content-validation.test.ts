import { describe, expect, it, vi } from 'vitest';
import { createMemoryContext } from '../../../../../../src/adapters/memory/memory-adapter.js';
import {
  buildBlobFilenameMap,
  runContentValidationPass,
} from '../../../../../../src/application/commands/internal/fsck/content-validation.js';
import {
  looseObjectPath,
  objectsDir,
} from '../../../../../../src/application/primitives/path-layout.js';
import type { ObjectId, TreeEntry } from '../../../../../../src/domain/objects/index.js';
import {
  FILE_MODE,
  serializeHeader,
  serializeObject,
} from '../../../../../../src/domain/objects/index.js';
import { treeEntry } from '../../../../../../src/domain/objects/tree.js';
import { MAX_INFLATE_OUTPUT_BYTES } from '../../../../../../src/ports/compressor.js';
import { writeSyntheticPack } from '../../../primitives/pack-fixture.js';

const sut = runContentValidationPass;

/** No `fsck.skipList` configured. */
const NO_SKIPS: ReadonlySet<string> = new Set();

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

/** Write a loose object directly at `id`, with a header size CLAIM that may
 *  disagree with `body`'s real length — content-validation's size-lying rows
 *  never need the object at its own hash (the interop suite pins that). */
async function writeLooseAtId(
  ctx: ReturnType<typeof createMemoryContext>,
  id: ObjectId,
  type: string,
  claim: number,
  body: Uint8Array,
): Promise<void> {
  const raw = buildTree(ENCODER.encode(`${type} ${claim}\0`), body);
  const compressed = await ctx.compressor.deflate(raw);
  const dir = objectsDir(ctx.layout.gitDir, id.slice(0, 2));
  await ctx.fs.mkdir(dir);
  await ctx.fs.writeExclusive(looseObjectPath(ctx.layout.gitDir, id), compressed);
}

describe('Given a universe containing an object that is neither loose nor readable from a pack', () => {
  describe('When runContentValidationPass validates that object', () => {
    it('Then emits a bad-object finding with msgId badType and sets the corrupt exit bit', async () => {
      // Arrange
      const ctx = createMemoryContext();
      const unreadableId = '0000000000000000000000000000000000000001' as ObjectId;

      // Act
      const result = await sut(ctx, new Set([unreadableId]), false, new Map(), new Map(), NO_SKIPS);

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
      const result = await sut(ctx, new Set([blobId]), false, new Map(), new Map(), NO_SKIPS);

      // Assert
      const badTypeFindings = result.findings.filter(
        (f) => f.type === 'bad-object' && f.msgId === 'badType',
      );
      expect(badTypeFindings).toHaveLength(0);
      const hashMismatchFindings = result.findings.filter((f) => f.type === 'hash-mismatch');
      expect(hashMismatchFindings).toHaveLength(1);
      expect(hashMismatchFindings[0]).toMatchObject({ id: blobId });
      if (hashMismatchFindings[0]?.type === 'hash-mismatch') {
        // The reported `actual` is the REAL hash of the object's own bytes
        // (header + content, computed via the same hash service the SUT
        // uses) — not merely "not the wrong indexed id".
        const realBytes = serializeObject({ type: 'blob', content, id: wrongId }, ctx.hashConfig);
        const realHash = await ctx.hash.hashHex(realBytes);
        expect(hashMismatchFindings[0].actual).toBe(realHash);
      }
    });
  });
});

describe('Given a packed blob validated for content', () => {
  describe('When runContentValidationPass computes its hash', () => {
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
      await sut(ctx, new Set([blobId]), false, new Map(), new Map(), NO_SKIPS);

      // Assert
      expect(updateSpy.mock.calls).toHaveLength(2);
      expect(updateSpy.mock.calls[0]?.[0]).toEqual(serializeHeader('blob', content.length));
      expect(updateSpy.mock.calls[1]?.[0]).toEqual(content);
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
      const result = await sut(ctx, new Set([treeId]), false, new Map(), new Map(), NO_SKIPS);

      // Assert
      const msgIds = result.findings
        .filter((f) => f.type === 'bad-object' && f.id === treeId)
        .map((f) => (f.type === 'bad-object' ? f.msgId : undefined));
      expect(msgIds).toContain('duplicateEntries');
      expect(msgIds).not.toContain('badType');
    });
  });
});

describe('Given a packed tree with a non-octal byte in the mode', () => {
  describe('When runContentValidationPass validates that object', () => {
    it('Then emits a badTree finding instead of badType', async () => {
      // Arrange
      const treeBody = buildTree(buildTreeEntry('10064a', 'a.txt', BLOB_SHA_A));
      const { ctx, treeId } = await writePackedTree(treeBody);

      // Act
      const result = await sut(ctx, new Set([treeId]), false, new Map(), new Map(), NO_SKIPS);

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
  describe('When runContentValidationPass validates that object', () => {
    it('Then emits a hasDot finding instead of badType', async () => {
      // Arrange
      const treeBody = buildTree(buildTreeEntry('100644', '.', BLOB_SHA_A));
      const { ctx, treeId } = await writePackedTree(treeBody);

      // Act
      const result = await sut(ctx, new Set([treeId]), false, new Map(), new Map(), NO_SKIPS);

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
      const result = await sut(ctx, new Set([treeId]), false, new Map(), new Map(), NO_SKIPS);

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
      const result = await sut(ctx, new Set([treeId]), false, new Map(), new Map(), NO_SKIPS);

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
      const result = await sut(ctx, new Set([treeId]), false, new Map(), new Map(), NO_SKIPS);

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

describe('Given a tree entry whose nameBytes are ".gitmodules" but whose decoded name field disagrees', () => {
  describe('When buildBlobFilenameMap runs', () => {
    it('Then the blob is mapped under ".gitmodules" — the decision reads nameBytes, not name', () => {
      // Arrange — a spread can override `name` while `nameBytes` stays correct
      // (TypeScript's brand check does not catch it); the map must still
      // decide from nameBytes.
      const blobId = '0000000000000000000000000000000000000003' as ObjectId;
      const treeId = '0000000000000000000000000000000000000004' as ObjectId;
      const real = treeEntry(FILE_MODE.REGULAR, '.gitmodules', blobId);
      const spoofed = { ...real, name: 'config.txt' } as TreeEntry;
      const cache = new Map([[treeId, { type: 'tree' as const, entries: [spoofed] }]]);

      // Act
      const result = buildBlobFilenameMap(new Set([treeId]), cache);

      // Assert
      expect(result.get(blobId)).toBe('.gitmodules');
    });
  });
});

describe('Given a tree entry whose decoded name field reads ".gitmodules" but whose nameBytes disagree', () => {
  describe('When buildBlobFilenameMap runs', () => {
    it('Then the blob is NOT mapped as a special filename — the decision reads nameBytes, not name', () => {
      // Arrange
      const blobId = '0000000000000000000000000000000000000005' as ObjectId;
      const treeId = '0000000000000000000000000000000000000006' as ObjectId;
      const real = treeEntry(FILE_MODE.REGULAR, 'config.txt', blobId);
      const spoofed = { ...real, name: '.gitmodules' } as TreeEntry;
      const cache = new Map([[treeId, { type: 'tree' as const, entries: [spoofed] }]]);

      // Act
      const result = buildBlobFilenameMap(new Set([treeId]), cache);

      // Assert
      expect(result.has(blobId)).toBe(false);
    });
  });
});

describe('Given a tree entry whose nameBytes are ".gitattributes" but whose decoded name field disagrees', () => {
  describe('When buildBlobFilenameMap runs', () => {
    it('Then the blob is mapped under ".gitattributes" — the decision reads nameBytes, not name', () => {
      // Arrange — same byte-sensitivity as the .gitmodules case above, for
      // fsck's OTHER dedicated blob-content check (specialBlobName's second branch).
      const blobId = '0000000000000000000000000000000000000007' as ObjectId;
      const treeId = '0000000000000000000000000000000000000008' as ObjectId;
      const real = treeEntry(FILE_MODE.REGULAR, '.gitattributes', blobId);
      const spoofed = { ...real, name: 'config.txt' } as TreeEntry;
      const cache = new Map([[treeId, { type: 'tree' as const, entries: [spoofed] }]]);

      // Act
      const result = buildBlobFilenameMap(new Set([treeId]), cache);

      // Assert
      expect(result.get(blobId)).toBe('.gitattributes');
    });
  });
});

describe('Given fsck.<msg-id> re-types the id an unreadable object would report', () => {
  describe('When runContentValidationPass validates that object', () => {
    it.each([
      { configured: 'ignore' as const, label: 'ignore' },
      { configured: 'warning' as const, label: 'warn' },
    ])('Then the corrupt-object report survives at error severity for $label', async (row) => {
      // Arrange — git raises this one through error(), which no fsck.<id> re-types.
      const ctx = createMemoryContext();
      const unreadableId = '0000000000000000000000000000000000000003' as ObjectId;
      const severities = new Map([['badType'.toLowerCase(), row.configured]]);

      // Act
      const result = await sut(
        ctx,
        new Set([unreadableId]),
        false,
        new Map(),
        severities,
        NO_SKIPS,
      );

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

describe("Given a loose blob whose body overran its claim inside git's 32-byte header window", () => {
  describe('When runContentValidationPass validates that object', () => {
    it('Then emits a hash-mismatch finding whose actual is SHA-1 of the header plus the truncated claim', async () => {
      // Arrange — header (7 bytes) + body (10 bytes) = 17, inside the window;
      // the claim (6) truncates well short of the real 10-byte body.
      const ctx = createMemoryContext();
      const id = 'a'.repeat(40) as ObjectId;
      const body = ENCODER.encode('HELLOWORLD');
      await writeLooseAtId(ctx, id, 'blob', 6, body);
      const expectedActual = await ctx.hash.hashHex(
        buildTree(ENCODER.encode('blob 6\0'), body.subarray(0, 6)),
      );

      // Act
      const result = await sut(ctx, new Set([id]), false, new Map(), new Map(), NO_SKIPS);

      // Assert
      const mismatch = result.findings.find((f) => f.type === 'hash-mismatch');
      expect(mismatch).toMatchObject({ id, actual: expectedActual });
    });
  });
});

describe('Given a loose blob whose body under-ran its claim', () => {
  describe('When runContentValidationPass validates that object', () => {
    it("Then emits a hash-mismatch finding whose actual is git's zero-padded SHA-1", async () => {
      // Arrange — a 10-byte body against a 20-byte claim: git's own
      // buffered-tier read pads the residual 10 bytes with zeros.
      const ctx = createMemoryContext();
      const id = 'b'.repeat(40) as ObjectId;
      const body = ENCODER.encode('SHORT-BODY');
      await writeLooseAtId(ctx, id, 'blob', 20, body);
      const expectedActual = await ctx.hash.hashHex(
        buildTree(ENCODER.encode('blob 20\0'), body, new Uint8Array(10)),
      );

      // Act
      const result = await sut(ctx, new Set([id]), false, new Map(), new Map(), NO_SKIPS);

      // Assert
      const mismatch = result.findings.find((f) => f.type === 'hash-mismatch');
      expect(mismatch).toMatchObject({ id, actual: expectedActual });
    });
  });
});

describe('Given a loose blob whose under-run claim exceeds the inflate ceiling', () => {
  describe('When runContentValidationPass validates that object', () => {
    it('Then emits a bad-object finding instead of hashing gigabytes of padding', async () => {
      // Arrange — a claim past MAX_INFLATE_OUTPUT_BYTES over a tiny real
      // body: the residual would be gigabytes of zero padding.
      const ctx = createMemoryContext();
      const id = 'c'.repeat(40) as ObjectId;
      const body = ENCODER.encode('SHORT');
      await writeLooseAtId(ctx, id, 'blob', MAX_INFLATE_OUTPUT_BYTES + 1, body);

      // Act
      const result = await sut(ctx, new Set([id]), false, new Map(), new Map(), NO_SKIPS);

      // Assert
      expect(result.findings).toEqual([
        {
          type: 'bad-object',
          id,
          objectType: 'unknown',
          msgId: 'unterminatedHeader',
          severity: 'error',
        },
      ]);
      expect(result.exitBit).toBe(1);
    });
  });
});

describe("Given a loose blob whose body overran its claim past git's 32-byte header window", () => {
  describe('When runContentValidationPass validates that object', () => {
    it('Then emits a bad-object finding — the same undecodable finding git reports for a corrupt object', async () => {
      // Arrange — header (7 bytes) + a 40-byte body sits past the 32-byte
      // window, so the buffered read refuses rather than truncating.
      const ctx = createMemoryContext();
      const id = 'd'.repeat(40) as ObjectId;
      const body = ENCODER.encode('x'.repeat(40));
      await writeLooseAtId(ctx, id, 'blob', 6, body);

      // Act
      const result = await sut(ctx, new Set([id]), false, new Map(), new Map(), NO_SKIPS);

      // Assert
      expect(result.findings).toEqual([
        {
          type: 'bad-object',
          id,
          objectType: 'unknown',
          msgId: 'unterminatedHeader',
          severity: 'error',
        },
      ]);
      expect(result.exitBit).toBe(1);
    });
  });
});

describe('Given a loose object whose compressed bytes are not valid zlib', () => {
  describe('When runContentValidationPass validates that object', () => {
    it('Then emits a bad-object finding via the zlib-failure path, not the header-parse path', async () => {
      // Arrange — a zlib decode fault reaches the SAME undecodable finding
      // as a header-parse fault, through looseHeaderFailure's non-candidate
      // branch (its reason defaults to '', never 'unknown object type').
      const ctx = createMemoryContext();
      const id = 'e'.repeat(40) as ObjectId;
      const dir = objectsDir(ctx.layout.gitDir, id.slice(0, 2));
      await ctx.fs.mkdir(dir);
      await ctx.fs.writeExclusive(
        looseObjectPath(ctx.layout.gitDir, id),
        new Uint8Array([0xde, 0xad, 0xbe, 0xef]),
      );

      // Act
      const result = await sut(ctx, new Set([id]), false, new Map(), new Map(), NO_SKIPS);

      // Assert
      expect(result.findings).toEqual([
        {
          type: 'bad-object',
          id,
          objectType: 'unknown',
          msgId: 'unterminatedHeader',
          severity: 'error',
        },
      ]);
      expect(result.exitBit).toBe(1);
    });
  });
});
