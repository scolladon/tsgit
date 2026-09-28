import { describe, expect, it, vi } from 'vitest';
import { createMemoryContext } from '../../../../../../src/adapters/memory/memory-adapter.js';
import {
  buildBlobFilenameMap,
  runContentValidationPass,
} from '../../../../../../src/application/commands/internal/fsck/content-validation.js';
import { DEFAULT_BIG_FILE_THRESHOLD_BYTES } from '../../../../../../src/application/commands/internal/fsck/read-configuration.js';
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

/** git's own `core.bigFileThreshold` default — every row that does not exist
 *  to exercise the big-file gate itself uses this, so it never fires. */
const DEFAULT_THRESHOLD = DEFAULT_BIG_FILE_THRESHOLD_BYTES;

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
      const result = await sut(
        ctx,
        new Set([unreadableId]),
        false,
        new Map(),
        new Map(),
        NO_SKIPS,
        DEFAULT_THRESHOLD,
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
      // Assert — never loose, so no readObject/content-validation typing
      // disagreement is possible; typeUnknownIds stays empty.
      expect(result.typeUnknownIds.has(unreadableId)).toBe(false);
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
      const result = await sut(
        ctx,
        new Set([blobId]),
        false,
        new Map(),
        new Map(),
        NO_SKIPS,
        DEFAULT_THRESHOLD,
      );

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
      // Assert — a packed mismatch carries no path to disagree with, so it
      // never suppresses the catalogue and never marks the id unreadable.
      expect(result.typeUnknownIds.has(blobId)).toBe(false);
    });
  });
});

describe('Given a loose object whose hash disagrees with its path, shadowing a good packed copy of the same id', () => {
  describe('When runContentValidationPass validates that object', () => {
    it('Then emits hash-mismatch and leaves typeUnknownIds empty — the pack copy still types it', async () => {
      // Arrange — git types this id from the pack (`has_object_pack`); the
      // shadowing loose file is reported through the SEPARATE hash-mismatch
      // finding, never through the reachability-typing override.
      const packedContent = ENCODER.encode('real packed content');
      const ctx = createMemoryContext();
      const ids = await writeSyntheticPack(ctx, 'shadow', [
        { kind: 'base', type: 'blob', content: packedContent },
      ]);
      const blobId = ids[0] as ObjectId;
      const shadowingContent = ENCODER.encode('shadowing loose content');
      await writeLooseAtId(ctx, blobId, 'blob', shadowingContent.length, shadowingContent);

      // Act
      const result = await sut(
        ctx,
        new Set([blobId]),
        false,
        new Map(),
        new Map(),
        NO_SKIPS,
        DEFAULT_THRESHOLD,
      );

      // Assert
      const hashMismatchFindings = result.findings.filter((f) => f.type === 'hash-mismatch');
      expect(hashMismatchFindings).toHaveLength(1);
      expect(hashMismatchFindings[0]).toMatchObject({ id: blobId });
      expect(result.typeUnknownIds.has(blobId)).toBe(false);
    });
  });
});

describe('Given a loose object whose hash disagrees with its path, and NO packed copy backs it', () => {
  describe('When runContentValidationPass validates that object', () => {
    it('Then still marks it unreadable for reachability typing', async () => {
      // Arrange — the ORIGINAL (pre-fix) behaviour, unaffected by the pack
      // gate: no pack claims this id, so it is still untyped. An HONEST
      // body (claim === length) stored at a wrong-hash path, never an
      // under/over-run — isolates the pack gate from the size-lying arms.
      const ctx = createMemoryContext();
      const id = 'c'.repeat(40) as ObjectId;
      const body = ENCODER.encode('unshadowed content');
      await writeLooseAtId(ctx, id, 'blob', body.length, body);

      // Act
      const result = await sut(
        ctx,
        new Set([id]),
        false,
        new Map(),
        new Map(),
        NO_SKIPS,
        DEFAULT_THRESHOLD,
      );

      // Assert
      const hashMismatchFindings = result.findings.filter((f) => f.type === 'hash-mismatch');
      expect(hashMismatchFindings).toHaveLength(1);
      expect(result.typeUnknownIds.has(id)).toBe(true);
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
      await sut(ctx, new Set([blobId]), false, new Map(), new Map(), NO_SKIPS, DEFAULT_THRESHOLD);

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
      const result = await sut(
        ctx,
        new Set([treeId]),
        false,
        new Map(),
        new Map(),
        NO_SKIPS,
        DEFAULT_THRESHOLD,
      );

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
      const result = await sut(
        ctx,
        new Set([treeId]),
        false,
        new Map(),
        new Map(),
        NO_SKIPS,
        DEFAULT_THRESHOLD,
      );

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
      const result = await sut(
        ctx,
        new Set([treeId]),
        false,
        new Map(),
        new Map(),
        NO_SKIPS,
        DEFAULT_THRESHOLD,
      );

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
      const result = await sut(
        ctx,
        new Set([treeId]),
        false,
        new Map(),
        new Map(),
        NO_SKIPS,
        DEFAULT_THRESHOLD,
      );

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
      const result = await sut(
        ctx,
        new Set([treeId]),
        false,
        new Map(),
        new Map(),
        NO_SKIPS,
        DEFAULT_THRESHOLD,
      );

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
      const result = await sut(
        ctx,
        new Set([treeId]),
        false,
        new Map(),
        new Map(),
        NO_SKIPS,
        DEFAULT_THRESHOLD,
      );

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
        DEFAULT_THRESHOLD,
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
      const result = await sut(
        ctx,
        new Set([id]),
        false,
        new Map(),
        new Map(),
        NO_SKIPS,
        DEFAULT_THRESHOLD,
      );

      // Assert
      const mismatch = result.findings.find((f) => f.type === 'hash-mismatch');
      expect(mismatch).toMatchObject({ id, actual: expectedActual });
      // Assert — git's read_loose_object returns on the mismatch before
      // typing the object, so the reachability pass must not type it either.
      expect(result.typeUnknownIds.has(id)).toBe(true);
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
      const result = await sut(
        ctx,
        new Set([id]),
        false,
        new Map(),
        new Map(),
        NO_SKIPS,
        DEFAULT_THRESHOLD,
      );

      // Assert
      const mismatch = result.findings.find((f) => f.type === 'hash-mismatch');
      expect(mismatch).toMatchObject({ id, actual: expectedActual });
      // Assert — git's read_loose_object returns on the mismatch before
      // typing the object, so the reachability pass must not type it either.
      expect(result.typeUnknownIds.has(id)).toBe(true);
    });
  });
});

describe('Given a loose blob whose declared size exceeds core.bigFileThreshold and under-ran its claim', () => {
  describe('When runContentValidationPass validates that object', () => {
    it("Then emits a hash-mismatch finding whose actual is UNPADDED — git's streamed hash, not the zero-padded one", async () => {
      // Arrange — declared 2000 past a 1024-byte threshold: git's
      // `check_stream_oid` streams the real (short) body and hashes it
      // under the DECLARED-size header, with no padding at all.
      const ctx = createMemoryContext();
      const id = 'f'.repeat(40) as ObjectId;
      const body = ENCODER.encode('SHORT');
      const threshold = 1024;
      const claim = threshold + 1;
      await writeLooseAtId(ctx, id, 'blob', claim, body);
      const expectedActual = await ctx.hash.hashHex(
        buildTree(ENCODER.encode(`blob ${claim}\0`), body),
      );

      // Act
      const result = await sut(
        ctx,
        new Set([id]),
        false,
        new Map(),
        new Map(),
        NO_SKIPS,
        threshold,
      );

      // Assert
      const mismatch = result.findings.find((f) => f.type === 'hash-mismatch');
      expect(mismatch).toMatchObject({ id, actual: expectedActual });
      expect(result.findings.some((f) => f.type === 'bad-object')).toBe(false);
      // Assert — git's read_loose_object returns on the mismatch before
      // typing the object, so the reachability pass must not type it either.
      expect(result.typeUnknownIds.has(id)).toBe(true);
    });
  });
});

describe('Given a loose blob whose declared size sits exactly AT core.bigFileThreshold', () => {
  describe('When runContentValidationPass validates that object', () => {
    it('Then still takes the small-file zero-padded path — the gate is strictly greater-than', async () => {
      // Arrange — git's own `size > big_file_threshold` comparison (pinned
      // against git 2.55.0): the threshold value itself stays small-file.
      const ctx = createMemoryContext();
      const id = 'g'.repeat(40) as ObjectId;
      const body = ENCODER.encode('SHORT');
      const threshold = 1024;
      await writeLooseAtId(ctx, id, 'blob', threshold, body);
      const expectedActual = await ctx.hash.hashHex(
        buildTree(
          ENCODER.encode(`blob ${threshold}\0`),
          body,
          new Uint8Array(threshold - body.byteLength),
        ),
      );

      // Act
      const result = await sut(
        ctx,
        new Set([id]),
        false,
        new Map(),
        new Map(),
        NO_SKIPS,
        threshold,
      );

      // Assert
      const mismatch = result.findings.find((f) => f.type === 'hash-mismatch');
      expect(mismatch).toMatchObject({ id, actual: expectedActual });
      // Assert — git's read_loose_object returns on the mismatch before
      // typing the object, so the reachability pass must not type it either.
      expect(result.typeUnknownIds.has(id)).toBe(true);
    });
  });
});

describe('Given a loose blob whose declared size exceeds core.bigFileThreshold and overran its claim inside the header window', () => {
  describe('When runContentValidationPass validates that object', () => {
    it("Then emits a bad-object finding, never hash-mismatch — git's check_stream_oid refuses the over-run as corrupt", async () => {
      // Arrange — declared 5 past a 1-byte threshold, body overruns to 8
      // bytes while staying inside the 32-byte header window: git's
      // `check_stream_oid` gates on the threshold for a blob regardless of
      // body length, and an over-run there is corrupt, not truncated.
      const ctx = createMemoryContext();
      const id = 'j'.repeat(40) as ObjectId;
      const body = ENCODER.encode('abcdefgh');
      const threshold = 1;
      await writeLooseAtId(ctx, id, 'blob', 5, body);

      // Act
      const result = await sut(
        ctx,
        new Set([id]),
        false,
        new Map(),
        new Map(),
        NO_SKIPS,
        threshold,
      );

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
      // Assert — git's check_stream_oid refusal denies its reachability
      // graph the type too: this id must not be typed, so a real referrer
      // to it is left `missing`, never `dangling`/`unreachable`.
      expect(result.typeUnknownIds.has(id)).toBe(true);
    });
  });
});

describe('Given a loose blob whose declared size sits exactly AT core.bigFileThreshold and overran its claim inside the header window', () => {
  describe('When runContentValidationPass validates that object', () => {
    it('Then still takes the small-file truncated-prefix path — the gate is strictly greater-than', async () => {
      // Arrange — git's own `size > big_file_threshold` comparison stays
      // small-file at the threshold value itself, same as the underrun gate.
      const ctx = createMemoryContext();
      const id = 'k'.repeat(40) as ObjectId;
      const body = ENCODER.encode('HELLOWORLD');
      const threshold = 6;
      await writeLooseAtId(ctx, id, 'blob', threshold, body);
      const expectedActual = await ctx.hash.hashHex(
        buildTree(ENCODER.encode(`blob ${threshold}\0`), body.subarray(0, threshold)),
      );

      // Act
      const result = await sut(
        ctx,
        new Set([id]),
        false,
        new Map(),
        new Map(),
        NO_SKIPS,
        threshold,
      );

      // Assert
      const mismatch = result.findings.find((f) => f.type === 'hash-mismatch');
      expect(mismatch).toMatchObject({ id, actual: expectedActual });
      expect(result.findings.some((f) => f.type === 'bad-object')).toBe(false);
      // Assert — git's read_loose_object returns on the mismatch before
      // typing the object, so the reachability pass must not type it either.
      expect(result.typeUnknownIds.has(id)).toBe(true);
    });
  });
});

describe('Given a loose blob past core.bigFileThreshold whose claim ALSO exceeds the inflate ceiling', () => {
  describe('When runContentValidationPass validates that object', () => {
    it('Then still hashes cheaply (no bad-object refusal) — the big-file gate never pays the padding cost the ceiling exists to bound', async () => {
      // Arrange — a claim far past MAX_INFLATE_OUTPUT_BYTES, but ALSO past
      // a threshold of 0: real git streams a claim this size exactly as
      // readily as a small one, so the ceiling this same claim trips on the
      // small-file path must never fire here.
      const ctx = createMemoryContext();
      const id = 'h'.repeat(40) as ObjectId;
      const body = ENCODER.encode('X');
      const claim = MAX_INFLATE_OUTPUT_BYTES + 1000;
      await writeLooseAtId(ctx, id, 'blob', claim, body);
      const expectedActual = await ctx.hash.hashHex(
        buildTree(ENCODER.encode(`blob ${claim}\0`), body),
      );

      // Act
      const result = await sut(ctx, new Set([id]), false, new Map(), new Map(), NO_SKIPS, 0);

      // Assert
      const mismatch = result.findings.find((f) => f.type === 'hash-mismatch');
      expect(mismatch).toMatchObject({ id, actual: expectedActual });
      expect(result.findings.some((f) => f.type === 'bad-object')).toBe(false);
      // Assert — git's read_loose_object returns on the mismatch before
      // typing the object, so the reachability pass must not type it either.
      expect(result.typeUnknownIds.has(id)).toBe(true);
    });
  });
});

describe('Given a loose commit whose declared size exceeds core.bigFileThreshold and under-ran its claim', () => {
  describe('When runContentValidationPass validates that object', () => {
    it('Then still takes the zero-padded path — the threshold gates blobs only', async () => {
      // Arrange — git's type check on the big-file streaming arm is blob
      // only; a commit past the SAME threshold still zero-pads.
      const ctx = createMemoryContext();
      const id = 'i'.repeat(40) as ObjectId;
      const body = ENCODER.encode(
        `tree ${'0'.repeat(40)}\nauthor A <a@a.com> 0 +0000\ncommitter A <a@a.com> 0 +0000\n\nmsg\n`,
      );
      const threshold = 1;
      const claim = body.byteLength + 10;
      await writeLooseAtId(ctx, id, 'commit', claim, body);
      const expectedActual = await ctx.hash.hashHex(
        buildTree(ENCODER.encode(`commit ${claim}\0`), body, new Uint8Array(10)),
      );

      // Act
      const result = await sut(
        ctx,
        new Set([id]),
        false,
        new Map(),
        new Map(),
        NO_SKIPS,
        threshold,
      );

      // Assert
      const mismatch = result.findings.find((f) => f.type === 'hash-mismatch');
      expect(mismatch).toMatchObject({ id, actual: expectedActual });
      // Assert — git's read_loose_object returns on the mismatch before
      // typing the object, so the reachability pass must not type it either.
      expect(result.typeUnknownIds.has(id)).toBe(true);
    });
  });
});

const VALID_COMMIT_BODY = ENCODER.encode(
  `tree ${'0'.repeat(40)}\nauthor A <a@a.com> 0 +0000\ncommitter A <a@a.com> 0 +0000\n\nmsg\n`,
);
const VALID_TAG_BODY = ENCODER.encode(
  `object ${'0'.repeat(40)}\ntype commit\ntag t\ntagger A <a@a.com> 0 +0000\n\nmsg\n`,
);
const VALID_TREE_BODY = buildTree(buildTreeEntry('100644', 'file.txt', BLOB_SHA_A));

describe.each([
  { label: 'commit', type: 'commit', body: VALID_COMMIT_BODY },
  { label: 'tree', type: 'tree', body: VALID_TREE_BODY },
  { label: 'tag', type: 'tag', body: VALID_TAG_BODY },
])('Given a loose $label whose body under-ran its claim', ({ type, body }) => {
  describe('When runContentValidationPass validates that object', () => {
    it("Then emits a hash-mismatch finding whose actual is git's zero-padded SHA-1, not a bad-object finding", async () => {
      // Arrange — git's buffered tier has no type check: a commit/tree/tag
      // under-run takes the SAME zero-padded hash path as a blob, unlike an
      // over-run (which still refuses).
      const ctx = createMemoryContext();
      const id = 'b'.repeat(40) as ObjectId;
      const claim = body.byteLength + 10;
      await writeLooseAtId(ctx, id, type, claim, body);
      const expectedActual = await ctx.hash.hashHex(
        buildTree(ENCODER.encode(`${type} ${claim}\0`), body, new Uint8Array(10)),
      );

      // Act
      const result = await sut(
        ctx,
        new Set([id]),
        false,
        new Map(),
        new Map(),
        NO_SKIPS,
        DEFAULT_THRESHOLD,
      );

      // Assert
      const mismatch = result.findings.find((f) => f.type === 'hash-mismatch');
      expect(mismatch).toMatchObject({ id, actual: expectedActual });
      expect(result.findings.some((f) => f.type === 'bad-object')).toBe(false);
      // Assert — git's read_loose_object returns on the mismatch before
      // typing the object, so the reachability pass must not type it either.
      expect(result.typeUnknownIds.has(id)).toBe(true);
    });
  });
});

describe.each([
  { label: 'commit', type: 'commit' },
  { label: 'tree', type: 'tree' },
  { label: 'tag', type: 'tag' },
])(
  "Given a loose $label whose body overran its claim inside git's 32-byte header window",
  ({ type }) => {
    describe('When runContentValidationPass validates that object', () => {
      it('Then emits a hash-mismatch finding whose actual is SHA-1 of the header plus the truncated claim, not a bad-object finding', async () => {
        // Arrange — header + a 10-byte body stays inside the window; git's
        // buffered tier has no type check, so a commit/tree/tag over-run
        // truncates to the claim and hashes the prefix exactly as a blob does.
        const ctx = createMemoryContext();
        const id = 'c'.repeat(40) as ObjectId;
        const body = ENCODER.encode('HELLOWORLD');
        await writeLooseAtId(ctx, id, type, 6, body);
        const expectedActual = await ctx.hash.hashHex(
          buildTree(ENCODER.encode(`${type} 6\0`), body.subarray(0, 6)),
        );

        // Act
        const result = await sut(
          ctx,
          new Set([id]),
          false,
          new Map(),
          new Map(),
          NO_SKIPS,
          DEFAULT_THRESHOLD,
        );

        // Assert
        const mismatch = result.findings.find((f) => f.type === 'hash-mismatch');
        expect(mismatch).toMatchObject({ id, actual: expectedActual });
        expect(result.findings.some((f) => f.type === 'bad-object')).toBe(false);
        // Assert — git's read_loose_object returns on the mismatch before
        // typing the object, so the reachability pass must not type it either.
        expect(result.typeUnknownIds.has(id)).toBe(true);
      });
    });
  },
);

describe("Given a loose commit whose body overran its claim past git's 32-byte header window", () => {
  describe('When runContentValidationPass validates that object', () => {
    it('Then still emits a bad-object finding — only an overrun fitting the window truncates', async () => {
      // Arrange — header (9 bytes) + a 40-byte body sits past the 32-byte
      // window, so the buffered read refuses rather than truncating,
      // regardless of type.
      const ctx = createMemoryContext();
      const id = 'c'.repeat(40) as ObjectId;
      const body = ENCODER.encode('x'.repeat(40));
      await writeLooseAtId(ctx, id, 'commit', 6, body);

      // Act
      const result = await sut(
        ctx,
        new Set([id]),
        false,
        new Map(),
        new Map(),
        NO_SKIPS,
        DEFAULT_THRESHOLD,
      );

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
      // Assert — also fails readObject's own read (same inflate call), so
      // the general resolver never disagrees; no override is needed.
      expect(result.typeUnknownIds.has(id)).toBe(false);
    });
  });
});

describe('Given a loose blob whose under-run claim exceeds the inflate ceiling', () => {
  describe('When runContentValidationPass validates that object', () => {
    it('Then emits a bad-object finding instead of hashing gigabytes of padding', async () => {
      // Arrange — a claim past MAX_INFLATE_OUTPUT_BYTES over a tiny real
      // body: the residual would be gigabytes of zero padding. The
      // configured threshold sits ABOVE the claim too, so this row still
      // exercises the small-file (zero-pad) path's own ceiling refusal,
      // never the big-file gate this same claim would otherwise trip.
      const ctx = createMemoryContext();
      const id = 'c'.repeat(40) as ObjectId;
      const body = ENCODER.encode('SHORT');
      const claim = MAX_INFLATE_OUTPUT_BYTES + 1;
      await writeLooseAtId(ctx, id, 'blob', claim, body);

      // Act
      const result = await sut(
        ctx,
        new Set([id]),
        false,
        new Map(),
        new Map(),
        NO_SKIPS,
        claim + 1,
      );

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
      // Assert — tsgit's own safety ceiling, not a git-faithfulness gate:
      // out of scope for the reachability-typing fix, left untyped as false.
      expect(result.typeUnknownIds.has(id)).toBe(false);
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
      const result = await sut(
        ctx,
        new Set([id]),
        false,
        new Map(),
        new Map(),
        NO_SKIPS,
        DEFAULT_THRESHOLD,
      );

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
      // Assert — also fails readObject's own read (same inflate call), so
      // the general resolver never disagrees; no override is needed.
      expect(result.typeUnknownIds.has(id)).toBe(false);
    });
  });
});

describe('Given a loose commit whose header claims more than its real body, and whose truncated content would also fail the catalogue', () => {
  describe('When runContentValidationPass validates that object', () => {
    it('Then emits only a hash-mismatch finding, never a bad-object catalogue finding', async () => {
      // Arrange — git's `read_loose_object` returns before `fsck_obj` ever
      // runs when the hash disagrees with the path: an 8-byte body under a
      // 20-byte claim (missing even a "tree " line) would fail the catalogue
      // (missingTree) if it ran, but real git never reaches it.
      const ctx = createMemoryContext();
      const id = 'c'.repeat(40) as ObjectId;
      const body = ENCODER.encode('abcdefgh');
      await writeLooseAtId(ctx, id, 'commit', 20, body);

      // Act
      const result = await sut(
        ctx,
        new Set([id]),
        false,
        new Map(),
        new Map(),
        NO_SKIPS,
        DEFAULT_THRESHOLD,
      );

      // Assert
      expect(result.findings).toHaveLength(1);
      expect(result.findings[0]?.type).toBe('hash-mismatch');
      // Assert — git's read_loose_object returns on the mismatch before
      // typing the object, so the reachability pass must not type it either.
      expect(result.typeUnknownIds.has(id)).toBe(true);
    });
  });
});

describe('Given a correctly-sized loose commit stored at the wrong path, whose content would also fail the catalogue', () => {
  describe('When runContentValidationPass validates that object', () => {
    it('Then emits only a hash-mismatch finding, never a bad-object catalogue finding', async () => {
      // Arrange — the claim matches the body's real length (the 'honest'
      // verdict), but the id is an arbitrary path, not this body's own
      // hash; the body itself is missing a "tree " line (missingTree).
      const ctx = createMemoryContext();
      const id = 'd'.repeat(40) as ObjectId;
      const body = ENCODER.encode(
        'author A <a@a.com> 0 +0000\ncommitter A <a@a.com> 0 +0000\n\nmsg\n',
      );
      await writeLooseAtId(ctx, id, 'commit', body.byteLength, body);

      // Act
      const result = await sut(
        ctx,
        new Set([id]),
        false,
        new Map(),
        new Map(),
        NO_SKIPS,
        DEFAULT_THRESHOLD,
      );

      // Assert
      expect(result.findings).toHaveLength(1);
      expect(result.findings[0]?.type).toBe('hash-mismatch');
      // Assert — git's read_loose_object returns on the mismatch before
      // typing the object, so the reachability pass must not type it either.
      expect(result.typeUnknownIds.has(id)).toBe(true);
    });
  });
});

describe('Given a packed tree with duplicateEntries whose bytes are ALSO indexed under the wrong id', () => {
  describe('When runContentValidationPass validates that object', () => {
    it('Then still emits BOTH the catalogue finding and the hash-mismatch — packed reads carry no path to gate on', async () => {
      // Arrange — unlike loose, a packed object's hash check has no
      // "read_loose_object returns early" analogue: git walks every packed
      // object by offset and always runs the catalogue on it.
      const treeBody = buildTree(
        buildTreeEntry('100644', 'a.txt', BLOB_SHA_A),
        buildTreeEntry('100644', 'a.txt', BLOB_SHA_B),
      );
      const wrongId = '0000000000000000000000000000000000000009' as ObjectId;
      const ctx = createMemoryContext();
      const ids = await writeSyntheticPack(ctx, 'p-wrong-id', [
        { kind: 'base', type: 'tree', content: treeBody, idOverride: wrongId },
      ]);
      const treeId = ids[0] as ObjectId;

      // Act
      const result = await sut(
        ctx,
        new Set([treeId]),
        false,
        new Map(),
        new Map(),
        NO_SKIPS,
        DEFAULT_THRESHOLD,
      );

      // Assert
      const msgIds = result.findings
        .filter((f) => f.type === 'bad-object' && f.id === treeId)
        .map((f) => (f.type === 'bad-object' ? f.msgId : undefined));
      expect(msgIds).toContain('duplicateEntries');
      expect(result.findings.some((f) => f.type === 'hash-mismatch' && f.id === treeId)).toBe(true);
    });
  });
});

describe('Given a loose object whose compressed bytes are not valid zlib', () => {
  describe('When runContentValidationPass validates that object', () => {
    it('Then emits a bad-object finding via the zlib-failure path, not the header-parse path, and leaves typeUnknownIds empty', async () => {
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
      const result = await sut(
        ctx,
        new Set([id]),
        false,
        new Map(),
        new Map(),
        NO_SKIPS,
        DEFAULT_THRESHOLD,
      );

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
      // Assert — also fails readObject's own read (same inflate call), so
      // the general resolver never disagrees; no override is needed.
      expect(result.typeUnknownIds.has(id)).toBe(false);
    });
  });
});
