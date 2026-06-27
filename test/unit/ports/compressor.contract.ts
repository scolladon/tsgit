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
