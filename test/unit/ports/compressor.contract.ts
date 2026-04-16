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
  });
}
