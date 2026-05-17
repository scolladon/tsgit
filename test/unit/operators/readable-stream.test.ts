/**
 * Unit tests for `readableStreamToAsyncIterable`.
 *
 * The helper bridges a Web `ReadableStream<Uint8Array>` (what fetch returns
 * for `Response.body`) to an `AsyncIterable<Uint8Array>` that the pkt-line
 * decoder consumes. Tests cover:
 *  - chunked stream → iterator yields each chunk
 *  - closed stream → iterator ends cleanly
 *  - early break → `return()` cancels the stream
 *  - stream that throws on `cancel()` → the `catch{}` swallow path
 */
import { describe, expect, it } from 'vitest';

import { readableStreamToAsyncIterable } from '../../../src/operators/readable-stream.js';

const ENCODER = new TextEncoder();

const collect = async (source: AsyncIterable<Uint8Array>): Promise<Uint8Array[]> => {
  const out: Uint8Array[] = [];
  for await (const chunk of source) out.push(chunk);
  return out;
};

describe('readableStreamToAsyncIterable', () => {
  it('Given a stream yielding two chunks, When iterated, Then both chunks surface in order', async () => {
    // Arrange
    const a = ENCODER.encode('hello ');
    const b = ENCODER.encode('world');
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(a);
        controller.enqueue(b);
        controller.close();
      },
    });

    // Act
    const sut = await collect(readableStreamToAsyncIterable(stream));

    // Assert
    expect(sut).toHaveLength(2);
    expect(sut[0]).toEqual(a);
    expect(sut[1]).toEqual(b);
  });

  it('Given an immediately-closed stream, When iterated, Then yields zero chunks and ends cleanly', async () => {
    // Arrange
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      },
    });

    // Act
    const sut = await collect(readableStreamToAsyncIterable(stream));

    // Assert — the `done: true` branch of the ternary fires here.
    expect(sut).toEqual([]);
  });

  it('Given an early break, When consumer exits, Then the iterator return cancels the underlying stream', async () => {
    // Arrange
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(ENCODER.encode('a'));
        controller.enqueue(ENCODER.encode('b'));
        controller.enqueue(ENCODER.encode('c'));
        controller.close();
      },
      cancel() {
        cancelled = true;
      },
    });

    // Act — consume only the first chunk, then break.
    for await (const _chunk of readableStreamToAsyncIterable(stream)) {
      break;
    }

    // Assert
    expect(cancelled).toBe(true);
  });

  it('Given a stream whose cancel() throws, When the iterator return runs, Then the error is swallowed and the iterator still ends', async () => {
    // Arrange — drive the `catch {}` swallow branch in the `return` hook.
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(ENCODER.encode('a'));
      },
      cancel() {
        throw new Error('cancel boom');
      },
    });

    // Act — break early so `return` fires; the throwing cancel must not
    // surface to the consumer.
    let threw: unknown;
    try {
      for await (const _chunk of readableStreamToAsyncIterable(stream)) {
        break;
      }
    } catch (err) {
      threw = err;
    }

    // Assert
    expect(threw).toBeUndefined();
  });
});
