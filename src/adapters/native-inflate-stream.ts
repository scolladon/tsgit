/// <reference lib="dom" />
import { decompressFailed } from '../domain/error.js';

/**
 * A native `DecompressionStream` whose read side reports a bad zlib stream as
 * the library's `DECOMPRESS_FAILED` — the web platform surfaces it as a raw
 * `TypeError`, which would otherwise escape through every streamed read.
 */
export function createNativeInflateStream(): TransformStream<Uint8Array, Uint8Array> {
  const native = new DecompressionStream('deflate');
  const reader = native.readable.getReader();
  const readable = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) controller.close();
        else controller.enqueue(value as Uint8Array);
      } catch (error) {
        controller.error(decompressFailed(error instanceof Error ? error.message : String(error)));
      }
    },
    cancel: (reason) => reader.cancel(reason),
  });
  return { readable, writable: native.writable as WritableStream<Uint8Array> };
}
