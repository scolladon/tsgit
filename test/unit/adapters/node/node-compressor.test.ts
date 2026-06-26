import { describe, expect, it } from 'vitest';
import { describeError, NodeCompressor } from '../../../../src/adapters/node/node-compressor.js';
import { TsgitError } from '../../../../src/domain/index.js';
import { compressorContractTests } from '../../ports/compressor.contract.js';

describe('NodeCompressor', () => {
  compressorContractTests(async () => new NodeCompressor());

  describe('node-specific behaviors', () => {
    describe('Given invalid input (not a Uint8Array)', () => {
      describe('When deflate', () => {
        it('Then throws COMPRESS_FAILED', async () => {
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
      });
    });

    describe('Given roundtrip through deflate/inflate', () => {
      describe('When inflating the deflated bytes', () => {
        it('Then original content is recovered', async () => {
          // Arrange
          const sut = new NodeCompressor();
          const data = new TextEncoder().encode('quick check');

          // Act
          const deflated = await sut.deflate(data);
          const inflated = await sut.inflate(deflated);

          // Assert
          expect(inflated).toEqual(data);
        });
      });
    });

    describe('describeError', () => {
      describe('Given an Error instance', () => {
        describe('When describing', () => {
          it('Then returns its message', () => {
            // Arrange
            const sut = describeError(new Error('boom'));

            // Assert
            expect(sut).toBe('boom');
          });
        });
      });

      describe('Given a non-Error value', () => {
        describe('When describing', () => {
          it('Then returns String(value)', () => {
            // Arrange
            const sut = describeError(42);

            // Assert
            expect(sut).toBe('42');
          });
        });
      });
    });

    describe('Given corrupt stream', () => {
      describe('When piping through createInflateStream', () => {
        it('Then stream errors with DECOMPRESS_FAILED', async () => {
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
      });
    });

    describe('Given a small inflated-bytes cap and a roundtrip whose output exceeds it', () => {
      describe('When streamInflate runs', () => {
        it('Then rejects with DECOMPRESS_FAILED (zip-bomb cap)', async () => {
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
      });
    });

    describe('Given a small inflated-bytes cap and a roundtrip exceeding it via createInflateStream', () => {
      describe('When piped', () => {
        it('Then errors the stream with DECOMPRESS_FAILED', async () => {
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
      });
    });

    describe('Given a streamInflate roundtrip whose output equals the cap EXACTLY', () => {
      describe('When streamInflate runs', () => {
        it('Then it succeeds (boundary is strictly greater-than, not >=)', async () => {
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
      });
    });

    describe('Given a createInflateStream roundtrip whose output equals the cap EXACTLY', () => {
      describe('When piped', () => {
        it('Then it succeeds (boundary is strictly greater-than, not >=)', async () => {
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
      });
    });

    describe('Given the streamInflate cap rejection', () => {
      describe('When triggered', () => {
        it('Then the error message is exactly "inflated output exceeds safety cap"', async () => {
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
      });
    });

    describe('Given the createInflateStream cap rejection', () => {
      describe('When triggered', () => {
        it('Then the error message is exactly "inflated output exceeds safety cap"', async () => {
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
      });
    });

    describe('Given a large payload that inflates across multiple data chunks', () => {
      describe('When streamInflate runs', () => {
        it('Then all chunks are concatenated in order (offset advances forward)', async () => {
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
      });
    });

    describe('Given oversized payload to inflate()', () => {
      describe('When inflate runs', () => {
        it('Then throws DECOMPRESS_FAILED (Node maxOutputLength enforced)', async () => {
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
      });
    });

    describe('Given invalid input (not a Uint8Array) to deflateRaw', () => {
      describe('When deflateRaw', () => {
        it('Then throws COMPRESS_FAILED', async () => {
          // Arrange
          const sut = new NodeCompressor();
          const bogus = 42 as unknown as Uint8Array;

          // Act
          let caught: unknown;
          try {
            await sut.deflateRaw(bogus);
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          expect((caught as TsgitError).data.code).toBe('COMPRESS_FAILED');
        });
      });
    });

    describe('Given data and an explicit level', () => {
      describe('When deflateRaw with level=1', () => {
        it('Then the level arm executes and output round-trips via raw-inflate', async () => {
          // Arrange — exercises the `deflateRawSync(data, { level })` arm of the ternary.
          const sut = new NodeCompressor();
          const data = new TextEncoder().encode('hello deflateRaw with level');
          const { inflateRawSync } = await import('node:zlib');

          // Act
          const result = await sut.deflateRaw(data, 1);

          // Assert — verify round-trip via Node's inflateRawSync (test-side only)
          expect(new Uint8Array(inflateRawSync(result))).toEqual(data);
        });
      });

      describe('When deflateRaw with level=0 (raw stored-block format)', () => {
        it('Then the first byte is 0x01 — BFINAL=1 BTYPE=00 raw stored block', async () => {
          // Arrange
          const sut = new NodeCompressor();
          const data = new TextEncoder().encode('hello');

          // Act
          const result = await sut.deflateRaw(data, 0);

          // Assert — raw deflate level=0 uses stored blocks; first byte is BFINAL=1|BTYPE=00 = 0x01.
          // Mutants that ignore `level` (true?, !==undefined, {}) default to Node level ≥ 1 and
          // produce a first byte other than 0x01.
          expect(result[0]).toBe(0x01);
        });
      });
    });

    describe('Given data with no level argument', () => {
      describe('When deflateRaw', () => {
        it('Then the no-level arm executes and output round-trips via raw-inflate', async () => {
          // Arrange — exercises the `deflateRawSync(data)` arm of the ternary.
          const sut = new NodeCompressor();
          const data = new TextEncoder().encode('hello deflateRaw no level');
          const { inflateRawSync } = await import('node:zlib');

          // Act
          const result = await sut.deflateRaw(data);

          // Assert — verify round-trip
          expect(new Uint8Array(inflateRawSync(result))).toEqual(data);
        });
      });
    });

    describe('Given deflate with an explicit compression level', () => {
      describe('When level=9 (maximum compression)', () => {
        it('Then the output starts with zlib header 0x78 0xda', async () => {
          // Arrange
          const sut = new NodeCompressor();
          const data = new TextEncoder().encode('hello zlib level 9');

          // Act
          const result = await sut.deflate(data, 9);

          // Assert — zlib level-9 header is always 78 da
          expect(result[0]).toBe(0x78);
          expect(result[1]).toBe(0xda);
        });
      });

      describe('When level=0 (no compression / store)', () => {
        it('Then the output starts with zlib header 0x78 0x01', async () => {
          // Arrange
          const sut = new NodeCompressor();
          const data = new TextEncoder().encode('hello zlib level 0');

          // Act
          const result = await sut.deflate(data, 0);

          // Assert — zlib level-0 header is always 78 01
          expect(result[0]).toBe(0x78);
          expect(result[1]).toBe(0x01);
        });
      });

      describe('When level=-1 (zlib default, same as 6)', () => {
        it('Then the output starts with zlib header 0x78 0x9c', async () => {
          // Arrange
          const sut = new NodeCompressor();
          const data = new TextEncoder().encode('hello zlib level -1');

          // Act
          const result = await sut.deflate(data, -1);

          // Assert — zlib default level header is 78 9c
          expect(result[0]).toBe(0x78);
          expect(result[1]).toBe(0x9c);
        });
      });

      describe('When no level is given (adapter default)', () => {
        it('Then the output starts with zlib header 0x78 0x9c (Node default level 6)', async () => {
          // Arrange
          const sut = new NodeCompressor();
          const data = new TextEncoder().encode('hello zlib no level');

          // Act
          const result = await sut.deflate(data);

          // Assert — Node default (level 6) header is 78 9c
          expect(result[0]).toBe(0x78);
          expect(result[1]).toBe(0x9c);
        });
      });
    });

    describe('Given corrupt stream piped through createInflateStream', () => {
      describe('When awaiting pipeTo completion', () => {
        it('Then the promise rejects (does not hang)', async () => {
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
  });
});
