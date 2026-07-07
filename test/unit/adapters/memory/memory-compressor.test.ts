import { afterEach, describe, expect, it } from 'vitest';
import { MemoryCompressor } from '../../../../src/adapters/memory/memory-compressor.js';
import { TsgitError } from '../../../../src/domain/index.js';
import { compressorContractTests } from '../../ports/compressor.contract.js';

async function rawInflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

describe('MemoryCompressor', () => {
  compressorContractTests(async () => new MemoryCompressor());

  describe('memory-specific behaviors', () => {
    const globals = globalThis as unknown as {
      CompressionStream: unknown;
      DecompressionStream: unknown;
    };
    const originalCompression = globals.CompressionStream;
    const originalDecompression = globals.DecompressionStream;

    afterEach(() => {
      globals.CompressionStream = originalCompression;
      globals.DecompressionStream = originalDecompression;
    });

    describe('Given CompressionStream unavailable', () => {
      describe('When constructing MemoryCompressor', () => {
        it('Then throws COMPRESS_FAILED', () => {
          // Arrange
          globals.CompressionStream = undefined;

          // Act
          let caught: unknown;
          try {
            new MemoryCompressor();
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          const data = (caught as TsgitError).data;
          expect(data.code).toBe('COMPRESS_FAILED');
          if (data.code === 'COMPRESS_FAILED') {
            expect(data.reason).toContain('CompressionStream');
          }
        });
      });
    });

    describe('Given DecompressionStream unavailable', () => {
      describe('When constructing MemoryCompressor', () => {
        it('Then throws COMPRESS_FAILED', () => {
          // Arrange
          globals.DecompressionStream = undefined;

          // Act
          let caught: unknown;
          try {
            new MemoryCompressor();
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          expect((caught as TsgitError).data.code).toBe('COMPRESS_FAILED');
        });
      });
    });

    describe('Given CompressionStream constructor throws', () => {
      describe('When deflate', () => {
        it('Then rethrows as COMPRESS_FAILED', async () => {
          // Arrange — build the compressor with real globals, then swap the constructor to a throwing one.
          const sut = new MemoryCompressor();
          class ThrowingCompressionStream {
            constructor() {
              throw new Error('boom from deflate stream');
            }
          }
          globals.CompressionStream = ThrowingCompressionStream;

          // Act
          let caught: unknown;
          try {
            await sut.deflate(new Uint8Array([1, 2, 3]));
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          const data = (caught as TsgitError).data;
          expect(data.code).toBe('COMPRESS_FAILED');
          if (data.code === 'COMPRESS_FAILED') {
            expect(data.reason).toContain('boom from deflate stream');
          }
        });
      });
    });

    describe('Given bytes that never form a valid zlib stream', () => {
      describe('When streamInflate', () => {
        it('Then throws DECOMPRESS_FAILED', async () => {
          // Arrange — all-zero input has a valid-looking CMF/FLG check but an
          // unsupported compression method, so the decoder rejects it upfront.
          const sut = new MemoryCompressor();
          const garbage = new Uint8Array([0, 0, 0, 0]);

          // Act
          let caught: unknown;
          try {
            await sut.streamInflate(garbage, 0);
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          const data = (caught as TsgitError).data;
          expect(data.code).toBe('DECOMPRESS_FAILED');
          if (data.code === 'DECOMPRESS_FAILED') {
            expect(data.reason).toBe('unsupported compression method');
          }
        });
      });
    });

    describe('Given deflate called with an explicit level', () => {
      describe('When level=9 is passed', () => {
        it('Then output round-trips correctly and equals deflate with no level (level ignored)', async () => {
          // Arrange — MemoryCompressor uses Web CompressionStream which has no level;
          // the _level param is accepted to satisfy the port but silently ignored.
          const sut = new MemoryCompressor();
          const data = new TextEncoder().encode('memory compressor ignores level');

          // Act
          const withLevel = await sut.deflate(data, 9);
          const withoutLevel = await sut.deflate(data);

          // Assert — both round-trip to original; output is identical (level ignored)
          const inflatedWith = await sut.inflate(withLevel);
          expect(inflatedWith).toEqual(data);
          expect(withLevel).toEqual(withoutLevel);
        });
      });
    });

    describe('Given deflateRaw called with an explicit level', () => {
      describe('When level=9 is passed', () => {
        it('Then output round-trips via raw-inflate and equals deflateRaw with no level (level ignored)', async () => {
          // Arrange — Web CompressionStream has no level param; accepted to satisfy the
          // port, silently ignored (same precedent as deflate).
          const sut = new MemoryCompressor();
          const data = new TextEncoder().encode('memory deflateRaw ignores level');

          // Act
          const withLevel = await sut.deflateRaw(data, 9);
          const withoutLevel = await sut.deflateRaw(data);

          // Assert — both round-trip to original via raw inflate; output is identical
          const inflatedWith = await rawInflate(withLevel);
          expect(inflatedWith).toEqual(data);
          expect(withLevel).toEqual(withoutLevel);
        });
      });
    });

    describe('Given CompressionStream constructor throws during deflateRaw', () => {
      describe('When deflateRaw', () => {
        it('Then rethrows as COMPRESS_FAILED', async () => {
          // Arrange — build the compressor with real globals, then swap the constructor to a throwing one.
          const sut = new MemoryCompressor();
          class ThrowingCompressionStream {
            constructor() {
              throw new Error('boom from deflateRaw stream');
            }
          }
          globals.CompressionStream = ThrowingCompressionStream;

          // Act
          let caught: unknown;
          try {
            await sut.deflateRaw(new Uint8Array([1, 2, 3]));
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          const data = (caught as TsgitError).data;
          expect(data.code).toBe('COMPRESS_FAILED');
          if (data.code === 'COMPRESS_FAILED') {
            expect(data.reason).toContain('boom from deflateRaw stream');
          }
        });
      });
    });

    describe('Given non-Error thrown during deflate', () => {
      describe('When failing', () => {
        it('Then reason falls back to String(err)', async () => {
          // Arrange — throw a non-Error (string) to exercise describeError's else branch via deflate.
          const sut = new MemoryCompressor();
          class NonErrorThrowingCompressionStream {
            constructor() {
              // Throwing a plain string: describeError should wrap it with String()
              // eslint-disable-next-line @typescript-eslint/no-throw-literal
              throw 'plain-string-failure';
            }
          }
          globals.CompressionStream = NonErrorThrowingCompressionStream;

          // Act
          let caught: unknown;
          try {
            await sut.deflate(new Uint8Array([1]));
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          const data = (caught as TsgitError).data;
          expect(data.code).toBe('COMPRESS_FAILED');
          if (data.code === 'COMPRESS_FAILED') {
            expect(data.reason).toBe('plain-string-failure');
          }
        });
      });
    });
  });
});
