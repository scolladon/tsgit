import { describe, expect, it, vi } from 'vitest';
import { MemoryCompressor } from '../../../src/adapters/memory/memory-compressor.js';
import { createNativeInflateStream } from '../../../src/adapters/native-inflate-stream.js';
import type { TsgitError } from '../../../src/domain/error.js';

const sourceOf = (...chunks: Uint8Array[]): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });

const drain = async (stream: ReadableStream<Uint8Array>): Promise<Uint8Array> => {
  const parts: number[] = [];
  for await (const chunk of stream) parts.push(...chunk);
  return Uint8Array.from(parts);
};

const deflated = (bytes: Uint8Array): Promise<Uint8Array> => new MemoryCompressor().deflate(bytes);

const rejection = async (attempt: Promise<unknown>): Promise<unknown> => {
  try {
    await attempt;
  } catch (error) {
    return error;
  }
  return undefined;
};

describe('createNativeInflateStream', () => {
  describe('Given a valid zlib stream', () => {
    describe('When it is piped through the stream', () => {
      it('Then the inflated bytes come out', async () => {
        // Arrange
        const payload = new TextEncoder().encode('inflate me');
        const sut = createNativeInflateStream;

        // Act
        const result = await drain(sourceOf(await deflated(payload)).pipeThrough(sut()));

        // Assert
        expect(result).toEqual(payload);
      });
    });
  });

  describe('Given bytes that are not a zlib stream', () => {
    describe('When the output is read', () => {
      it('Then it rejects with the decompress failure the buffered inflate reports', async () => {
        // Arrange
        const sut = createNativeInflateStream;
        const garbage = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]);

        // Act
        const failure = await rejection(drain(sourceOf(garbage).pipeThrough(sut())));

        // Assert
        const buffered = await rejection(new MemoryCompressor().inflate(garbage));
        expect((failure as TsgitError).data).toEqual((buffered as TsgitError).data);
        expect((failure as TsgitError).data.code).toBe('DECOMPRESS_FAILED');
      });
    });
  });

  describe('Given a consumer that stops reading early', () => {
    describe('When the reader is cancelled', () => {
      it('Then the cancellation resolves', async () => {
        // Arrange
        const sut = createNativeInflateStream;
        const payload = new Uint8Array(100_000).fill(7);
        const reader = sourceOf(await deflated(payload))
          .pipeThrough(sut())
          .getReader();
        await reader.read();

        // Act
        const result = reader.cancel('done');

        // Assert
        await expect(result).resolves.toBeUndefined();
      });
    });
  });

  describe('Given a consumer that stops reading early with a reason', () => {
    describe('When the reader is cancelled', () => {
      it('Then the source feeding the stream is cancelled with that reason', async () => {
        // Arrange
        const sut = createNativeInflateStream;
        const cancelled: unknown[] = [];
        const source = new ReadableStream<Uint8Array>({
          cancel: (reason) => {
            cancelled.push(reason);
          },
        });
        const reader = source.pipeThrough(sut()).getReader();

        // Act
        await reader.cancel('done');

        // Assert
        await vi.waitFor(() => expect(cancelled).toEqual(['done']));
      });
    });
  });
});
