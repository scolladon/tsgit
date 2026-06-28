import { compressFailed, decompressFailed } from '../../domain/index.js';
import type { Compressor, InflateStreamResult } from '../../ports/compressor.js';
import { adler32 } from '../adler32.js';

/**
 * Safety cap on input size for the progressive-prefix streamInflate scan.
 * O(n²) behavior makes inputs above a few KB impractical — guard loudly so a
 * test accidentally using this adapter for a real packfile fails fast.
 */
const MEMORY_STREAM_INFLATE_MAX_INPUT = 64 * 1024;

export class MemoryCompressor implements Compressor {
  constructor() {
    if (typeof CompressionStream === 'undefined' || typeof DecompressionStream === 'undefined') {
      throw compressFailed('CompressionStream/DecompressionStream unavailable');
    }
  }

  deflate = async (data: Uint8Array, _level?: number): Promise<Uint8Array> => {
    // Web CompressionStream exposes no level param; loose disk bytes are
    // outside the faithfulness contract (equivalence-under-readback), so the
    // level is accepted to satisfy the port and silently ignored.
    try {
      return await runTransform(data, new CompressionStream('deflate'));
    } catch (err) {
      throw compressFailed(describeError(err));
    }
  };

  deflateRaw = async (data: Uint8Array, _level?: number): Promise<Uint8Array> => {
    // Web CompressionStream exposes no level param; loose disk bytes are
    // outside the faithfulness contract (equivalence-under-readback), so the
    // level is accepted to satisfy the port and silently ignored.
    try {
      return await runTransform(data, new CompressionStream('deflate-raw'));
    } catch (err) {
      throw compressFailed(describeError(err));
    }
  };

  inflate = async (data: Uint8Array): Promise<Uint8Array> => {
    try {
      return await runTransform(data, new DecompressionStream('deflate'));
    } catch (err) {
      throw decompressFailed(describeError(err));
    }
  };

  streamInflate = async (bytes: Uint8Array, offset: number): Promise<InflateStreamResult> => {
    // DecompressionStream in Web Streams doesn't expose "bytes consumed" when
    // the stream ends mid-input. Feed progressively-larger prefixes until one
    // decompresses cleanly — that's the zlib terminator. O(n²) in the
    // compressed length, so this adapter is explicitly bounded to small
    // test-sized packs. Use NodeCompressor for production workloads.
    const slice = bytes.subarray(offset);
    if (slice.length > MEMORY_STREAM_INFLATE_MAX_INPUT) {
      throw decompressFailed(
        `MemoryCompressor.streamInflate input exceeds ${MEMORY_STREAM_INFLATE_MAX_INPUT} byte safety cap; use NodeCompressor for real pack files`,
      );
    }
    for (let end = 1; end <= slice.length; end += 1) {
      const attempt = slice.subarray(0, end);
      try {
        const output = await runTransform(attempt, new DecompressionStream('deflate'));
        // A zlib stream ends with a 4-byte big-endian adler32 of the
        // uncompressed data (RFC 1950). Some runtimes (Deno, Workers) accept a
        // truncated prefix before those 4 bytes; guard against that by only
        // accepting `end` when the trailing 4 bytes match adler32(output).
        if (
          end >= 4 &&
          new DataView(slice.buffer, slice.byteOffset + end - 4, 4).getUint32(0) === adler32(output)
        ) {
          return { output, bytesConsumed: end };
        }
      } catch {
        // Not yet a complete zlib stream — keep growing.
      }
    }
    throw decompressFailed('no valid zlib stream at offset');
  };

  createInflateStream = (): TransformStream<Uint8Array, Uint8Array> => {
    return new DecompressionStream('deflate') as unknown as TransformStream<Uint8Array, Uint8Array>;
  };
}

async function runTransform(
  data: Uint8Array,
  transform: TransformStream<Uint8Array, Uint8Array> | CompressionStream | DecompressionStream,
): Promise<Uint8Array> {
  const ts = transform as unknown as TransformStream<Uint8Array, Uint8Array>;
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(data);
      controller.close();
    },
  });
  // pipeTo instead of pipeThrough so we hold the writable-side promise and can
  // attach a no-op rejection handler. pipeThrough keeps that promise internal —
  // on workerd, closing a DecompressionStream with incomplete data rejects the
  // writable side, which lands as an uncaught rejection that crashes the worker.
  const pumped = source.pipeTo(ts.writable).catch(() => {});
  const reader = ts.readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  await pumped;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
