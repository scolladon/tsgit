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

    it('Given a zlib member whose full output vastly exceeds a caller-supplied bound, When streamInflate is called with that bound, Then it aborts after decoding a fraction of the member rather than materializing all of it', async () => {
      // Arrange — a highly compressible buffer deflates to a tiny member, so
      // building the fixture is cheap while decoding it in full is not. The
      // oracle is RELATIVE, never an absolute wall-clock budget: an absolute
      // one is really a measurement of the host and of whatever instrumentation
      // wraps the run, and fails under coverage on an implementation that is
      // perfectly correct. Timing the same member unbounded, in the same
      // process under the same instrumentation, calibrates the comparison
      // away. An implementation that inflates fully and only then compares
      // `output.length` does the SAME work in both arms, so the ratio
      // collapses toward 1 and this fails — which is exactly the defect the
      // row exists to catch.
      const sut = await createSut();
      const bound = 1024;
      const deflated = await sut.deflate(new Uint8Array(8 * 1024 * 1024));

      // Act — unbounded decode first, to calibrate the cost of the full member.
      const beforeFull = performance.now();
      const full = await sut.streamInflate(deflated, 0);
      const fullElapsed = performance.now() - beforeFull;

      const beforeBounded = performance.now();
      let bounded: unknown;
      try {
        await sut.streamInflate(deflated, 0, bound);
      } catch (err) {
        bounded = err;
      }
      const boundedElapsed = performance.now() - beforeBounded;

      // Assert — the bounded arm refuses, and got there without paying for the
      // whole member.
      expect(full.output.length).toBe(8 * 1024 * 1024);
      expect(bounded).toBeInstanceOf(TsgitError);
      expect((bounded as TsgitError).data.code).toBe('DECOMPRESS_FAILED');
      expect(boundedElapsed).toBeLessThan(fullElapsed / 4);
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

async function rawInflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
