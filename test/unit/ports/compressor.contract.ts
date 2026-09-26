import { randomBytes } from 'node:crypto';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { TsgitError } from '../../../src/domain/index.js';
import type { Compressor } from '../../../src/ports/compressor.js';

const HEAD_PROPERTY_NUM_RUNS = 50;
const HEAD_PROPERTY_MAX_PAYLOAD_BYTES = 4096;
const HEAD_PROPERTY_MAX_BOUND = 256;

export function compressorContractTests(createSut: () => Promise<Compressor>): void {
  describe('Compressor contract', () => {
    it('Given data, When deflate then inflate, Then roundtrips', async () => {
      const sut = await createSut();
      const data = new TextEncoder().encode('hello world');
      const deflated = await sut.deflate(data);
      const inflated = await sut.inflate(deflated);
      expect(inflated).toEqual(data);
    });

    it('Given empty data, When deflate then inflate, Then roundtrips', async () => {
      const sut = await createSut();
      const deflated = await sut.deflate(new Uint8Array());
      const inflated = await sut.inflate(deflated);
      expect(inflated).toEqual(new Uint8Array());
    });

    it('Given large data (64KB), When deflate then inflate, Then roundtrips', async () => {
      const sut = await createSut();
      const data = new Uint8Array(64 * 1024);
      for (let i = 0; i < data.length; i++) data[i] = i % 256;
      const deflated = await sut.deflate(data);
      const inflated = await sut.inflate(deflated);
      expect(inflated).toEqual(data);
    });

    it('Given corrupt data, When inflate, Then throws DECOMPRESS_FAILED', async () => {
      const sut = await createSut();
      try {
        await sut.inflate(new Uint8Array([0xff, 0xff, 0xff, 0xff]));
        expect.fail('expected DECOMPRESS_FAILED');
      } catch (err) {
        expect(err).toBeInstanceOf(TsgitError);
        expect((err as TsgitError).data.code).toBe('DECOMPRESS_FAILED');
      }
    });

    it('Given a concatenation of two zlib streams, When streamInflate at offset 0, Then returns only the first stream and reports bytesConsumed', async () => {
      const sut = await createSut();
      const first = new TextEncoder().encode('first stream');
      const second = new TextEncoder().encode('second stream payload');
      const defFirst = await sut.deflate(first);
      const defSecond = await sut.deflate(second);
      const combined = new Uint8Array(defFirst.length + defSecond.length);
      combined.set(defFirst, 0);
      combined.set(defSecond, defFirst.length);

      const r1 = await sut.streamInflate(combined, 0);
      expect(r1.output).toEqual(first);
      expect(r1.bytesConsumed).toBe(defFirst.length);

      const r2 = await sut.streamInflate(combined, r1.bytesConsumed);
      expect(r2.output).toEqual(second);
      expect(r2.bytesConsumed).toBe(defSecond.length);
    });

    it('Given a member whose compressed form exceeds 64 KiB, When streamInflate, Then returns exact output and bytesConsumed', async () => {
      const sut = await createSut();
      // Random data is poorly compressible, so deflating 100 KiB of it yields
      // a compressed member past the old 64 KiB memory-adapter cap.
      const data = new Uint8Array(randomBytes(100 * 1024));
      const deflated = await sut.deflate(data);
      expect(deflated.length).toBeGreaterThan(64 * 1024);
      const second = new TextEncoder().encode('second stream trailing a large member');
      const defSecond = await sut.deflate(second);
      const combined = new Uint8Array(deflated.length + defSecond.length);
      combined.set(deflated, 0);
      combined.set(defSecond, deflated.length);

      const r1 = await sut.streamInflate(combined, 0);
      expect(Array.from(r1.output)).toEqual(Array.from(data));
      expect(r1.bytesConsumed).toBe(deflated.length);

      const r2 = await sut.streamInflate(combined, r1.bytesConsumed);
      expect(r2.output).toEqual(second);
      expect(r2.bytesConsumed).toBe(defSecond.length);
    });

    it('Given no valid zlib stream, When streamInflate is called, Then throws DECOMPRESS_FAILED', async () => {
      const sut = await createSut();
      const junk = new Uint8Array([0xff, 0xfe, 0xfd, 0xfc, 0xfb]);
      try {
        await sut.streamInflate(junk, 0);
        expect.fail('expected DECOMPRESS_FAILED');
      } catch (err) {
        expect(err).toBeInstanceOf(TsgitError);
        expect((err as TsgitError).data.code).toBe('DECOMPRESS_FAILED');
      }
    });

    it('Given data, When inflating via createInflateStream, Then produces same result as inflate', async () => {
      const sut = await createSut();
      const data = new TextEncoder().encode('streaming test content that is long enough to matter');
      const deflated = await sut.deflate(data);

      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(deflated);
          controller.close();
        },
      });
      const transformed = stream.pipeThrough(sut.createInflateStream());
      const reader = transformed.getReader();
      const chunks: Uint8Array[] = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }
      const total = chunks.reduce((sum, c) => sum + c.length, 0);
      const result = new Uint8Array(total);
      let offset = 0;
      for (const c of chunks) {
        result.set(c, offset);
        offset += c.length;
      }
      expect(result).toEqual(data);
    });

    it('Given data, When deflateRaw then raw-inflate, Then roundtrips (hello world)', async () => {
      // Arrange
      const sut = await createSut();
      const data = new TextEncoder().encode('hello world');

      // Act
      const compressed = await sut.deflateRaw(data);
      const result = await rawInflate(compressed);

      // Assert
      expect(result).toEqual(data);
    });

    it('Given empty data, When deflateRaw then raw-inflate, Then roundtrips', async () => {
      // Arrange
      const sut = await createSut();
      const data = new Uint8Array(0);

      // Act
      const compressed = await sut.deflateRaw(data);
      const result = await rawInflate(compressed);

      // Assert
      expect(result).toEqual(data);
    });

    it('Given large data (64KB), When deflateRaw then raw-inflate, Then roundtrips', async () => {
      // Arrange
      const sut = await createSut();
      const data = new Uint8Array(64 * 1024);
      for (let i = 0; i < data.length; i++) data[i] = i % 256;

      // Act
      const compressed = await sut.deflateRaw(data);
      const result = await rawInflate(compressed);

      // Assert
      expect(result).toEqual(data);
    });

    it('Given a stream whose output exceeds a caller-supplied bound smaller than the adapter default, When streamInflate is called with that bound, Then it rejects with DECOMPRESS_FAILED', async () => {
      const sut = await createSut();
      const payload = new TextEncoder().encode('this payload is longer than the tiny bound');
      const deflated = await sut.deflate(payload);

      try {
        await sut.streamInflate(deflated, 0, 4);
        expect.fail('expected DECOMPRESS_FAILED');
      } catch (err) {
        expect(err).toBeInstanceOf(TsgitError);
        expect((err as TsgitError).data.code).toBe('DECOMPRESS_FAILED');
      }
    });

    it('Given a stream whose output is within a caller-supplied bound, When streamInflate is called with that bound, Then it succeeds', async () => {
      const sut = await createSut();
      const payload = new TextEncoder().encode('short');
      const deflated = await sut.deflate(payload);

      const result = await sut.streamInflate(deflated, 0, payload.length);

      expect(result.output).toEqual(payload);
    });

    it('Given a zlib member whose oversized first block alone exceeds a caller-supplied bound, When streamInflate is called with that bound, Then it rejects on the cap before ever reaching the corrupted block that follows', async () => {
      // Arrange — a hand-built (not adapter-produced) member: one oversized
      // STORED block of live zero bytes, immediately followed by a corrupted
      // block header (BTYPE=3, reserved by RFC 1951 -- always invalid). This
      // is a STRUCTURAL oracle, not a timing one: an implementation that
      // checks the output cap incrementally never gets past the first block
      // — it throws the safety-cap reason before the corrupted second block
      // is ever read. An implementation that inflates fully and only then
      // compares `output.length` keeps decoding into the corrupted block and
      // throws a DIFFERENT, format-level reason instead — deterministically
      // distinguishing the two, no clock involved.
      const sut = await createSut();
      // Past Node's default zlib chunkSize (16 KiB), so a real streaming
      // decoder flushes output from this block alone before it even finishes.
      const literalByteCount = 20_000;
      const bound = 100;
      const bytes = buildOverCapStoredZlibMember(literalByteCount);

      // Act
      let caught: unknown;
      try {
        await sut.streamInflate(bytes, 0, bound);
      } catch (err) {
        caught = err;
      }

      // Assert
      expect(caught).toBeInstanceOf(TsgitError);
      const data = (caught as TsgitError).data;
      if (data.code !== 'DECOMPRESS_FAILED') {
        expect.fail(`expected DECOMPRESS_FAILED, got ${data.code}`);
      }
      expect(data.reason).toContain('exceeds safety cap');
    });

    it('Given data whose inflated output exceeds a caller-supplied bound, When inflate is called with that bound, Then it rejects with DECOMPRESS_FAILED and the cap reason', async () => {
      // Arrange — highly compressible so the deflated form is tiny while the
      // inflated output (64 KiB) comfortably exceeds the 1024-byte bound.
      const sut = await createSut();
      const data = new Uint8Array(64 * 1024).fill(0x41);
      const deflated = await sut.deflate(data);

      // Act
      let caught: unknown;
      try {
        await sut.inflate(deflated, 1024);
      } catch (err) {
        caught = err;
      }

      // Assert
      expect(caught).toBeInstanceOf(TsgitError);
      const errData = (caught as TsgitError).data;
      expect(errData.code).toBe('DECOMPRESS_FAILED');
      if (errData.code === 'DECOMPRESS_FAILED') {
        expect(errData.reason).toBe('inflated output exceeds safety cap');
      }
    });

    it('Given data whose inflated output exactly equals a caller-supplied bound, When inflate is called with that bound, Then it returns the whole output (boundary is not exceeded)', async () => {
      // Arrange
      const sut = await createSut();
      const data = new TextEncoder().encode('exact bound payload');
      const deflated = await sut.deflate(data);

      // Act
      const result = await sut.inflate(deflated, data.length);

      // Assert
      expect(result).toEqual(data);
    });

    it('Given a stream whose whole output fits under the head bound, When inflateHead is called with a larger bound, Then it returns the whole output, not padded to the bound', async () => {
      // Arrange
      const sut = await createSut();
      const data = new Uint8Array(20).fill(0x41);
      const deflated = await sut.deflate(data);

      // Act
      const result = await sut.inflateHead(deflated, 33);

      // Assert
      expect(result).toEqual(data);
    });

    it('Given a stream whose output is truncated inside a raw stored block, When inflateHead is called with a bound inside that block, Then it returns exactly the truncated leading bytes', async () => {
      // Arrange — reuses the hand-built stored-block member below (bypasses
      // any adapter's own deflate, so its block layout is pinned): the bound
      // lands inside the single STORED block's live bytes, well before the
      // corrupted trailing header the same member also carries.
      const sut = await createSut();
      const literalByteCount = 40;
      const bound = 10;
      const member = buildOverCapStoredZlibMember(literalByteCount);

      // Act
      const result = await sut.inflateHead(member, bound);

      // Assert
      expect(result).toEqual(new Uint8Array(bound));
    });

    it('Given a stream whose output is truncated inside a SECOND raw stored block, When inflateHead is called with a bound past the whole first block, Then it returns exactly the truncated leading bytes', async () => {
      // Arrange — a first stored block short enough to be written in full
      // (unclamped) before a second, longer one absorbs the truncation.
      const sut = await createSut();
      const firstBlockByteCount = 20;
      const secondBlockByteCount = 40;
      const member = buildTwoStoredBlocksZlibMember(firstBlockByteCount, secondBlockByteCount);
      const bound = firstBlockByteCount + 5;

      // Act
      const result = await sut.inflateHead(member, bound);

      // Assert
      expect(result).toEqual(new Uint8Array(bound));
    });

    it('Given a stream whose output is truncated inside a long-distance back-reference match, When inflateHead is called with a bound inside that match, Then it returns exactly the truncated leading bytes', async () => {
      // Arrange — the trailing "abcdefghij" repeats the leading one 510
      // bytes back, so deflate encodes it as a single back-reference whose
      // distance (510) is well past the head bound's remaining room —
      // exercising the truncating buffer's non-overlapping copy path.
      const sut = await createSut();
      const prefix = new TextEncoder().encode('abcdefghij');
      const filler = new TextEncoder().encode('0123456789'.repeat(50));
      const data = new Uint8Array(prefix.length + filler.length + prefix.length);
      data.set(prefix, 0);
      data.set(filler, prefix.length);
      data.set(prefix, prefix.length + filler.length);
      const deflated = await sut.deflate(data);
      const bound = prefix.length + filler.length + 3;

      // Act
      const result = await sut.inflateHead(deflated, bound);

      // Assert
      expect(result).toEqual(data.subarray(0, bound));
    });

    it.each([
      { label: 'highly compressible', build: () => new Uint8Array(1024 * 1024).fill(0x61) },
      { label: 'incompressible', build: () => new Uint8Array(randomBytes(1024 * 1024)) },
    ])(
      'Given a 1 MiB $label stream, When inflateHead is called with a small bound, Then it returns exactly that many leading bytes',
      async ({ build }) => {
        // Arrange
        const sut = await createSut();
        const data = build();
        const deflated = await sut.deflate(data);

        // Act
        const result = await sut.inflateHead(deflated, 33);

        // Assert
        expect(result).toEqual(data.subarray(0, 33));
      },
    );

    it('Given no valid zlib stream, When inflateHead is called, Then it rejects with DECOMPRESS_FAILED', async () => {
      // Arrange
      const sut = await createSut();
      const junk = new Uint8Array([0xff, 0xfe, 0xfd, 0xfc]);

      // Act
      let caught: unknown;
      try {
        await sut.inflateHead(junk, 33);
      } catch (err) {
        caught = err;
      }

      // Assert
      expect(caught).toBeInstanceOf(TsgitError);
      expect((caught as TsgitError).data.code).toBe('DECOMPRESS_FAILED');
    });

    it('Given a valid zlib header followed by a corrupted block, When inflateHead is called, Then it rejects with DECOMPRESS_FAILED (a genuine decode error is never swallowed as the head bound being reached)', async () => {
      // Arrange — a valid 2-byte zlib header followed by a reserved block
      // type (BTYPE=11): the header alone is not enough to reach the bound,
      // so decoding must continue and hit the corruption before any
      // "bound reached" signal could apply.
      const sut = await createSut();
      const member = new Uint8Array([0x78, 0x9c, 0x06]);

      // Act
      let caught: unknown;
      try {
        await sut.inflateHead(member, 100);
      } catch (err) {
        caught = err;
      }

      // Assert
      expect(caught).toBeInstanceOf(TsgitError);
      expect((caught as TsgitError).data.code).toBe('DECOMPRESS_FAILED');
    });

    it('Given arbitrary bytes deflated and an arbitrary bound, When inflateHead is called with that bound, Then it returns exactly the leading bytes of the original payload (port law)', async () => {
      // Arrange
      const sut = await createSut();

      // Act + Assert
      await fc.assert(
        fc.asyncProperty(
          fc.uint8Array({ minLength: 0, maxLength: HEAD_PROPERTY_MAX_PAYLOAD_BYTES }),
          fc.integer({ min: 1, max: HEAD_PROPERTY_MAX_BOUND }),
          async (payload, bound) => {
            const deflated = await sut.deflate(payload);
            const result = await sut.inflateHead(deflated, bound);
            expect(result).toEqual(payload.subarray(0, bound));
          },
        ),
        { numRuns: HEAD_PROPERTY_NUM_RUNS },
      );
    });

    it('Given non-empty data, When deflateRaw vs deflate, Then outputs differ (no zlib wrapper)', async () => {
      // Arrange — kills a mutant aliasing deflateRaw to deflate: deflate wraps with
      // a 2-byte zlib header (0x78…) and a 4-byte adler32 trailer; deflateRaw omits both.
      const sut = await createSut();
      const data = new TextEncoder().encode('hello world');

      // Act
      const raw = await sut.deflateRaw(data);
      const zlib = await sut.deflate(data);

      // Assert
      expect(raw).not.toEqual(zlib);
    });
  });
}

/**
 * A valid RFC 1950 zlib member holding one STORED block of `literalByteCount`
 * zero bytes (BFINAL=0), followed by a corrupted trailing block header
 * (BTYPE=3, reserved by RFC 1951 -- no decoder ever accepts it). Built
 * byte-by-byte rather than through any adapter's `deflate`, so its layout is
 * identical for every `Compressor` under this contract.
 */
function buildOverCapStoredZlibMember(literalByteCount: number): Uint8Array {
  const ZLIB_HEADER = [0x78, 0x9c]; // CM=8 (deflate), FCHECK-valid, no preset dictionary
  const STORED_BLOCK_HEADER = 0x00; // BFINAL=0, BTYPE=00 (stored)
  const RESERVED_BLOCK_HEADER = 0x06; // BFINAL=0, BTYPE=11 (reserved)
  const nlen = ~literalByteCount & 0xffff;
  return new Uint8Array([
    ...ZLIB_HEADER,
    STORED_BLOCK_HEADER,
    literalByteCount & 0xff,
    (literalByteCount >> 8) & 0xff,
    nlen & 0xff,
    (nlen >> 8) & 0xff,
    ...new Array(literalByteCount).fill(0),
    RESERVED_BLOCK_HEADER,
  ]);
}

/**
 * A valid, complete RFC 1950 zlib member holding two consecutive STORED
 * blocks of zero bytes (BFINAL=0 then BFINAL=1), each byte-aligned
 * immediately after the previous block's own LEN-declared data — a STORED
 * block's body is always whole bytes, so the next block's 3-bit header
 * starts at bit 0 of the following byte with no bit-packing required.
 */
function buildTwoStoredBlocksZlibMember(
  firstBlockByteCount: number,
  secondBlockByteCount: number,
): Uint8Array {
  const ZLIB_HEADER = [0x78, 0x9c];
  const NON_FINAL_STORED_BLOCK_HEADER = 0x00; // BFINAL=0, BTYPE=00 (stored)
  const FINAL_STORED_BLOCK_HEADER = 0x01; // BFINAL=1, BTYPE=00 (stored)
  const storedBlockBytes = (blockHeader: number, byteCount: number): number[] => {
    const nlen = ~byteCount & 0xffff;
    return [
      blockHeader,
      byteCount & 0xff,
      (byteCount >> 8) & 0xff,
      nlen & 0xff,
      (nlen >> 8) & 0xff,
      ...new Array(byteCount).fill(0),
    ];
  };
  return new Uint8Array([
    ...ZLIB_HEADER,
    ...storedBlockBytes(NON_FINAL_STORED_BLOCK_HEADER, firstBlockByteCount),
    ...storedBlockBytes(FINAL_STORED_BLOCK_HEADER, secondBlockByteCount),
  ]);
}

async function rawInflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
