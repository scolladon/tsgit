/// <reference lib="dom" />
import { compressFailed, decompressFailed } from '../../domain/index.js';
import type { Compressor, InflateStreamResult } from '../../ports/compressor.js';
import { adler32 } from '../adler32.js';

/**
 * Safety cap on input size for the progressive-prefix streamInflate scan.
 * O(n²) behavior makes this adapter unsuitable for production-sized packs;
 * fail loudly so a misuse with a real pack file does not stall the browser.
 */
const BROWSER_STREAM_INFLATE_MAX_INPUT = 64 * 1024;

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

  async inflate(data: Uint8Array): Promise<Uint8Array> {
    try {
      const stream = new Blob([data as BlobPart])
        .stream()
        .pipeThrough(new DecompressionStream('deflate'));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    } catch (err) {
      throw decompressFailed(err instanceof Error ? err.message : String(err));
    }
  }

  async streamInflate(bytes: Uint8Array, offset: number): Promise<InflateStreamResult> {
    // Same progressive-prefix approach as the Memory adapter; Web Streams
    // DecompressionStream doesn't expose consumed-bytes metadata.
    const slice = bytes.subarray(offset);
    if (slice.length > BROWSER_STREAM_INFLATE_MAX_INPUT) {
      throw decompressFailed(
        `BrowserCompressor.streamInflate input exceeds ${BROWSER_STREAM_INFLATE_MAX_INPUT} byte safety cap`,
      );
    }
    for (let end = 1; end <= slice.length; end += 1) {
      const attempt = slice.subarray(0, end);
      try {
        const stream = new Blob([attempt as BlobPart])
          .stream()
          .pipeThrough(new DecompressionStream('deflate'));
        const output = new Uint8Array(await new Response(stream).arrayBuffer());
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
        // Not yet complete — grow.
      }
    }
    throw decompressFailed('no valid zlib stream at offset');
  }

  createInflateStream(): TransformStream<Uint8Array, Uint8Array> {
    return new DecompressionStream('deflate') as unknown as TransformStream<Uint8Array, Uint8Array>;
  }
}
