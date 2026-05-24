import { afterEach, describe, expect, it } from 'vitest';
import { MemoryCompressor } from '../../../../src/adapters/memory/memory-compressor.js';
import { TsgitError } from '../../../../src/domain/index.js';
import { compressorContractTests } from '../../ports/compressor.contract.js';

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

    describe('Given streamInflate input above the safety cap', () => {
      describe('When called', () => {
        it('Then throws DECOMPRESS_FAILED with a cap-exceeded message', async () => {
          // Arrange
          // Memory adapter uses an O(n^2) progressive-prefix scan; the cap guards
          // against accidentally using this adapter for real packfiles.
          const sut = new MemoryCompressor();
          const oversized = new Uint8Array(64 * 1024 + 1);
          try {
            await sut.streamInflate(oversized, 0);
            // Assert
            expect.unreachable();
          } catch (err) {
            expect(err).toBeInstanceOf(TsgitError);
            const data = (err as TsgitError).data;
            expect(data.code).toBe('DECOMPRESS_FAILED');
            if (data.code === 'DECOMPRESS_FAILED') {
              expect(data.reason).toMatch(/safety cap/);
            }
          }
        });
      });
    });

    describe('Given streamInflate input exactly at the safety cap with a valid prefix', () => {
      describe('When called', () => {
        it('Then it inflates without hitting the cap', async () => {
          // Arrange — a 64KiB buffer (length === cap, not above it) whose first
          // bytes are a real deflate stream; the cap guard uses `>`, so an
          // exactly-cap input must NOT throw. A `>=` mutant would reject it.
          const sut = new MemoryCompressor();
          const payload = await sut.deflate(new Uint8Array([7, 8, 9]));
          const buffer = new Uint8Array(64 * 1024);
          buffer.set(payload, 0);

          // Act
          const result = await sut.streamInflate(buffer, 0);

          // Assert
          expect(Array.from(result.output)).toEqual([7, 8, 9]);
          expect(result.bytesConsumed).toBe(payload.length);
        });
      });
    });

    describe('Given bytes that never form a valid zlib stream within the cap', () => {
      describe('When streamInflate', () => {
        it('Then throws DECOMPRESS_FAILED with the no-valid-stream reason', async () => {
          // Arrange — small all-zero input: no prefix decompresses cleanly, so the
          // loop exhausts and the terminal throw fires with its exact message.
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
            expect(data.reason).toBe('no valid zlib stream at offset');
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
