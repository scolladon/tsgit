import { randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CALLBACK_DISPATCH_THRESHOLD_BYTES,
  describeError,
  NodeCompressor,
} from '../../../../src/adapters/node/node-compressor.js';
import { TsgitError } from '../../../../src/domain/index.js';
import { compressorContractTests } from '../../ports/compressor.contract.js';

vi.mock('node:zlib', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:zlib')>();
  return {
    ...actual,
    deflate: vi.fn(actual.deflate),
    deflateRaw: vi.fn(actual.deflateRaw),
    deflateRawSync: vi.fn(actual.deflateRawSync),
    deflateSync: vi.fn(actual.deflateSync),
    inflate: vi.fn(actual.inflate),
    inflateSync: vi.fn(actual.inflateSync),
  };
});

const zlib = await import('node:zlib');
const deflateSyncSpy = vi.mocked(zlib.deflateSync);
const deflateRawSyncSpy = vi.mocked(zlib.deflateRawSync);
const inflateSyncSpy = vi.mocked(zlib.inflateSync);
const deflateCallbackSpy = vi.mocked(zlib.deflate);
const deflateRawCallbackSpy = vi.mocked(zlib.deflateRaw);
const inflateCallbackSpy = vi.mocked(zlib.inflate);

describe('NodeCompressor', () => {
  beforeEach(() => {
    deflateSyncSpy.mockClear();
    deflateCallbackSpy.mockClear();
    deflateRawSyncSpy.mockClear();
    deflateRawCallbackSpy.mockClear();
    inflateSyncSpy.mockClear();
    inflateCallbackSpy.mockClear();
  });

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
            // Arrange & Act
            const result = describeError(new Error('boom'));

            // Assert
            expect(result).toBe('boom');
          });
        });
      });

      describe('Given a non-Error value', () => {
        describe('When describing', () => {
          it('Then returns String(value)', () => {
            // Arrange & Act
            const result = describeError(42);

            // Assert
            expect(result).toBe('42');
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

    describe('Given the cap is exceeded after flush() has already been entered', () => {
      describe('When the writable side is closed', () => {
        it('Then the close settles instead of waiting forever on the inflate end', async () => {
          // Arrange — close() enters flush() before the 'data' event carrying the
          // over-cap chunk arrives, so flush()'s promise is the one that must be
          // settled by the cap teardown.
          const sut = new NodeCompressor({ maxInflatedBytes: 4 });
          const deflated = await sut.deflate(new TextEncoder().encode('aaaaaaaaaaaaaaaaaaaa'));
          const transform = sut.createInflateStream();
          const reader = transform.readable.getReader();
          const writer = transform.writable.getWriter();

          // Act — close() is queued behind the write without awaiting it, so
          // flush() is entered before the over-cap chunk is decoded.
          const written = writer.write(deflated);
          const closed = writer.close().then(
            () => 'settled',
            () => 'settled',
          );
          const read = reader.read();
          const outcome = await Promise.race([
            closed,
            new Promise((resolve) => setTimeout(() => resolve('pending'), 250)),
          ]);
          await Promise.allSettled([written, read]);

          // Assert
          expect(outcome).toBe('settled');
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

    describe('Given a caller-supplied streamInflate bound larger than the instance cap', () => {
      describe('When streamInflate runs', () => {
        it('Then the instance cap still applies — a caller cannot raise the cap', async () => {
          // Arrange — the instance cap (4 bytes) is smaller than the
          // caller-supplied bound (1,000,000), so the effective cap must stay
          // at 4: a `Math.max` (or otherwise unclamped) mutant would let the
          // larger caller bound win and this 20-byte payload would succeed.
          const sut = new NodeCompressor({ maxInflatedBytes: 4 });
          const payload = new TextEncoder().encode('aaaaaaaaaaaaaaaaaaaa'); // 20 bytes
          const deflated = await sut.deflate(payload);

          // Act
          let caught: unknown;
          try {
            await sut.streamInflate(deflated, 0, 1_000_000);
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          expect((caught as TsgitError).data.code).toBe('DECOMPRESS_FAILED');
        });
      });
    });

    describe('Given a caller-supplied streamInflate bound smaller than the instance cap', () => {
      describe('When streamInflate runs', () => {
        it('Then the caller bound applies — narrowing the cap is honoured', async () => {
          // Arrange — the instance cap (the adapter default) would happily
          // accept this 20-byte payload; only the caller's own 4-byte bound
          // rejects it.
          const sut = new NodeCompressor();
          const payload = new TextEncoder().encode('aaaaaaaaaaaaaaaaaaaa'); // 20 bytes
          const deflated = await sut.deflate(payload);

          // Act
          let caught: unknown;
          try {
            await sut.streamInflate(deflated, 0, 4);
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          expect((caught as TsgitError).data.code).toBe('DECOMPRESS_FAILED');
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

    describe('Given deflate at a given compression level (explicit or default)', () => {
      describe('When deflating the payload', () => {
        it.each([
          {
            levelArgs: [9] as const,
            data: 'hello zlib level 9',
            header: [0x78, 0xda],
            label: 'output for level=9 (maximum compression) starts with zlib header 0x78 0xda',
          },
          {
            levelArgs: [0] as const,
            data: 'hello zlib level 0',
            header: [0x78, 0x01],
            label: 'output for level=0 (no compression / store) starts with zlib header 0x78 0x01',
          },
          {
            levelArgs: [-1] as const,
            data: 'hello zlib level -1',
            header: [0x78, 0x9c],
            label:
              'output for level=-1 (zlib default, same as 6) starts with zlib header 0x78 0x9c',
          },
          {
            levelArgs: [] as const,
            data: 'hello zlib no level',
            header: [0x78, 0x9c],
            label:
              'output for no level given (adapter default) starts with zlib header 0x78 0x9c (Node default level 6)',
          },
        ])('Then the $label', async ({ levelArgs, data, header }) => {
          // Arrange
          const sut = new NodeCompressor();
          const payload = new TextEncoder().encode(data);

          // Act
          const result = await sut.deflate(payload, ...levelArgs);

          // Assert — zlib header bytes are pinned per level
          expect(result[0]).toBe(header[0]);
          expect(result[1]).toBe(header[1]);
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

    describe('Given a large payload inflating across multiple data chunks', () => {
      describe('When the consumer reads one chunk then cancels the reader mid-stream', () => {
        it('Then the reader settles promptly without throwing ERR_INVALID_STATE', async () => {
          // Arrange — 256 KiB forces several zlib 'data' events, so the pump is
          // still actively enqueueing when cancel() lands mid-stream.
          const sut = new NodeCompressor();
          const size = 256 * 1024;
          const payload = new Uint8Array(size);
          for (let i = 0; i < size; i += 1) payload[i] = i & 0xff;
          const deflated = await sut.deflate(payload);
          const source = new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(deflated);
              controller.close();
            },
          });
          const reader = source.pipeThrough(sut.createInflateStream()).getReader();

          // Act
          await reader.read();
          let caught: unknown;
          try {
            await reader.cancel();
          } catch (err) {
            caught = err;
          }

          // Assert — cancellation is a clean, expected termination, not a thrown error
          expect(caught).toBeUndefined();
        }, 5000);
      });
    });

    describe('Given a truncated zlib stream the decoder can never finish on its own', () => {
      describe('When the consumer reads one chunk then cancels the reader', () => {
        it('Then the cancel resolves instead of surfacing the truncation as a failure', async () => {
          // Arrange — dropping the last bytes removes the natural 'end' that
          // would otherwise settle flush()'s promise for free, so the
          // cancellation teardown is the ONLY thing that can settle it. Left
          // running, the decoder reaches the truncation and reports
          // DECOMPRESS_FAILED — a cancelled consumer must never be told that.
          const sut = new NodeCompressor();
          const size = 256 * 1024;
          const payload = new Uint8Array(size);
          for (let i = 0; i < size; i += 1) payload[i] = i & 0xff;
          const deflated = await sut.deflate(payload);
          const truncated = deflated.subarray(0, deflated.length - 5);
          const source = new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(truncated);
              controller.close();
            },
          });
          const reader = source.pipeThrough(sut.createInflateStream()).getReader();

          // Act
          await reader.read();
          let caught: unknown;
          try {
            await reader.cancel();
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(caught).toBeUndefined();
        }, 5000);
      });
    });

    describe('Given a multi-write source whose next chunk has not arrived yet', () => {
      describe('When the consumer cancels before the source closes (before flush() starts)', () => {
        it('Then the cancel() hook stops the pump and the reader settles cleanly', async () => {
          // Arrange — 256 KiB forces several zlib 'data' events from the single
          // chunk already written, so the pump is genuinely mid-flight. The
          // source's second pull() never resolves, so it never closes — the
          // TransformStream's writable side stays open and flush() never runs.
          // In that timing the Streams runtime invokes the transformer's
          // cancel() hook directly, rather than aliasing to flush()'s promise
          // (contrast with the "reads one chunk then cancels" test above,
          // whose single-enqueue-then-close source lets flush() start first).
          const sut = new NodeCompressor();
          const size = 256 * 1024;
          const payload = new Uint8Array(size);
          for (let i = 0; i < size; i += 1) payload[i] = i & 0xff;
          const deflated = await sut.deflate(payload);
          const neverResolves = new Promise<void>(() => {});
          let pullCount = 0;
          const source = new ReadableStream<Uint8Array>({
            async pull(controller) {
              pullCount += 1;
              if (pullCount === 1) {
                controller.enqueue(deflated);
                return;
              }
              await neverResolves;
            },
          });
          const reader = source.pipeThrough(sut.createInflateStream()).getReader();

          // Act
          await reader.read();
          let caught: unknown;
          try {
            await reader.cancel();
          } catch (err) {
            caught = err;
          }

          // Assert — cancellation resolves cleanly, not as a decompression failure
          expect(caught).toBeUndefined();
        }, 5000);
      });
    });

    describe('Given the callback-dispatch size gate', () => {
      describe('When deflate runs on a payload below the threshold', () => {
        it('Then the synchronous path is used, not the callback path', async () => {
          // Arrange
          const sut = new NodeCompressor();
          const data = new Uint8Array(CALLBACK_DISPATCH_THRESHOLD_BYTES - 1);

          // Act
          await sut.deflate(data);

          // Assert
          expect(deflateSyncSpy).toHaveBeenCalledTimes(1);
          expect(deflateCallbackSpy).not.toHaveBeenCalled();
        });
      });

      describe('When deflate runs on a payload exactly at the threshold', () => {
        it('Then the synchronous path is used (the boundary is strictly greater-than)', async () => {
          // Arrange
          const sut = new NodeCompressor();
          const data = new Uint8Array(CALLBACK_DISPATCH_THRESHOLD_BYTES);

          // Act
          await sut.deflate(data);

          // Assert
          expect(deflateSyncSpy).toHaveBeenCalledTimes(1);
          expect(deflateCallbackSpy).not.toHaveBeenCalled();
        });
      });

      describe('When deflate runs on a payload above the threshold', () => {
        it('Then the callback path is used, not the synchronous path', async () => {
          // Arrange
          const sut = new NodeCompressor();
          const data = new Uint8Array(CALLBACK_DISPATCH_THRESHOLD_BYTES + 1);

          // Act
          await sut.deflate(data);

          // Assert
          expect(deflateCallbackSpy).toHaveBeenCalledTimes(1);
          expect(deflateSyncSpy).not.toHaveBeenCalled();
        });
      });

      describe('When deflate runs on a payload above the threshold with an explicit level', () => {
        it('Then the callback path receives the level option', async () => {
          // Arrange
          const sut = new NodeCompressor();
          const data = new Uint8Array(CALLBACK_DISPATCH_THRESHOLD_BYTES + 1);

          // Act
          await sut.deflate(data, 1);

          // Assert
          expect(deflateCallbackSpy).toHaveBeenCalledTimes(1);
          expect(deflateCallbackSpy.mock.calls[0]?.[1]).toEqual({ level: 1 });
          expect(deflateSyncSpy).not.toHaveBeenCalled();
        });
      });

      describe('When deflateRaw runs on a payload below the threshold', () => {
        it('Then the synchronous path is used', async () => {
          // Arrange
          const sut = new NodeCompressor();
          const data = new Uint8Array(CALLBACK_DISPATCH_THRESHOLD_BYTES - 1);

          // Act
          await sut.deflateRaw(data);

          // Assert
          expect(deflateRawSyncSpy).toHaveBeenCalledTimes(1);
          expect(deflateRawCallbackSpy).not.toHaveBeenCalled();
        });
      });

      describe('When deflateRaw runs on a payload above the threshold', () => {
        it('Then the callback path is used', async () => {
          // Arrange
          const sut = new NodeCompressor();
          const data = new Uint8Array(CALLBACK_DISPATCH_THRESHOLD_BYTES + 1);

          // Act
          await sut.deflateRaw(data);

          // Assert
          expect(deflateRawCallbackSpy).toHaveBeenCalledTimes(1);
          expect(deflateRawSyncSpy).not.toHaveBeenCalled();
        });
      });

      describe('When deflateRaw runs on a payload above the threshold with an explicit level', () => {
        it('Then the callback path receives the level option', async () => {
          // Arrange
          const sut = new NodeCompressor();
          const data = new Uint8Array(CALLBACK_DISPATCH_THRESHOLD_BYTES + 1);

          // Act
          await sut.deflateRaw(data, 1);

          // Assert
          expect(deflateRawCallbackSpy).toHaveBeenCalledTimes(1);
          expect(deflateRawCallbackSpy.mock.calls[0]?.[1]).toEqual({ level: 1 });
          expect(deflateRawSyncSpy).not.toHaveBeenCalled();
        });
      });

      describe('When inflate runs on a payload below the threshold', () => {
        it('Then the synchronous path is used', async () => {
          // Arrange — garbage bytes are fine: dispatch is decided before the
          // zlib stream is ever parsed, so a rejection does not confound the spy.
          const sut = new NodeCompressor();
          const data = new Uint8Array(CALLBACK_DISPATCH_THRESHOLD_BYTES - 1);

          // Act
          await sut.inflate(data).catch(() => undefined);

          // Assert
          expect(inflateSyncSpy).toHaveBeenCalledTimes(1);
          expect(inflateCallbackSpy).not.toHaveBeenCalled();
        });
      });

      describe('When inflate runs on a payload exactly at the threshold', () => {
        it('Then the synchronous path is used (the boundary is strictly greater-than)', async () => {
          // Arrange
          const sut = new NodeCompressor();
          const data = new Uint8Array(CALLBACK_DISPATCH_THRESHOLD_BYTES);

          // Act
          await sut.inflate(data).catch(() => undefined);

          // Assert
          expect(inflateSyncSpy).toHaveBeenCalledTimes(1);
          expect(inflateCallbackSpy).not.toHaveBeenCalled();
        });
      });

      describe('When inflate runs on a payload above the threshold', () => {
        it('Then the callback path is used, not the synchronous path', async () => {
          // Arrange
          const sut = new NodeCompressor();
          const data = new Uint8Array(CALLBACK_DISPATCH_THRESHOLD_BYTES + 1);

          // Act
          await sut.inflate(data).catch(() => undefined);

          // Assert
          expect(inflateCallbackSpy).toHaveBeenCalledTimes(1);
          expect(inflateSyncSpy).not.toHaveBeenCalled();
        });
      });
    });

    describe('Given a payload above the threshold that inflates past the instance cap', () => {
      describe('When inflate runs', () => {
        it('Then it refuses with DECOMPRESS_FAILED — the cap holds exactly as it does on the synchronous path', async () => {
          // Arrange — poorly compressible so the compressed buffer itself
          // (the argument `inflate` gates on) lands above the dispatch threshold.
          const sut = new NodeCompressor({ maxInflatedBytes: 4 });
          const payload = new Uint8Array(randomBytes(32 * 1024));
          const deflated = await sut.deflate(payload);
          deflateCallbackSpy.mockClear();

          // Act
          let caught: unknown;
          try {
            await sut.inflate(deflated);
          } catch (err) {
            caught = err;
          }

          // Assert — the callback path was genuinely the one exercised
          expect(inflateCallbackSpy).toHaveBeenCalledTimes(1);
          expect(caught).toBeInstanceOf(TsgitError);
          expect((caught as TsgitError).data.code).toBe('DECOMPRESS_FAILED');
        });
      });
    });

    describe('Given the callback path rejects on input the zlib binding cannot accept', () => {
      describe('When deflate runs on a payload above the threshold', () => {
        it('Then the error surfaces as COMPRESS_FAILED — the same shape as the synchronous path', async () => {
          // Arrange — a `.length` above the threshold routes to the callback
          // path, but the value is not real deflatable data.
          const sut = new NodeCompressor();
          const bogus = { length: CALLBACK_DISPATCH_THRESHOLD_BYTES + 1 } as unknown as Uint8Array;

          // Act
          let caught: unknown;
          try {
            await sut.deflate(bogus);
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(deflateCallbackSpy).toHaveBeenCalledTimes(1);
          expect(caught).toBeInstanceOf(TsgitError);
          expect((caught as TsgitError).data.code).toBe('COMPRESS_FAILED');
        });
      });

      describe('When inflate runs on a payload above the threshold', () => {
        it('Then the error surfaces as DECOMPRESS_FAILED — the same shape as the synchronous path', async () => {
          // Arrange
          const sut = new NodeCompressor();
          const bogus = { length: CALLBACK_DISPATCH_THRESHOLD_BYTES + 1 } as unknown as Uint8Array;

          // Act
          let caught: unknown;
          try {
            await sut.inflate(bogus);
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(inflateCallbackSpy).toHaveBeenCalledTimes(1);
          expect(caught).toBeInstanceOf(TsgitError);
          expect((caught as TsgitError).data.code).toBe('DECOMPRESS_FAILED');
        });
      });
    });
  });
});
