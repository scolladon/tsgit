import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { TsgitError } from '../../../src/domain/index.js';
import type { Compressor } from '../../../src/ports/compressor.js';

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

async function rawInflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
