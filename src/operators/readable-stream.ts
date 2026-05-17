/**
 * Adapt a Web `ReadableStream<Uint8Array>` (the type `fetch` returns on
 * `Response.body`) to an `AsyncIterable<Uint8Array>` that the pkt-line
 * decoder and other AsyncIterable consumers can drive.
 *
 * Why this lives in `src/operators/`: both the `fetch-pack` primitive and
 * the `commands/internal/upload-pack-client` helper need it, and a primitive
 * cannot import from `commands/`. The operators module is the natural home —
 * it owns AsyncIterable composition helpers with zero domain dependencies.
 *
 * Lifecycle: on early exit (consumer throws or breaks) the iterator's
 * `return` hook calls `cancel()` so the stream + underlying socket close
 * cleanly. `releaseLock` alone leaves the stream open.
 */
export const readableStreamToAsyncIterable = (
  stream: ReadableStream<Uint8Array>,
): AsyncIterable<Uint8Array> => ({
  [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    const reader = stream.getReader();
    return {
      next: async (): Promise<IteratorResult<Uint8Array>> => {
        const { done, value } = await reader.read();
        return done ? { done: true, value: undefined } : { done: false, value };
      },
      return: async (): Promise<IteratorResult<Uint8Array>> => {
        try {
          await reader.cancel();
        } catch {
          // swallow — adapter closes the underlying socket regardless
        }
        return { done: true, value: undefined };
      },
    };
  },
});
