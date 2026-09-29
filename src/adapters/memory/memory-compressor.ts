import { compressFailed, decompressFailed } from '../../domain/index.js';
import type { Compressor, InflateStreamResult } from '../../ports/compressor.js';
import { boundedInflateCap, inflateZlibHead, inflateZlibMember } from '../inflate.js';

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

  // With no cap, the native DecompressionStream stays the decoder (today's
  // path). A given cap routes to the zero-dependency decoder instead: it
  // already aborts incrementally during decode (see streamInflate below),
  // where the native stream has no equivalent mid-decode abort.
  inflate = async (data: Uint8Array, maxOutputBytes?: number): Promise<Uint8Array> => {
    if (maxOutputBytes !== undefined) {
      return inflateZlibMember(data, 0, boundedInflateCap(maxOutputBytes)).output;
    }
    try {
      return await runTransform(data, new DecompressionStream('deflate'));
    } catch (err) {
      throw decompressFailed(describeError(err));
    }
  };

  // The zero-dependency decoder is synchronous and whole-member, and already
  // maps every failure to `decompressFailed` — the rejected promise here
  // carries that typed error as-is, no re-wrap needed.
  streamInflate = async (
    bytes: Uint8Array,
    offset: number,
    maxOutputBytes?: number,
  ): Promise<InflateStreamResult> =>
    inflateZlibMember(bytes, offset, boundedInflateCap(maxOutputBytes));

  // Same no-re-wrap rationale as streamInflate above: inflateZlibHead already
  // maps every failure to `decompressFailed`.
  inflateHead = async (data: Uint8Array, maxOutputBytes: number): Promise<Uint8Array> =>
    inflateZlibHead(data, 0, maxOutputBytes);

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
