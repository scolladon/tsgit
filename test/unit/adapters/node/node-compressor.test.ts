import { describe, expect, it } from 'vitest';
import { describeError, NodeCompressor } from '../../../../src/adapters/node/node-compressor.js';
import { TsgitError } from '../../../../src/domain/index.js';
import { compressorContractTests } from '../../ports/compressor.contract.js';

describe('NodeCompressor', () => {
  compressorContractTests(async () => new NodeCompressor());

  describe('node-specific behaviors', () => {
    it('Given invalid input (not a Uint8Array), When deflate, Then throws COMPRESS_FAILED', async () => {
      // Arrange — bypass TypeScript to feed deflateSync an unsupported value
      const sut = new NodeCompressor();
      const bogus = 42 as unknown as Uint8Array;

      // Act
      let caught: unknown;
      try {
        await sut.deflate(bogus);
      } catch (err) {
        caught = err;
      }

      // Assert
      expect(caught).toBeInstanceOf(TsgitError);
      expect((caught as TsgitError).data.code).toBe('COMPRESS_FAILED');
    });

    it('Given roundtrip through deflate/inflate, When inflating the deflated bytes, Then original content is recovered', async () => {
      // Arrange
      const sut = new NodeCompressor();
      const data = new TextEncoder().encode('quick check');

      // Act
      const deflated = await sut.deflate(data);
      const inflated = await sut.inflate(deflated);

      // Assert
      expect(inflated).toEqual(data);
    });

    describe('describeError', () => {
      it('Given an Error instance, When describing, Then returns its message', () => {
        // Act
        const sut = describeError(new Error('boom'));

        // Assert
        expect(sut).toBe('boom');
      });

      it('Given a non-Error value, When describing, Then returns String(value)', () => {
        // Act
        const sut = describeError(42);

        // Assert
        expect(sut).toBe('42');
      });
    });

    it('Given corrupt stream, When piping through createInflateStream, Then stream errors with DECOMPRESS_FAILED', async () => {
      // Arrange
      const sut = new NodeCompressor();
      const corrupt = new Uint8Array([0xff, 0xff, 0xff, 0xff]);
      const source = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(corrupt);
          controller.close();
        },
      });
      const transformed = source.pipeThrough(sut.createInflateStream());
      const reader = transformed.getReader();

      // Act
      let caught: unknown;
      try {
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const { done } = await reader.read();
          if (done) break;
        }
      } catch (err) {
        caught = err;
      }

      // Assert
      expect(caught).toBeInstanceOf(TsgitError);
      expect((caught as TsgitError).data.code).toBe('DECOMPRESS_FAILED');
    });

    it('Given corrupt stream piped through createInflateStream, When awaiting pipeTo completion, Then the promise rejects (does not hang)', async () => {
      // Arrange — this kills the mutant where endPromise only has a resolve path:
      // pipeTo awaits the writable side which awaits flush() which awaits endPromise.
      // If endPromise never rejects, this pipeTo would hang forever.
      const sut = new NodeCompressor();
      const corrupt = new Uint8Array([0xff, 0xff, 0xff, 0xff]);
      const source = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(corrupt);
          controller.close();
        },
      });
      const sink = new WritableStream<Uint8Array>();

      // Act
      let caught: unknown;
      try {
        await source.pipeThrough(sut.createInflateStream()).pipeTo(sink);
      } catch (err) {
        caught = err;
      }

      // Assert — settles with rejection, not hangs
      expect(caught).toBeInstanceOf(TsgitError);
      expect((caught as TsgitError).data.code).toBe('DECOMPRESS_FAILED');
    });
  });
});
