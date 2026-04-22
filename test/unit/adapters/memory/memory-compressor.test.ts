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

    it('Given CompressionStream unavailable, When constructing MemoryCompressor, Then throws COMPRESS_FAILED', () => {
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

    it('Given DecompressionStream unavailable, When constructing MemoryCompressor, Then throws COMPRESS_FAILED', () => {
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

    it('Given CompressionStream constructor throws, When deflate, Then rethrows as COMPRESS_FAILED', async () => {
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

    it('Given streamInflate input above the safety cap, When called, Then throws DECOMPRESS_FAILED with a cap-exceeded message', async () => {
      // Memory adapter uses an O(n^2) progressive-prefix scan; the cap guards
      // against accidentally using this adapter for real packfiles.
      const sut = new MemoryCompressor();
      const oversized = new Uint8Array(64 * 1024 + 1);
      try {
        await sut.streamInflate(oversized, 0);
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

    it('Given non-Error thrown during deflate, When failing, Then reason falls back to String(err)', async () => {
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
