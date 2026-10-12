import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../../../src/adapters/memory/memory-adapter.js';
import {
  type CatalogueOptions,
  runContentValidationPass,
} from '../../../../../../src/application/commands/internal/fsck/content-validation.js';
import { createSpecialBlobLedger } from '../../../../../../src/application/commands/internal/fsck/special-blobs.js';
import { DEFAULT_BIG_FILE_THRESHOLD_BYTES } from '../../../../../../src/application/primitives/internal/big-file-threshold.js';
import {
  looseObjectPath,
  objectsDir,
} from '../../../../../../src/application/primitives/path-layout.js';
import { SHA1_CONFIG } from '../../../../../../src/domain/objects/hash-config.js';
import type { ObjectId } from '../../../../../../src/domain/objects/index.js';
import { MAX_INFLATE_OUTPUT_BYTES } from '../../../../../../src/ports/compressor.js';
import { writeSyntheticPack } from '../../../primitives/pack-fixture.js';

const sut = runContentValidationPass;

/** No `fsck.skipList` configured. */
const NO_SKIPS: ReadonlySet<string> = new Set();

/** git's own `core.bigFileThreshold` default — every row that does not exist
 *  to exercise the big-file gate itself uses this, so it never fires. */
const DEFAULT_THRESHOLD = DEFAULT_BIG_FILE_THRESHOLD_BYTES;

const catalogueWith = (overrides: Partial<CatalogueOptions> = {}): CatalogueOptions => ({
  strict: false,
  specialBlobs: createSpecialBlobLedger(SHA1_CONFIG),
  severities: new Map(),
  skipped: NO_SKIPS,
  bigFileThreshold: DEFAULT_THRESHOLD,
  ...overrides,
});

const BLOB_SHA_A = new Uint8Array(20).fill(1);
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
      const result = await sut(ctx, new Set([unreadableId]), catalogueWith());

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

describe('Given an object only a pack holds, its entry damaged', () => {
  describe('When runContentValidationPass validates that object', () => {
    it('Then it leaves the entry to verify_pack: no finding, no bit', async () => {
      // Arrange
      const ctx = createMemoryContext();
      const [blobId] = await writeSyntheticPack(ctx, 'p5', [
        { kind: 'base', type: 'blob', content: ENCODER.encode('packed only') },
      ]);
      const packPath = `${ctx.layout.gitDir}/objects/pack/pack-p5.pack`;
      const pack = await ctx.fs.read(packPath);
      pack[pack.length - 24] = pack[pack.length - 24]! ^ 0xff;
      await ctx.fs.write(packPath, pack);

      // Act
      const result = await sut(ctx, new Set([blobId as ObjectId]), catalogueWith());

      // Assert
      expect(result.findings).toEqual([]);
      expect(result.exitBit).toBe(0);
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
      const result = await sut(ctx, new Set([blobId]), catalogueWith());

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
      const result = await sut(ctx, new Set([id]), catalogueWith());

      // Assert
      const hashMismatchFindings = result.findings.filter((f) => f.type === 'hash-mismatch');
      expect(hashMismatchFindings).toHaveLength(1);
      expect(result.typeUnknownIds.has(id)).toBe(true);
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
        catalogueWith({ severities: severities }),
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
      const result = await sut(ctx, new Set([id]), catalogueWith());

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
      const result = await sut(ctx, new Set([id]), catalogueWith());

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
      const result = await sut(ctx, new Set([id]), catalogueWith({ bigFileThreshold: threshold }));

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
      const result = await sut(ctx, new Set([id]), catalogueWith({ bigFileThreshold: threshold }));

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
      const result = await sut(ctx, new Set([id]), catalogueWith({ bigFileThreshold: threshold }));

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
      const result = await sut(ctx, new Set([id]), catalogueWith({ bigFileThreshold: threshold }));

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
      const result = await sut(ctx, new Set([id]), catalogueWith({ bigFileThreshold: 0 }));

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
      const result = await sut(ctx, new Set([id]), catalogueWith({ bigFileThreshold: threshold }));

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
      const result = await sut(ctx, new Set([id]), catalogueWith());

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
        const result = await sut(ctx, new Set([id]), catalogueWith());

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
      const result = await sut(ctx, new Set([id]), catalogueWith());

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
      const result = await sut(ctx, new Set([id]), catalogueWith({ bigFileThreshold: claim + 1 }));

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

describe('Given a loose blob whose under-run claim exactly equals the inflate ceiling', () => {
  describe('When runContentValidationPass validates that object', () => {
    it('Then emits a bad-object finding instead of hashing the ceiling worth of padding', async () => {
      // Arrange — the boundary itself is "gigabytes of padding" too, so the
      // ceiling refuses it inclusively rather than padding exactly up to it.
      const ctx = createMemoryContext();
      const id = 'e'.repeat(40) as ObjectId;
      const body = ENCODER.encode('SHORT');
      const claim = MAX_INFLATE_OUTPUT_BYTES;
      await writeLooseAtId(ctx, id, 'blob', claim, body);

      // Act
      const result = await sut(ctx, new Set([id]), catalogueWith({ bigFileThreshold: claim + 1 }));

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
      const result = await sut(ctx, new Set([id]), catalogueWith());

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
      const result = await sut(ctx, new Set([id]), catalogueWith());

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
      const result = await sut(ctx, new Set([id]), catalogueWith());

      // Assert
      expect(result.findings).toHaveLength(1);
      expect(result.findings[0]?.type).toBe('hash-mismatch');
      // Assert — git's read_loose_object returns on the mismatch before
      // typing the object, so the reachability pass must not type it either.
      expect(result.typeUnknownIds.has(id)).toBe(true);
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
      const result = await sut(ctx, new Set([id]), catalogueWith());

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

const DONOR_OBJECTS = '/repo/donor/objects';

const borrowerContext = async (): Promise<ReturnType<typeof createMemoryContext>> => {
  const ctx = createMemoryContext({
    files: { '/repo/.git/objects/info/alternates': ENCODER.encode(`${DONOR_OBJECTS}\n`) },
  });
  await ctx.fs.mkdir(DONOR_OBJECTS);
  return ctx;
};

/** Write a loose object at `id` into the donor's object directory. */
async function writeDonorLooseAtId(
  ctx: ReturnType<typeof createMemoryContext>,
  id: ObjectId,
  type: string,
  body: Uint8Array,
): Promise<void> {
  const raw = buildTree(ENCODER.encode(`${type} ${body.length}\0`), body);
  await ctx.fs.mkdir(`${DONOR_OBJECTS}/${id.slice(0, 2)}`);
  await ctx.fs.write(
    `${DONOR_OBJECTS}/${id.slice(0, 2)}/${id.slice(2)}`,
    await ctx.compressor.deflate(raw),
  );
}

const idOf = async (
  ctx: ReturnType<typeof createMemoryContext>,
  type: string,
  body: Uint8Array,
): Promise<ObjectId> =>
  (await ctx.hash.hashHex(buildTree(ENCODER.encode(`${type} ${body.length}\0`), body))) as ObjectId;

describe('Given a borrower whose own loose copy is healthy and whose donor loose copy hashes elsewhere', () => {
  describe('When runContentValidationPass validates that object', () => {
    it('Then the donor copy reports its own hash mismatch, attributed to the donor', async () => {
      // Arrange
      const ctx = await borrowerContext();
      const body = ENCODER.encode('healthy');
      const id = await idOf(ctx, 'blob', body);
      await writeLooseAtId(ctx, id, 'blob', body.length, body);
      const other = ENCODER.encode('other');
      await writeDonorLooseAtId(ctx, id, 'blob', other);

      // Act
      const result = await sut(ctx, new Set([id]), catalogueWith());

      // Assert
      expect(result.findings).toEqual([
        {
          type: 'hash-mismatch',
          id,
          actual: await idOf(ctx, 'blob', other),
          objectsDir: DONOR_OBJECTS,
        },
      ]);
      expect(result.exitBit).toBe(1);
      expect(result.typeUnknownIds.has(id)).toBe(false);
    });
  });
});

describe('Given a borrower and its donor each holding a loose copy of one zero-padded tree', () => {
  describe('When runContentValidationPass validates that object', () => {
    it('Then each copy reports the warning once', async () => {
      // Arrange
      const ctx = await borrowerContext();
      const body = buildTree(buildTreeEntry('0100644', 'f', BLOB_SHA_A));
      const id = await idOf(ctx, 'tree', body);
      await writeLooseAtId(ctx, id, 'tree', body.length, body);
      await writeDonorLooseAtId(ctx, id, 'tree', body);
      const warning = {
        type: 'bad-object',
        id,
        objectType: 'tree',
        msgId: 'zeroPaddedFilemode',
        severity: 'warning',
      };

      // Act
      const result = await sut(ctx, new Set([id]), catalogueWith());

      // Assert
      expect(result.findings).toEqual([warning, { ...warning, objectsDir: DONOR_OBJECTS }]);
      expect(result.exitBit).toBe(0);
    });
  });
});

describe('Given a borrower and its donor each holding a loose copy that hashes elsewhere', () => {
  describe('When runContentValidationPass validates that object', () => {
    it('Then both copies report and the id is unreadable for reachability', async () => {
      // Arrange
      const ctx = await borrowerContext();
      const id = 'd'.repeat(40) as ObjectId;
      const body = ENCODER.encode('nowhere');
      await writeLooseAtId(ctx, id, 'blob', body.length, body);
      await writeDonorLooseAtId(ctx, id, 'blob', body);

      // Act
      const result = await sut(ctx, new Set([id]), catalogueWith());

      // Assert
      expect(result.findings.filter((finding) => finding.type === 'hash-mismatch')).toHaveLength(2);
      expect(result.typeUnknownIds.has(id)).toBe(true);
    });
  });
});
