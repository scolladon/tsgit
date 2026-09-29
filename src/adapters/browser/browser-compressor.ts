/// <reference lib="dom" />
import { compressFailed, decompressFailed } from '../../domain/index.js';
import type { Compressor, InflateStreamResult } from '../../ports/compressor.js';
import { boundedInflateCap, inflateZlibHead, inflateZlibMember } from '../inflate.js';

export class BrowserCompressor implements Compressor {
  async deflate(data: Uint8Array, _level?: number): Promise<Uint8Array> {
    // Web CompressionStream exposes no level param; loose disk bytes are
    // outside the faithfulness contract (equivalence-under-readback), so the
    // level is accepted to satisfy the port and silently ignored.
    try {
      const stream = new Blob([data as BlobPart])
        .stream()
        .pipeThrough(new CompressionStream('deflate'));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    } catch (err) {
      throw compressFailed(err instanceof Error ? err.message : String(err));
    }
  }

  async deflateRaw(data: Uint8Array, _level?: number): Promise<Uint8Array> {
    // Web CompressionStream exposes no level param; loose disk bytes are
    // outside the faithfulness contract (equivalence-under-readback), so the
    // level is accepted to satisfy the port and silently ignored.
    try {
      // equivalent-mutant: NoCoverage — CompressionStream unavailable in Node unit runner;
      // deflateRaw correctness is covered by the browser e2e suite.
      const stream = new Blob([data as BlobPart])
        .stream()
        .pipeThrough(new CompressionStream('deflate-raw'));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    } catch (err) {
      throw compressFailed(err instanceof Error ? err.message : String(err));
    }
  }

  // With no cap, the native DecompressionStream stays the decoder (today's
  // path). A given cap routes to the zero-dependency decoder instead: it
  // already aborts incrementally during decode (see streamInflate below),
  // where the native stream has no equivalent mid-decode abort.
  async inflate(data: Uint8Array, maxOutputBytes?: number): Promise<Uint8Array> {
    if (maxOutputBytes !== undefined) {
      return inflateZlibMember(data, 0, boundedInflateCap(maxOutputBytes)).output;
    }
    try {
      // pipeTo instead of pipeThrough so the writable-side promise is in scope
      // and can receive a no-op rejection handler. On workerd, closing a
      // DecompressionStream with incomplete data rejects the writable side as
      // an uncaught rejection that crashes the worker.
      const ds = new DecompressionStream('deflate');
      const pumped = new Blob([data as BlobPart])
        .stream()
        .pipeTo(ds.writable)
        .catch(() => {});
      const output = new Uint8Array(await new Response(ds.readable).arrayBuffer());
      await pumped;
      return output;
    } catch (err) {
      throw decompressFailed(err instanceof Error ? err.message : String(err));
    }
  }

  // The zero-dependency decoder is synchronous and whole-member, and already
  // maps every failure to `decompressFailed` — the rejected promise here
  // carries that typed error as-is, no re-wrap needed.
  async streamInflate(
    bytes: Uint8Array,
    offset: number,
    maxOutputBytes?: number,
  ): Promise<InflateStreamResult> {
    return inflateZlibMember(bytes, offset, boundedInflateCap(maxOutputBytes));
  }

  // Same no-re-wrap rationale as streamInflate above: inflateZlibHead already
  // maps every failure to `decompressFailed`.
  async inflateHead(data: Uint8Array, maxOutputBytes: number): Promise<Uint8Array> {
    return inflateZlibHead(data, 0, maxOutputBytes);
  }

  createInflateStream(): TransformStream<Uint8Array, Uint8Array> {
    return new DecompressionStream('deflate') as unknown as TransformStream<Uint8Array, Uint8Array>;
  }
}
