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
        // Arrange
        const sut = describeError(new Error('boom'));

        // Assert
        expect(sut).toBe('boom');
      });

      it('Given a non-Error value, When describing, Then returns String(value)', () => {
        // Arrange
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

    it('Given a small inflated-bytes cap and a roundtrip whose output exceeds it, When streamInflate runs, Then rejects with DECOMPRESS_FAILED (zip-bomb cap)', async () => {
      // Arrange
      const sut = new NodeCompressor({ maxInflatedBytes: 4 });
      const payload = new TextEncoder().encode('aaaaaaaaaaaaaaaaaaaa'); // 20 bytes
      const deflated = await sut.deflate(payload);
      let caught: unknown;
      try {
        await sut.streamInflate(deflated, 0);
      } catch (err) {
        caught = err;
      }
      // Assert
      expect(caught).toBeInstanceOf(TsgitError);
      expect((caught as TsgitError).data.code).toBe('DECOMPRESS_FAILED');
    });

    it('Given a small inflated-bytes cap and a roundtrip exceeding it via createInflateStream, When piped, Then errors the stream with DECOMPRESS_FAILED', async () => {
      // Arrange
      const sut = new NodeCompressor({ maxInflatedBytes: 4 });
      const payload = new TextEncoder().encode('aaaaaaaaaaaaaaaaaaaa');
      const deflated = await sut.deflate(payload);
      const source = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(deflated);
          controller.close();
        },
      });
      const sink = new WritableStream<Uint8Array>();
      let caught: unknown;
      try {
        await source.pipeThrough(sut.createInflateStream()).pipeTo(sink);
      } catch (err) {
        caught = err;
      }
      // Assert
      expect(caught).toBeInstanceOf(TsgitError);
      expect((caught as TsgitError).data.code).toBe('DECOMPRESS_FAILED');
    });

    it('Given a streamInflate roundtrip whose output equals the cap EXACTLY, When streamInflate runs, Then it succeeds (boundary is strictly greater-than, not >=)', async () => {
      // Arrange — payload length === cap: `total > cap` stays false at the boundary,
      // whereas a `total >= cap` mutant would reject this legitimate input.
      const sut = new NodeCompressor({ maxInflatedBytes: 20 });
      const payload = new TextEncoder().encode('aaaaaaaaaaaaaaaaaaaa'); // exactly 20 bytes
      const deflated = await sut.deflate(payload);

      // Act
      const result = await sut.streamInflate(deflated, 0);

      // Assert
      expect(result.output).toEqual(payload);
    });

    it('Given a createInflateStream roundtrip whose output equals the cap EXACTLY, When piped, Then it succeeds (boundary is strictly greater-than, not >=)', async () => {
      // Arrange — same boundary probe for the TransformStream path's `total > cap` guard.
      const sut = new NodeCompressor({ maxInflatedBytes: 20 });
      const payload = new TextEncoder().encode('aaaaaaaaaaaaaaaaaaaa'); // exactly 20 bytes
      const deflated = await sut.deflate(payload);
      const source = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(deflated);
          controller.close();
        },
      });
      const chunks: Uint8Array[] = [];
      const sink = new WritableStream<Uint8Array>({
        write(chunk) {
          chunks.push(chunk);
        },
      });

      // Act
      await source.pipeThrough(sut.createInflateStream()).pipeTo(sink);

      // Assert
      const total = chunks.reduce((acc, c) => acc + c.length, 0);
      expect(total).toBe(20);
    });

    it('Given the streamInflate cap rejection, When triggered, Then the error message is exactly "inflated output exceeds safety cap"', async () => {
      // Arrange — pins the StringLiteral on the reject() message.
      const sut = new NodeCompressor({ maxInflatedBytes: 4 });
      const payload = new TextEncoder().encode('aaaaaaaaaaaaaaaaaaaa');
      const deflated = await sut.deflate(payload);

      // Act
      let caught: unknown;
      try {
        await sut.streamInflate(deflated, 0);
      } catch (err) {
        caught = err;
      }

      // Assert
      expect((caught as TsgitError).message).toContain('inflated output exceeds safety cap');
    });

    it('Given the createInflateStream cap rejection, When triggered, Then the error message is exactly "inflated output exceeds safety cap"', async () => {
      // Arrange — pins the StringLiteral on the controller.error() message.
      const sut = new NodeCompressor({ maxInflatedBytes: 4 });
      const payload = new TextEncoder().encode('aaaaaaaaaaaaaaaaaaaa');
      const deflated = await sut.deflate(payload);
      const source = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(deflated);
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

      // Assert
      expect((caught as TsgitError).message).toContain('inflated output exceeds safety cap');
    });

    it('Given a large payload that inflates across multiple data chunks, When streamInflate runs, Then all chunks are concatenated in order (offset advances forward)', async () => {
      // Arrange — 256 KiB exceeds Node's inflate chunk buffer, forcing several
      // 'data' events. concatUint8 must advance `offset` forward; a `-=` mutant
      // would compute a negative offset and make out.set() throw RangeError.
      const sut = new NodeCompressor();
      const size = 256 * 1024;
      const payload = new Uint8Array(size);
      for (let i = 0; i < size; i += 1) payload[i] = i & 0xff;
      const deflated = await sut.deflate(payload);

      // Act
      const result = await sut.streamInflate(deflated, 0);

      // Assert — exact byte-for-byte recovery proves forward concatenation.
      expect(result.output).toEqual(payload);
    });

    it('Given oversized payload to inflate(), When inflate runs, Then throws DECOMPRESS_FAILED (Node maxOutputLength enforced)', async () => {
      // Arrange
      // Kills the mutant where the inflate() maxOutputLength option is removed.
      const sut = new NodeCompressor({ maxInflatedBytes: 4 });
      const payload = new TextEncoder().encode('aaaaaaaaaaaaaaaaaaaa');
      const deflated = await sut.deflate(payload);
      let caught: unknown;
      try {
        await sut.inflate(deflated);
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
